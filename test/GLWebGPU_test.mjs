/**
 * test/GLWebGPU_test.mjs -- headless, mock-proven coverage for the WebGPU backend
 * (GLWebGPU.js). There is no GPU in a node:test sandbox, so every sink is driven
 * against the injected mock GPUDevice from ./mockWebGPU.mjs (the ONE mock, shared with
 * torture + the frame-alloc gate). Real-GPU rendering is GL8c (Playwright), out of scope.
 *
 * mockWebGPU is re-exported here so the plan's "import from GLWebGPU_test.mjs" contract
 * holds; the implementation lives in ./mockWebGPU.mjs so importing the mock into torture
 * or a gate never schedules this file's tests.
 *
 * Covers: fail-closed acquisition (B5), device loss + restore, the deferred-pick state
 * machine (PENDING -> resolved -> id / -1) with K=2 back-pressure, PICK_MAX_ID RangeError,
 * counters conformance (both attach paths + detach + malformed), caps shape/freeze, the
 * capacity guard, and the GL.js core seam bound to a WebGPU sink.
 *
 * MIT (c) 2026 Zahary Shinikchiev
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createScope, effect as sEffect, onCleanup as sOnCleanup, dispose as sDispose } from "@zakkster/lite-signal";
import {
  createGPUTarget,
  createGPUPointSink,
  createGPUPointHiSink,
  createGPUQuadSink,
  createGPULineSink,
  PICK_MAX_ID,
  PICK_PENDING,
  PICK_RING_K,
} from "../GLWebGPU.js";
import { createField, createDriver, LAYOUT, writePointHi } from "../GL.js";
import { mockWebGPU, encodeId, WEBGPU_FRAME_BASELINE } from "./mockWebGPU.mjs";

// Re-export the single-source-of-truth mock (plan contract).
export { mockWebGPU, encodeId, WEBGPU_FRAME_BASELINE };

const tick = () => new Promise((r) => setTimeout(r, 0));

async function makeTarget(opts) {
  const m = mockWebGPU(opts);
  const target = await createGPUTarget(m.canvas, { device: m.device });
  return { target, ...m };
}

// ===========================================================================
// Fail-closed acquisition (B5) -- never a null/degraded sink.
// ===========================================================================

test("B5: createGPUTarget with no device and no navigator.gpu REJECTS (fail closed)", async () => {
  // node's global `navigator` exists (Node >=21) but has no .gpu; the un-injected path
  // must reject, not resolve a null sink. Covers the `!navigator.gpu` half of the OR.
  const canvas = { getContext: () => ({ configure() {}, getCurrentTexture() { return {}; } }) };
  await assert.rejects(
    () => createGPUTarget(canvas, {}),
    /navigator\.gpu is unavailable|requestAdapter/,
    "an absent navigator.gpu must throw, never return a degraded sink"
  );
});

test("B5: createGPUTarget REJECTS when navigator itself is undefined (the other half of the OR)", async () => {
  // Node >=21 defines a global `navigator`; delete it for the duration of this test to
  // independently exercise `typeof navigator === "undefined"`, distinct from the
  // navigator-present-but-no-.gpu branch covered above. Restored in `finally` so no
  // other test observes the deletion.
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const hadNavigator = typeof navigator !== "undefined";
  try {
    delete globalThis.navigator;
    assert.equal(typeof navigator, "undefined", "sanity: navigator is genuinely gone");
    const canvas = { getContext: () => ({ configure() {}, getCurrentTexture() { return {}; } }) };
    await assert.rejects(
      () => createGPUTarget(canvas, {}),
      /navigator\.gpu is unavailable/,
      "a wholly-undefined navigator must throw, never return a degraded sink"
    );
  } finally {
    if (desc) Object.defineProperty(globalThis, "navigator", desc);
    assert.equal(typeof navigator !== "undefined", hadNavigator, "navigator restored for later tests");
  }
});

test("B5: createGPUTarget REJECTS when navigator.gpu.requestAdapter() resolves null (no GPU adapter)", async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: { requestAdapter: async () => null, getPreferredCanvasFormat: () => "bgra8unorm" } },
      configurable: true, writable: true, enumerable: true,
    });
    const canvas = { getContext: () => ({ configure() {}, getCurrentTexture() { return {}; } }) };
    await assert.rejects(
      () => createGPUTarget(canvas, {}),
      /requestAdapter\(\) returned null/,
      "a null adapter must throw, never return a degraded sink"
    );
  } finally {
    if (desc) Object.defineProperty(globalThis, "navigator", desc); else delete globalThis.navigator;
  }
});

test("B5: createGPUTarget REJECTS when adapter.requestDevice() rejects", async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        gpu: {
          requestAdapter: async () => ({ requestDevice: async () => { throw new Error("mock: device request denied"); } }),
          getPreferredCanvasFormat: () => "bgra8unorm",
        },
      },
      configurable: true, writable: true, enumerable: true,
    });
    const canvas = { getContext: () => ({ configure() {}, getCurrentTexture() { return {}; } }) };
    await assert.rejects(
      () => createGPUTarget(canvas, {}),
      /mock: device request denied/,
      "a rejected requestDevice() must propagate, never be swallowed into a degraded sink"
    );
  } finally {
    if (desc) Object.defineProperty(globalThis, "navigator", desc); else delete globalThis.navigator;
  }
});

test("B5: createGPUTarget rejects when getContext('webgpu') returns null", async () => {
  const { device } = mockWebGPU();
  const canvas = { getContext: () => null };
  await assert.rejects(
    () => createGPUTarget(canvas, { device }),
    /getContext\('webgpu'\) returned null/,
    "a canvas that cannot yield a webgpu context must throw"
  );
});

test("B5: an injected device configures the context and builds a live sink", async () => {
  const { target, device } = await makeTarget();
  const sink = createGPUPointSink(target, { capacity: 256 });
  assert.equal(typeof sink.draw, "function");
  assert.equal(typeof sink.upload, "function");
  assert.equal(sink.target, target);
  sink.dispose();
});

// ===========================================================================
// Caps shape / freeze (parity with the WebGL2 caps seam).
// ===========================================================================

const CAPS_KEYS = ["api", "instancing", "baseVertex", "maxInstances", "precisionHi", "pickMode", "version"];

test("caps: every WebGPU sink advertises a frozen descriptor with the shared key set/order", async () => {
  const factories = [
    ["createGPUPointSink", createGPUPointSink, false],
    ["createGPUQuadSink", createGPUQuadSink, false],
    ["createGPULineSink", createGPULineSink, false],
    ["createGPUPointHiSink", createGPUPointHiSink, true],
  ];
  for (const [name, factory, expectHi] of factories) {
    const { target } = await makeTarget();
    const sink = factory(target, { capacity: 16 });
    assert.ok(Object.isFrozen(sink.caps), name + " caps must be frozen");
    assert.deepEqual(Object.keys(sink.caps), CAPS_KEYS, name + " caps key set/order matches the seam");
    assert.equal(sink.caps.api, "webgpu");
    assert.equal(sink.caps.pickMode, "deferred", name + " advertises deferred pick");
    assert.equal(sink.caps.baseVertex, true);
    assert.equal(sink.caps.maxInstances, PICK_MAX_ID + 1, name + " maxInstances is PICK_MAX_ID+1");
    assert.equal(sink.caps.precisionHi, expectHi, name + " precisionHi is exactly " + expectHi);
    sink.dispose();
  }
});

test("caps: precisionHi is true on EXACTLY createGPUPointHiSink", async () => {
  const trueOn = [];
  for (const [name, factory] of [
    ["point", createGPUPointSink], ["quad", createGPUQuadSink],
    ["line", createGPULineSink], ["pointHi", createGPUPointHiSink],
  ]) {
    const { target } = await makeTarget();
    const sink = factory(target, { capacity: 16 });
    if (sink.caps.precisionHi === true) trueOn.push(name);
    sink.dispose();
  }
  assert.deepEqual(trueOn, ["pointHi"], "only the hi sink advertises precisionHi:true");
});

// ===========================================================================
// Upload capacity guard (fail closed, same shape as the WebGL2 sink).
// ===========================================================================

test("upload beyond capacity throws a RangeError naming the factory", async () => {
  const { target } = await makeTarget();
  const sink = createGPUPointSink(target, { capacity: 100 });
  const data = new Float32Array(100 * 8);
  assert.throws(
    () => sink.upload(data, 100 * 8 - 4, 8),   // floatOffset+floatCount past capacity*stride
    /exceeds sink capacity/,
    "an over-capacity upload must throw, not silently desync the buffer"
  );
  sink.dispose();
});

// ===========================================================================
// Draw wires the device boundary; a normal frame accounts the baseline exactly.
// ===========================================================================

test("draw issues one command encoder + render pass + submit per non-empty frame", async () => {
  const { target, device, rec } = await makeTarget({ faithful: true });
  const sink = createGPUPointSink(target, { capacity: 4096 });
  const f = createField({ capacity: 4096, stride: LAYOUT.POINT });
  f.setCount(2000);
  const write = (d, b) => { d[b] = 10; d[b + 1] = 20; d[b + 2] = 3; d[b + 3] = 1; d[b + 4] = 1; d[b + 5] = 1; d[b + 6] = 1; d[b + 7] = 0; };
  for (let i = 0; i < 2000; i++) f.set(i, write);
  f.flush(sink);
  const enc0 = rec.encoderCount, sub0 = rec.submitCount;

  device.__resetAlloc();
  f.set(3, write);
  f.flush(sink);
  assert.equal(rec.encoderCount, enc0 + 1, "one encoder per frame");
  assert.equal(rec.submitCount, sub0 + 1, "one submit per frame");
  assert.equal(device.__alloc, WEBGPU_FRAME_BASELINE, "a dirty frame accounts exactly the baseline");

  // draw(0) is a no-op (no submit).
  const sub1 = rec.submitCount;
  sink.draw(0);
  assert.equal(rec.submitCount, sub1, "draw(0) submits nothing");
  sink.dispose();
});

// ===========================================================================
// Device loss + restore (mirrors GLBackend.js semantics through the target).
// ===========================================================================

test("device loss stops draws; restore rebuilds and fires onContextRestored", async () => {
  const { target, device, rec } = await makeTarget();
  const sink = createGPUPointSink(target, { capacity: 64 });
  const f = createField({ capacity: 64, stride: LAYOUT.POINT });
  f.setCount(16);
  const write = (d, b) => { d[b] = 1; };
  f.touchAll(); f.flush(sink);
  assert.equal(sink.isContextLost(), false);

  let restored = 0;
  sink.onContextRestored(() => { restored++; });

  device.__loseContext();
  await tick();
  assert.equal(sink.isContextLost(), true, "device.lost resolution flips the flag");

  const sub0 = rec.submitCount;
  f.set(0, write); f.flush(sink);
  assert.equal(rec.submitCount, sub0, "a lost device draws nothing");

  const fresh = mockWebGPU().device;
  await target.restore(fresh);
  assert.equal(sink.isContextLost(), false, "restore clears the lost flag");
  assert.equal(restored, 1, "restore fires the app re-seed callback exactly once");

  // draws work again on the fresh device.
  const sub1 = rec.submitCount;   // rec is the OLD device's recorder; the fresh device has its own
  f.touchAll(); f.flush(sink);
  assert.equal(rec.submitCount, sub1, "the OLD device sees no further submits after restore");
  sink.dispose();
});

// ===========================================================================
// Deferred pick state machine (Fork A): PENDING -> resolved -> id / -1, K=2.
// ===========================================================================

test("pick returns PICK_PENDING first, then the resolved id on a later identical call", async () => {
  const { target, device } = await makeTarget();
  const sink = createGPUPointSink(target, { capacity: 4096 });
  const f = createField({ capacity: 4096, stride: LAYOUT.POINT });
  f.setCount(2000);
  f.touchAll(); f.flush(sink);

  device.__pickPixel = encodeId(42);
  const first = sink.pick(10, 10, 2000);
  assert.equal(first, PICK_PENDING, "the first pick enqueues and returns PENDING (-2)");
  await tick();
  const second = sink.pick(10, 10, 2000);
  assert.equal(second, 42, "a later identical pick returns the resolved instance index");
  sink.dispose();
});

test("pick resolves a background hit (white sentinel) to -1, not PENDING", async () => {
  const { target, device } = await makeTarget();
  const sink = createGPUPointSink(target, { capacity: 4096 });
  const f = createField({ capacity: 4096, stride: LAYOUT.POINT });
  f.setCount(2000);
  f.touchAll(); f.flush(sink);

  device.__pickPixel = encodeId(-1);   // white = miss
  assert.equal(sink.pick(30, 30, 2000), PICK_PENDING);
  await tick();
  assert.equal(sink.pick(30, 30, 2000), -1, "a resolved miss decodes to -1");
  sink.dispose();
});

test("pick applies K=2 back-pressure: a third in-flight request returns PENDING without enqueuing", async () => {
  const { target, device, rec } = await makeTarget();
  const sink = createGPUPointSink(target, { capacity: 4096 });
  const f = createField({ capacity: 4096, stride: LAYOUT.POINT });
  f.setCount(2000);
  f.touchAll(); f.flush(sink);

  assert.equal(PICK_RING_K, 2);
  const c0 = rec.copyCount;
  assert.equal(sink.pick(1, 1, 2000), PICK_PENDING);   // slot 0
  assert.equal(sink.pick(2, 2, 2000), PICK_PENDING);   // slot 1
  assert.equal(rec.copyCount, c0 + 2, "two enqueues issued two texture->buffer copies");
  assert.equal(sink.pick(3, 3, 2000), PICK_PENDING);   // both in flight -> back-pressure
  assert.equal(rec.copyCount, c0 + 2, "the back-pressured pick did NOT enqueue a third copy");
  sink.dispose();
});

test("pick fail-closed guards: count<=0 -> -1, OOB -> -1, count-1 past PICK_MAX_ID throws", async () => {
  const { target } = await makeTarget();
  const sink = createGPUPointSink(target, { capacity: 4096 });
  const f = createField({ capacity: 4096, stride: LAYOUT.POINT });
  f.setCount(100); f.touchAll(); f.flush(sink);

  assert.equal(sink.pick(10, 10, 0), -1, "count<=0 is an immediate miss");
  assert.equal(sink.pick(-1, 10, 100), -1, "a negative coordinate is an immediate miss, never PENDING");
  assert.equal(sink.pick(10, 10000, 100), -1, "an out-of-bounds y is an immediate miss");
  assert.throws(
    () => sink.pick(10, 10, PICK_MAX_ID + 2),
    /past PICK_MAX_ID/,
    "a count whose top index passes PICK_MAX_ID throws rather than aliasing the miss value"
  );
  sink.dispose();
});

test("pick after dispose drops a late resolution without touching a freed buffer", async () => {
  const { target, device } = await makeTarget();
  const sink = createGPUPointSink(target, { capacity: 256 });
  const f = createField({ capacity: 256, stride: LAYOUT.POINT });
  f.setCount(64); f.touchAll(); f.flush(sink);
  device.__pickPixel = encodeId(3);
  assert.equal(sink.pick(5, 5, 64), PICK_PENDING);
  sink.dispose();               // invalidates slots
  await tick();                 // the late mapAsync resolution must be a no-op
  // no throw == pass
});

// ===========================================================================
// Multi-sink clear coordination: N fields on ONE canvas must COMPOSITE, not have
// the last sink wipe the others. First pass clears; later passes load; new frame resets.
// ===========================================================================

test("multi-sink frame: first pass clears the shared canvas, later passes load (WebGL2 parity)", async () => {
  const { target, rec, nextFrame } = await makeTarget();
  const s1 = createGPUPointSink(target, { capacity: 64 });
  const s2 = createGPUQuadSink(target, { capacity: 64 });
  const f1 = createField({ capacity: 64, stride: LAYOUT.POINT });
  const f2 = createField({ capacity: 64, stride: LAYOUT.QUAD });
  f1.setCount(4); f2.setCount(4);

  // frame 1: two sinks draw onto ONE canvas texture.
  f1.touchAll(); f1.flush(s1);
  assert.equal(rec.lastLoadOp, "clear", "the first sink this frame clears the shared canvas");
  f2.touchAll(); f2.flush(s2);
  assert.equal(rec.lastLoadOp, "load", "the second sink loads (composites) -- it does NOT re-clear");

  // frame 2: a new getCurrentTexture() identity resets the coordination to clear.
  nextFrame();
  f1.touchAll(); f1.flush(s1);
  assert.equal(rec.lastLoadOp, "clear", "a new frame's first sink clears again");
  f2.touchAll(); f2.flush(s2);
  assert.equal(rec.lastLoadOp, "load", "a new frame's later sink loads again");

  s1.dispose(); s2.dispose();
});

// ===========================================================================
// Byte-placement differential (B1): the dirty-window uploads must reconstruct the
// buffer BYTE-FOR-BYTE, not merely upload the right window. Mirrors the WebGL2 T5
// oracle -- the faithful mock actually places uploaded bytes into the vbo backing.
// ===========================================================================

test("byte-placement: WebGPU dirty-window uploads reconstruct the buffer byte-for-byte vs a full-upload oracle", async () => {
  const { target, rec } = await makeTarget({ faithful: true });
  const stride = LAYOUT.QUAD;
  const cap = 256;
  const sink = createGPUQuadSink(target, { capacity: cap });
  const f = createField({ capacity: cap, stride });

  const oracle = new Float32Array(cap * stride);   // naive full-state reference
  let seed = 0x51ed270b;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
  let _v = 0;
  const wReal = (d, b) => { for (let k = 0; k < stride; k++) d[b + k] = (_v * 7 + k) & 0xffff; };
  const applyOracle = (base) => { for (let k = 0; k < stride; k++) oracle[base + k] = (_v * 7 + k) & 0xffff; };

  f.setCount(0);
  for (let step = 0; step < 4000; step++) {
    const r = rnd();
    if (r < 0.4 && f.count < cap) { _v = step; const i = f.push(wReal); applyOracle(i * stride); }
    else if (r < 0.7 && f.count > 0) { const i = (rnd() * f.count) | 0; _v = step; f.set(i, wReal); applyOracle(i * stride); }
    else if (r < 0.85 && f.count > 0) {
      const i = (rnd() * f.count) | 0, last = f.count - 1;
      f.swapRemove(i);
      if (i !== last) { for (let k = 0; k < stride; k++) oracle[i * stride + k] = oracle[last * stride + k]; }
    } else { f.flush(sink); }
  }
  f.flush(sink);

  const vbo = rec.lastVertexBuffer.__f32;   // the mock placed the uploaded BYTES here
  assert.ok(vbo, "the faithful mock exposes the vbo backing");
  let mismatch = -1;
  const activeFloats = f.count * stride;
  for (let i = 0; i < activeFloats; i++) { if (vbo[i] !== oracle[i]) { mismatch = i; break; } }
  assert.equal(mismatch, -1, "vbo backing diverged from the full-upload oracle at float index " + mismatch);
  assert.ok(activeFloats > 0 && oracle[0] !== 0, "sanity: the oracle holds real (nonzero) data, not a trivial all-zero match");
  sink.dispose();
});

// ===========================================================================
// Dirty-window PARITY (B1): the exact deterministic scenario committed as the
// zero-tolerance WebGL2 gate baseline (test/gates/dirty-range.mjs, BASELINE=8768:
// append 1000 in one flush, 64 scatter-edits each flushed, 32 swap-removes each
// flushed, STRIDE=LAYOUT.POINT=8) run through the WebGPU sink must sum to the
// IDENTICAL 8768 floats and issue the IDENTICAL (floatOffset,floatCount) window
// sequence as the WebGL2 sink for the same edit stream -- the dirty-range
// contract is sink-agnostic (owned by GL.js core, not by either backend).
// ===========================================================================

test("B1: WebGPU dirty-window (floatOffset,floatCount) sequence matches the committed WebGL2 8768 baseline exactly", async () => {
  const { target } = await makeTarget();
  const STRIDE = LAYOUT.POINT;
  const CAPACITY = 4096, APPEND_N = 1000, SCATTER_K = 64, REMOVE_M = 32;
  const write = (data, base, v) => { for (let k = 0; k < STRIDE; k++) data[base + k] = (v * 7 + k) & 0xffff; };
  const scatterIndex = (i) => (i * 61 + 7) % APPEND_N;

  const sink = createGPUPointSink(target, { capacity: CAPACITY });
  const windows = [];
  const wrapped = {
    upload(data, floatOffset, floatCount, instanceOffset, stride) {
      windows.push([floatOffset, floatCount]);
      sink.upload(data, floatOffset, floatCount, instanceOffset, stride);
    },
    draw(count) { sink.draw(count); },
  };

  const f = createField({ capacity: CAPACITY, stride: STRIDE });
  for (let i = 0; i < APPEND_N; i++) f.push((d, b) => write(d, b, i));
  f.flush(wrapped);
  for (let i = 0; i < SCATTER_K; i++) {
    const idx = scatterIndex(i);
    f.set(idx, (d, b) => write(d, b, 1000 + i));
    f.flush(wrapped);
  }
  for (let i = 0; i < REMOVE_M; i++) {
    if (f.count > 1) f.swapRemove(0);
    f.flush(wrapped);
  }

  const total = windows.reduce((a, [, c]) => a + c, 0);
  assert.equal(total, 8768, "the WebGPU path uploads the SAME committed float total as the WebGL2 dirty-range gate");
  assert.equal(windows.length, 97, "the WebGPU path issues the SAME number of upload calls (97) as the WebGL2 scenario");
  sink.dispose();
});

// ===========================================================================
// No-edit frame (B2 gap-close): a flush with NOTHING dirty must issue ZERO
// vbo writeBuffer (upload) calls and zero uploaded bytes -- GL.js's flush()
// guards `sink.upload` on dLo>=0, so a no-edit frame must never touch the
// vertex-buffer upload path, only draw() (which legitimately rewrites the
// small per-frame resolution/camera UNIFORM buffer every frame -- that fixed
// cost is what BASELINE=192 in the frame-alloc gate already accounts for).
// This isolates the vbo-specific claim from that unrelated uniform write.
// ===========================================================================

test("B2: a no-edit frame issues zero vbo upload calls and zero uploaded bytes (flush skips upload when nothing is dirty)", async () => {
  const { target } = await makeTarget({ faithful: true });
  const sink = createGPUPointSink(target, { capacity: 64 });
  const f = createField({ capacity: 64, stride: LAYOUT.POINT });
  f.setCount(8);
  f.touchAll();

  let uploadCalls = 0, uploadedBytes = 0;
  const realUpload = sink.upload.bind(sink);
  sink.upload = (data, floatOffset, floatCount, instanceOffset, stride) => {
    uploadCalls++; uploadedBytes += floatCount * 4;
    realUpload(data, floatOffset, floatCount, instanceOffset, stride);
  };

  f.flush(sink);   // seed: one real upload (dirty from touchAll), outside the measured window
  assert.equal(uploadCalls, 1, "sanity: the seed frame DOES upload (dirty range present)");
  uploadCalls = 0; uploadedBytes = 0;

  f.flush(sink);   // nothing dirty (the seed flush cleared touchAll's range)
  f.flush(sink);   // a second consecutive no-edit frame, for good measure

  assert.equal(uploadCalls, 0, "a no-edit flush issues ZERO vbo upload (queue.writeBuffer) calls");
  assert.equal(uploadedBytes, 0, "a no-edit flush uploads ZERO bytes to the vertex buffer");
  sink.dispose();
});

// ===========================================================================
// Counters conformance (both attach paths + detach + malformed).
// ===========================================================================

function makeCounter() {
  return {
    floatsUploaded: 0, drawCalls: 0,
    recordUpload(n) { this.floatsUploaded += n; },
    recordDraw(n) { this.drawCalls += n; },
  };
}

test("counters record exact dirty-window floats and non-empty draws (setCounters path)", async () => {
  const { target } = await makeTarget();
  const sink = createGPUQuadSink(target, { capacity: 512 });
  const counter = makeCounter();
  sink.setCounters(counter);
  const stride = LAYOUT.QUAD;
  const f = createField({ capacity: 512, stride });
  const write = (d, b) => { for (let k = 0; k < stride; k++) d[b + k] = k; };

  let expFloats = 0, expDraws = 0;
  const doFlush = () => {
    const dLo = f.dirtyLo(), dHi = f.dirtyHi(), cnt = f.count;
    if (dLo >= 0) { const hi = dHi < cnt ? dHi : cnt - 1; if (hi >= dLo) expFloats += (hi - dLo + 1) * stride; }
    if (cnt > 0) expDraws += 1;
    f.flush(sink);
  };
  for (let i = 0; i < 100; i++) f.push(write);
  doFlush();
  for (let i = 0; i < 20; i++) { f.set(i * 3, write); doFlush(); }
  assert.equal(counter.floatsUploaded, expFloats, "floatsUploaded equals the summed dirty windows");
  assert.equal(counter.drawCalls, expDraws, "drawCalls equals the non-empty draw count");

  // a pick is NOT a draw/upload.
  const fu = counter.floatsUploaded, dc = counter.drawCalls;
  for (let p = 0; p < 10; p++) sink.pick(5, 5, f.count);
  assert.equal(counter.floatsUploaded, fu, "pick does not upload");
  assert.equal(counter.drawCalls, dc, "pick does not draw");

  // detach.
  sink.setCounters(null);
  f.touchAll(); f.flush(sink);
  assert.equal(counter.floatsUploaded, fu, "setCounters(null) stops upload counting");
  assert.equal(counter.drawCalls, dc, "setCounters(null) stops draw counting");
  sink.dispose();
});

test("counters attach via the construction option, and a malformed handle throws (fail closed)", async () => {
  const { target } = await makeTarget();
  const counter = makeCounter();
  const sink = createGPULineSink(target, { capacity: 128, counters: counter });
  const stride = LAYOUT.LINE;
  const f = createField({ capacity: 128, stride });
  const write = (d, b) => { for (let k = 0; k < stride; k++) d[b + k] = 1; };
  for (let i = 0; i < 10; i++) f.push(write);
  f.flush(sink);
  assert.equal(counter.floatsUploaded, 10 * stride, "the construction-option handle counts");
  assert.equal(counter.drawCalls, 1);
  assert.throws(() => sink.setCounters({ recordUpload() {} }), /recordUpload.*recordDraw|counters/, "a handle missing recordDraw throws");
  sink.dispose();
});

// ===========================================================================
// The GL.js core seam bound to a WebGPU sink (assertCaps accepts pickMode:"deferred").
// ===========================================================================

test("reactiveField binds a POINT field to a WebGPU sink and draws through it", async () => {
  const { target, rec } = await makeTarget();
  const sink = createGPUPointSink(target, { capacity: 64 });
  const { reactiveField: rf } = createDriver({ effect: sEffect, onCleanup: sOnCleanup, dispose: sDispose });
  const f = createField({ capacity: 64, stride: LAYOUT.POINT });
  let handle;
  const scopeDispose = createScope((d) => {
    handle = rf(f, { manual: true, sink, project: (fl) => { fl.setCount(8); fl.touchAll(); } });
    return d;
  });
  const sub0 = rec.submitCount;
  handle.frame();
  assert.equal(rec.submitCount, sub0 + 1, "the bound field draws through the WebGPU sink");
  scopeDispose();
  sink.dispose();
});

test("reactiveField binds a POINT_HI field to the hi sink (precisionHi:true) and moves the camera", async () => {
  const { target } = await makeTarget();
  const sink = createGPUPointHiSink(target, { capacity: 64 });
  sink.setCamera(1.78e12, 0, 1, 1, 400, 300);
  const cam = sink.getCamera();
  assert.equal(cam.hiX, Math.fround(1.78e12), "camera hi part is fround(x)");
  assert.equal(cam.loX, Math.fround(1.78e12 - Math.fround(1.78e12)), "camera lo part is the residual");
  const { reactiveField: rf } = createDriver({ effect: sEffect, onCleanup: sOnCleanup, dispose: sDispose });
  const f = createField({ capacity: 64, stride: LAYOUT.POINT_HI });
  let handle;
  const scopeDispose = createScope((d) => {
    handle = rf(f, {
      manual: true, sink,
      project: (fl) => { fl.set(0, (d2, b) => writePointHi(d2, b, 1.78e12, 5, 3, 1, 1, 1, 1)); fl.setCount(1); },
    });
    return d;
  });
  handle.frame();   // must not throw: POINT_HI on a precisionHi WebGPU sink
  scopeDispose();
  sink.dispose();
});

test("B5: a LAYOUT.POINT_HI field bound to a REAL WebGPU sink with precisionHi:false throws at bind", async () => {
  // caps_test.mjs proves this against a generic mock caps object; this closes the gap
  // by exercising the SAME guard through the real GLWebGPU.js sink factory (precisionHi
  // is false on every WebGPU sink except createGPUPointHiSink).
  const { target } = await makeTarget();
  const sink = createGPUPointSink(target, { capacity: 64 });   // precisionHi: false
  assert.equal(sink.caps.precisionHi, false, "sanity: this sink genuinely advertises precisionHi:false");
  const { reactiveField: rf } = createDriver({ effect: sEffect, onCleanup: sOnCleanup, dispose: sDispose });
  const fHi = createField({ capacity: 64, stride: LAYOUT.POINT_HI });
  assert.throws(
    () => {
      const scopeDispose = createScope((d) => { rf(fHi, { manual: true, sink, project: (fl) => fl.setCount(0) }); return d; });
      scopeDispose();
    },
    /does not advertise precisionHi/,
    "POINT_HI on a real precisionHi:false WebGPU sink must throw at bind, never silently drop precision"
  );
  sink.dispose();
});
