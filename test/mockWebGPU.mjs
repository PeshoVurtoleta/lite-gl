// test/mockWebGPU.mjs -- the ONE WebGPU mock (single source of truth).
//
// Imported by test/GLWebGPU_test.mjs (which re-exports it), test/torture.mjs, and
// test/gates/webgpu-frame-alloc.mjs. It lives in its OWN module (not inside the
// node:test file) so importing it into torture or a gate never schedules/executes
// the test suite -- only the mock is shared.
//
// Two modes:
//   - recording (default): the HOT path (queue.writeBuffer / pass.draw / queue.submit)
//     records only PRIMITIVES + counters, and createCommandEncoder / beginRenderPass /
//     finish / getCurrentTexture / createView return REUSED singletons. So a steady-state
//     frame allocates NOTHING beyond the sink+core -- this is the mock torture T6(gpu)
//     heap-samples to prove the WebGPU sink adds zero per-frame JS allocation.
//   - faithful ({ faithful:true }): createCommandEncoder, beginRenderPass, queue.submit
//     and mapAsync each fabricate a fresh, realistically-shaped object per call AND add a
//     NOMINAL byte cost to device.__alloc. That integer accounting is what the frame-alloc
//     gate reads with ZERO TOLERANCE. The baseline is a property of THIS MOCK, not a real
//     driver.
//
// FAITHFUL PER-FRAME OBJECT INVENTORY (a normal dirty frame = upload + draw):
//   queue.writeBuffer .......... 0 (not an object; records primitives)
//   getCurrentTexture/createView 0 (reused singletons -- realistic; not in the baseline)
//   createCommandEncoder ....... 1 object, GPU_COST_ENCODER bytes
//   beginRenderPass ............ 1 object, GPU_COST_PASS bytes
//   encoder.finish ............. 0 (reused singleton command buffer)
//   queue.submit ............... 1 object, GPU_COST_SUBMIT bytes
//   -----------------------------------------------------------------
//   WEBGPU_FRAME_BASELINE = GPU_COST_ENCODER + GPU_COST_PASS + GPU_COST_SUBMIT.
// mapAsync (deferred pick only, NOT per frame) = GPU_COST_MAPASYNC.
//
// MIT (c) 2026 Zahary Shinikchiev

/** Nominal per-object byte costs the FAITHFUL mock attributes to each fabrication. */
export const GPU_COST_ENCODER = 64;
export const GPU_COST_PASS = 64;
export const GPU_COST_SUBMIT = 64;
export const GPU_COST_MAPASYNC = 64;

/** The committed steady-state frame baseline (a property of this mock, not a driver). */
export const WEBGPU_FRAME_BASELINE = GPU_COST_ENCODER + GPU_COST_PASS + GPU_COST_SUBMIT; // 192

const GPU_BUFFER_MAP_READ = 0x0001;
const GPU_BUFFER_VERTEX = 0x0020;
/** The deferred-pick id target format -- how the mock tells a pick pipeline from a draw one. */
const PICK_ID_FORMAT = "rgba8unorm";

/** Encode a 24-bit instance id into an rgba8unorm pixel (little-endian), a=255. */
export function encodeId(id) {
  if (id < 0) return [255, 255, 255, 255];   // white = miss
  return [id & 0xFF, (id >> 8) & 0xFF, (id >> 16) & 0xFF, 255];
}

/**
 * Build a mock WebGPU device + canvas. Returns { device, canvas, rec } where `rec`
 * exposes the recorded primitives/counters. Pass the device to createGPUTarget via
 * `{ device }` (no navigator monkey-patching).
 *
 * @param {{ faithful?: boolean }} [opts]
 */
export function mockWebGPU(opts = {}) {
  const faithful = !!opts.faithful;

  const rec = {
    writeCount: 0, lastWriteOffset: -1, lastWriteSize: -1,
    drawCount: 0, lastDrawInstances: -1,
    submitCount: 0, encoderCount: 0, passCount: 0, finishCount: 0,
    copyCount: 0, mapAsyncCount: 0,
    pipelineCount: 0, shaderModuleCount: 0, bufferCount: 0, textureCount: 0,
    buffersDestroyed: 0,
    // Clear-coordination + byte-placement observability. lastLoadOp is a PRIMITIVE (no
    // per-pass allocation in the hot loop); lastVertexBuffer exposes the vbo backing for
    // the byte-placement oracle. Set by the mock, read by GLWebGPU_test.mjs.
    lastLoadOp: null, lastVertexBuffer: null,
    // Pipeline-descriptor observability (blend assertion). O(1) REFERENCES only -- the mock
    // records the last draw/pick pipeline descriptor without deep-cloning or fabricating any
    // per-call object, so T7(gpu) churn/retention stays clean. Draw is keyed by the context
    // format; pick is keyed by PICK_ID_FORMAT (rgba8unorm).
    lastDrawPipelineDesc: null, lastPickPipelineDesc: null,
  };

  let resolveLost;
  const lost = new Promise((r) => { resolveLost = r; });

  // Reused singletons for the recording (non-faithful) hot path.
  const _encoder = makeEncoder(rec, faithful, deviceRef);
  const _cmd = { __tag: "cmd" };
  const _canvasView = { __tag: "view" };
  // The canvas texture identity advances only on nextFrame() -- mirroring real WebGPU,
  // where getCurrentTexture() returns the SAME object within a frame and a NEW one after
  // presentation. Reusing it inside a frame keeps the hot path allocation-free; a distinct
  // object per frame is what lets the target reset loadOp to "clear" on a new frame.
  const makeCanvasTex = () => ({ createView() { return _canvasView; } });
  let _frameTex = makeCanvasTex();

  function deviceRef() { return device; }

  const queue = {
    writeBuffer(buffer, bufferOffset, data, dataOffset, size) {
      rec.writeCount++;
      rec.lastWriteOffset = bufferOffset;
      rec.lastWriteSize = size;
      // Faithful mode ACTUALLY places the uploaded bytes into the buffer's backing, so a
      // bug that computes the right window but writes wrong bytes is catchable (B1). This
      // is guarded on `faithful` so the recording hot path stays allocation-free.
      if (faithful && buffer && buffer.__u8dst) {
        buffer.__u8dst.set(new Uint8Array(data, dataOffset || 0, size), bufferOffset);
      }
    },
    submit(commandBuffers) {
      rec.submitCount++;
      if (faithful) { device.__alloc += GPU_COST_SUBMIT; return { __tag: "submit" }; }
    },
  };

  const device = {
    queue,
    lost,
    __alloc: 0,
    __pickPixel: [255, 255, 255, 255],   // default: miss
    __cmd: _cmd,
    __resetAlloc() { device.__alloc = 0; },
    __loseContext() { resolveLost({ reason: "destroyed", message: "mock loss" }); },
    createShaderModule(desc) { rec.shaderModuleCount++; return { __tag: "shader" }; },
    createRenderPipeline(desc) {
      rec.pipelineCount++;
      // Record an O(1) reference to the descriptor so a test can assert the blend key. The
      // pick pipeline targets PICK_ID_FORMAT; every other target is a draw pipeline.
      const t0 = desc && desc.fragment && desc.fragment.targets && desc.fragment.targets[0];
      if (t0 && t0.format === PICK_ID_FORMAT) rec.lastPickPipelineDesc = desc;
      else rec.lastDrawPipelineDesc = desc;
      return { getBindGroupLayout(i) { return { __tag: "bgl", index: i }; } };
    },
    createBindGroup(desc) { return { __tag: "bindGroup" }; },
    createBuffer(desc) {
      rec.bufferCount++;
      const mapRead = (desc.usage & GPU_BUFFER_MAP_READ) !== 0;
      const buf = makeBuffer(desc.size, desc.usage, mapRead, rec, faithful);
      if ((desc.usage & GPU_BUFFER_VERTEX) !== 0) rec.lastVertexBuffer = buf;   // the byte-placement oracle
      return buf;
    },
    createTexture(desc) {
      rec.textureCount++;
      return {
        createView() { return { __tag: "idView" }; },
        destroy() {},
      };
    },
    createCommandEncoder() {
      rec.encoderCount++;
      if (faithful) { device.__alloc += GPU_COST_ENCODER; return makeEncoder(rec, faithful, deviceRef); }
      return _encoder;
    },
    destroy() {},
  };

  const context = {
    configure(desc) {},
    unconfigure() {},
    getCurrentTexture() { return _frameTex; },
  };

  const canvas = {
    width: 800, height: 600,
    getContext(type) { return type === "webgpu" ? context : null; },
  };

  // Advance to the next frame: a NEW canvas-texture identity (as presentation would give),
  // so the target's clear-coordination resets the first pass to loadOp:"clear".
  const nextFrame = () => { _frameTex = makeCanvasTex(); };

  return { device, canvas, context, rec, nextFrame };
}

function makePass(rec) {
  return {
    setPipeline() {}, setVertexBuffer() {}, setBindGroup() {}, setScissorRect() {},
    draw(vertexCount, instanceCount) { rec.drawCount++; rec.lastDrawInstances = instanceCount; },
    end() {},
  };
}

function makeEncoder(rec, faithful, deviceRef) {
  const _pass = makePass(rec);
  return {
    beginRenderPass(desc) {
      rec.passCount++;
      // Record the pass's loadOp (primitive; no allocation) so the clear-coordination
      // test can assert first-pass="clear" / subsequent="load" for a multi-sink frame.
      const att = desc && desc.colorAttachments && desc.colorAttachments[0];
      rec.lastLoadOp = att ? att.loadOp : null;
      const device = deviceRef();
      if (faithful) { device.__alloc += GPU_COST_PASS; return makePass(rec); }
      return _pass;
    },
    copyTextureToBuffer(src, dst, size) {
      rec.copyCount++;
      const device = deviceRef();
      if (dst && dst.buffer && dst.buffer.__pixelSet) dst.buffer.__pixelSet(device.__pickPixel);
    },
    finish() { rec.finishCount++; return deviceRef().__cmd; },
  };
}

function makeBuffer(size, usage, mapRead, rec, faithful) {
  const ab = new ArrayBuffer(size < 4 ? 4 : size);
  const u8 = new Uint8Array(ab);
  // A faithful, non-readback buffer (vbo/uniform) exposes a byte view writeBuffer places
  // into, and a Float32Array view the byte-placement oracle reads. Recording mode skips
  // this so its hot path never touches the backing.
  const dst = (faithful && !mapRead) ? u8 : null;
  const f32 = (faithful && !mapRead) ? new Float32Array(ab) : null;
  return {
    size, usage,
    __u8dst: dst,
    __f32: f32,
    __pixelSet(px) { u8[0] = px[0]; u8[1] = px[1]; u8[2] = px[2]; u8[3] = px[3]; },
    mapAsync(mode) { rec.mapAsyncCount++; return Promise.resolve(); },
    getMappedRange() { return ab; },   // persistent buffer -> the picker's view is built once
    unmap() {},
    destroy() { rec.buffersDestroyed++; },
  };
}
