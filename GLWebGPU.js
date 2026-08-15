/**
 * @zakkster/lite-gl -- WebGPU backend (the GPU `sink`). v2.0.0.
 * -----------------------------------------------------------------------------
 * BROWSER/GPU-ONLY at runtime. Every hot-path and fail-closed claim in this file is
 * covered headlessly by test/GLWebGPU_test.mjs driving a mock GPUDevice (injected via
 * `createGPUTarget(canvas, { device })`), plus a precision-parity suite
 * (test/precision_parity_test.mjs) and the WebGPU tiers of test/torture.mjs. Real-GPU
 * validation runs in CI via the `webgpu` project of test/smoke.spec.mjs
 * (test/smoke.html?scene=webgpu) wherever a WebGPU adapter is available, and records an
 * explicit skip otherwise.
 *
 * This is a SEPARATE backend that mirrors GLBackend.js's `sink` interface exactly:
 *   upload(data, floatOffset, floatCount[, instanceOffset, stride]) + draw(count),
 * plus resize / setScissor / clearScissor / setClearColor / setCounters /
 * onContextRestored / isContextLost / dispose, and pick(x, y, count). The GL.js core
 * flushes to it unchanged; swap this for the WebGL2 sink without touching the core.
 *
 * RENDERING-MECHANISM vs DATA-CONTRACT. The field byte layout is BYTE-IDENTICAL to
 * the WebGL2 sink (POINT stride 8, QUAD 9, LINE 9, POINT_HI 10 -- same offsets). What
 * differs is the rendering MECHANISM, not the data: WebGPU has no gl_PointSize, so
 * POINT / POINT_HI are drawn as instanced unit-quads expanded by `a_size` in the
 * vertex shader (the same UNIT_QUAD pattern QUAD/LINE already use), and the pick pass's
 * gl_PointSize hit-area widening becomes an explicit quad expansion. The Y flip is
 * preserved verbatim (clip uses -clip.y); WGSL NDC z is [0,1] (we emit z = 0).
 *
 * PICK is DEFERRED (caps.pickMode = "deferred"). WebGPU has no synchronous readPixels,
 * so pick() renders a 24-bit-id pass, copies one texel into a pooled readback buffer,
 * and returns PICK_PENDING (-2) until the async mapAsync resolves; a later identical
 * pick() returns the decoded instance index (or -1 miss). Id encoding is rgba8unorm
 * with the EXACT `r | g<<8 | b<<16` decode and 0xFFFFFF miss sentinel from GLBackend.js,
 * so PICK_MAX_ID (0xFFFFFE) is meaningful and identical on both backends.
 *
 * WGSL lives INLINE as template strings (the single-file law forbids a separate .wgsl).
 *
 * MIT (c) 2026 Zahary Shinikchiev
 */

import { PICK_MAX_ID, PICK_PENDING } from "./GL.js";

// Re-export the sentinels so a WebGPU consumer imports them from THIS backend and
// reads bit-identical values to the core and the WebGL2 sink. Alias lines only.
export { PICK_MAX_ID, PICK_PENDING };

// === WGSL SHADERS (inline; single-file law) =================================
//
// POINT / POINT_HI expand a unit quad (4 corners from @builtin(vertex_index)) by
// a_size, centered on the projected pixel -- WebGPU has no gl_PointSize. The visible
// point passes discard the corners outside the inscribed circle so the sprite stays
// round, matching the WebGL2 gl_PointCoord discard. QUAD/LINE mirror GLBackend.js.

const POINT_WGSL = `
struct U { resolution: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) local: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) vi: u32,
           @location(0) a_pos: vec2<f32>,
           @location(1) a_size: f32,
           @location(2) a_color: vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5),
    vec2<f32>(-0.5, 0.5), vec2<f32>(0.5, 0.5));
  let corner = corners[vi];
  let px = a_pos + corner * a_size;
  let clip = (px / u.resolution) * 2.0 - 1.0;
  var out: VSOut;
  out.pos = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
  out.color = a_color;
  out.local = corner * 2.0;
  return out;
}
@fragment
fn fs_main(@location(0) color: vec4<f32>, @location(1) local: vec2<f32>) -> @location(0) vec4<f32> {
  if (dot(local, local) > 1.0) { discard; }
  return color;
}`;

// POINT_HI -- WORLD coords, GPU camera, double-emulated precision. The relative-to-eye
// subtraction (a_posHi - cameraHi) is a subtraction of two f32s of near-identical
// magnitude, so it cancels EXACTLY (Sterbenz); the residuals carry the detail. Do NOT
// reorder: subtract BEFORE add, scale AFTER the residual add. WGSL f32 is IEEE-754
// binary32, exactly like GLSL `highp float` -- no fma, no reassociation.
const POINT_HI_WGSL = `
struct U {
  resolution: vec2<f32>,
  cameraHi: vec2<f32>,
  cameraLo: vec2<f32>,
  scale: vec2<f32>,
  origin: vec2<f32>,
};
@group(0) @binding(0) var<uniform> u: U;
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) local: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) vi: u32,
           @location(0) a_posHi: vec2<f32>,
           @location(1) a_posLo: vec2<f32>,
           @location(2) a_size: f32,
           @location(3) a_color: vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5),
    vec2<f32>(-0.5, 0.5), vec2<f32>(0.5, 0.5));
  let rel = (a_posHi - u.cameraHi) + (a_posLo - u.cameraLo);
  let center = rel * u.scale + u.origin;
  let corner = corners[vi];
  let px = center + corner * a_size;
  let clip = (px / u.resolution) * 2.0 - 1.0;
  var out: VSOut;
  out.pos = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
  out.color = a_color;
  out.local = corner * 2.0;
  return out;
}
@fragment
fn fs_main(@location(0) color: vec4<f32>, @location(1) local: vec2<f32>) -> @location(0) vec4<f32> {
  if (dot(local, local) > 1.0) { discard; }
  return color;
}`;

const QUAD_WGSL = `
struct U { resolution: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) vi: u32,
           @location(0) a_pos: vec2<f32>,
           @location(1) a_size: vec2<f32>,
           @location(2) a_rot: f32,
           @location(3) a_color: vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5),
    vec2<f32>(-0.5, 0.5), vec2<f32>(0.5, 0.5));
  let local = corners[vi];
  let c = cos(a_rot);
  let s = sin(a_rot);
  let rot = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
  let world = a_pos + rot * a_size;
  let clip = (world / u.resolution) * 2.0 - 1.0;
  var out: VSOut;
  out.pos = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
  out.color = a_color;
  return out;
}
@fragment
fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
  return color;
}`;

const LINE_WGSL = `
struct U { resolution: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) vi: u32,
           @location(0) a_p0: vec2<f32>,
           @location(1) a_p1: vec2<f32>,
           @location(2) a_width: f32,
           @location(3) a_color: vec4<f32>) -> VSOut {
  var ts = array<vec2<f32>, 4>(
    vec2<f32>(0.0, -1.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let t = ts[vi].x;
  let sgn = ts[vi].y;
  let dir = a_p1 - a_p0;
  let len = length(dir);
  var unitDir = vec2<f32>(1.0, 0.0);
  if (len > 0.0001) { unitDir = dir / len; }
  let perp = vec2<f32>(-unitDir.y, unitDir.x);
  let base = mix(a_p0, a_p1, t);
  let world = base + sgn * (a_width * 0.5) * perp;
  let clip = (world / u.resolution) * 2.0 - 1.0;
  var out: VSOut;
  out.pos = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
  out.color = a_color;
  return out;
}
@fragment
fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
  return color;
}`;

// --- PICK variants: flat 24-bit id in an rgba8unorm target, white = miss. ---
// The pick pass widens POINT/POINT_HI hit area to max(a_size, 3.0) and LINE to
// max(a_width, 4.0), matching GLBackend.js's PICK_* shaders.

const PICK_POINT_WGSL = `
struct U { resolution: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) @interpolate(flat) id: vec4<f32> };
fn encodeId(i: u32) -> vec4<f32> {
  let r = f32(i & 0xFFu) / 255.0;
  let g = f32((i >> 8u) & 0xFFu) / 255.0;
  let b = f32((i >> 16u) & 0xFFu) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}
@vertex
fn vs_main(@builtin(vertex_index) vi: u32,
           @builtin(instance_index) ii: u32,
           @location(0) a_pos: vec2<f32>,
           @location(1) a_size: f32) -> VSOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5),
    vec2<f32>(-0.5, 0.5), vec2<f32>(0.5, 0.5));
  let sz = max(a_size, 3.0);
  let px = a_pos + corners[vi] * sz;
  let clip = (px / u.resolution) * 2.0 - 1.0;
  var out: VSOut;
  out.pos = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
  out.id = encodeId(ii);
  return out;
}
@fragment
fn fs_main(@location(0) @interpolate(flat) id: vec4<f32>) -> @location(0) vec4<f32> { return id; }`;

const PICK_POINT_HI_WGSL = `
struct U {
  resolution: vec2<f32>,
  cameraHi: vec2<f32>,
  cameraLo: vec2<f32>,
  scale: vec2<f32>,
  origin: vec2<f32>,
};
@group(0) @binding(0) var<uniform> u: U;
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) @interpolate(flat) id: vec4<f32> };
fn encodeId(i: u32) -> vec4<f32> {
  let r = f32(i & 0xFFu) / 255.0;
  let g = f32((i >> 8u) & 0xFFu) / 255.0;
  let b = f32((i >> 16u) & 0xFFu) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}
@vertex
fn vs_main(@builtin(vertex_index) vi: u32,
           @builtin(instance_index) ii: u32,
           @location(0) a_posHi: vec2<f32>,
           @location(1) a_posLo: vec2<f32>,
           @location(2) a_size: f32) -> VSOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5),
    vec2<f32>(-0.5, 0.5), vec2<f32>(0.5, 0.5));
  let rel = (a_posHi - u.cameraHi) + (a_posLo - u.cameraLo);
  let center = rel * u.scale + u.origin;
  let sz = max(a_size, 3.0);
  let px = center + corners[vi] * sz;
  let clip = (px / u.resolution) * 2.0 - 1.0;
  var out: VSOut;
  out.pos = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
  out.id = encodeId(ii);
  return out;
}
@fragment
fn fs_main(@location(0) @interpolate(flat) id: vec4<f32>) -> @location(0) vec4<f32> { return id; }`;

const PICK_QUAD_WGSL = `
struct U { resolution: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) @interpolate(flat) id: vec4<f32> };
fn encodeId(i: u32) -> vec4<f32> {
  let r = f32(i & 0xFFu) / 255.0;
  let g = f32((i >> 8u) & 0xFFu) / 255.0;
  let b = f32((i >> 16u) & 0xFFu) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}
@vertex
fn vs_main(@builtin(vertex_index) vi: u32,
           @builtin(instance_index) ii: u32,
           @location(0) a_pos: vec2<f32>,
           @location(1) a_size: vec2<f32>,
           @location(2) a_rot: f32) -> VSOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5),
    vec2<f32>(-0.5, 0.5), vec2<f32>(0.5, 0.5));
  let local = corners[vi];
  let c = cos(a_rot);
  let s = sin(a_rot);
  let rot = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
  let world = a_pos + rot * a_size;
  let clip = (world / u.resolution) * 2.0 - 1.0;
  var out: VSOut;
  out.pos = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
  out.id = encodeId(ii);
  return out;
}
@fragment
fn fs_main(@location(0) @interpolate(flat) id: vec4<f32>) -> @location(0) vec4<f32> { return id; }`;

const PICK_LINE_WGSL = `
struct U { resolution: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) @interpolate(flat) id: vec4<f32> };
fn encodeId(i: u32) -> vec4<f32> {
  let r = f32(i & 0xFFu) / 255.0;
  let g = f32((i >> 8u) & 0xFFu) / 255.0;
  let b = f32((i >> 16u) & 0xFFu) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}
@vertex
fn vs_main(@builtin(vertex_index) vi: u32,
           @builtin(instance_index) ii: u32,
           @location(0) a_p0: vec2<f32>,
           @location(1) a_p1: vec2<f32>,
           @location(2) a_width: f32) -> VSOut {
  var ts = array<vec2<f32>, 4>(
    vec2<f32>(0.0, -1.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let t = ts[vi].x;
  let sgn = ts[vi].y;
  let dir = a_p1 - a_p0;
  let len = length(dir);
  var unitDir = vec2<f32>(1.0, 0.0);
  if (len > 0.0001) { unitDir = dir / len; }
  let perp = vec2<f32>(-unitDir.y, unitDir.x);
  let base = mix(a_p0, a_p1, t);
  let world = base + sgn * (max(a_width, 4.0) * 0.5) * perp;
  let clip = (world / u.resolution) * 2.0 - 1.0;
  var out: VSOut;
  out.pos = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
  out.id = encodeId(ii);
  return out;
}
@fragment
fn fs_main(@location(0) @interpolate(flat) id: vec4<f32>) -> @location(0) vec4<f32> { return id; }`;

/** WGSL source per primitive: the visible pass and the deferred-pick id pass. */
const PIPELINE_SOURCES = {
  point: { draw: POINT_WGSL, pick: PICK_POINT_WGSL },
  pointHi: { draw: POINT_HI_WGSL, pick: PICK_POINT_HI_WGSL },
  quad: { draw: QUAD_WGSL, pick: PICK_QUAD_WGSL },
  line: { draw: LINE_WGSL, pick: PICK_LINE_WGSL },
};

const PICK_ID_FORMAT = "rgba8unorm";
/** copyTextureToBuffer requires bytesPerRow a multiple of 256. */
const PICK_READBACK_BYTES = 256;

// === BLEND (baked at construction; never read on the hot path) ==============
//
// WebGPU bakes blend into the render PIPELINE, so a sink's blend mode is resolved ONCE
// here (cold) and consumed only when createResources() builds the DRAW pipeline. The
// hot bodies (upload/draw/pick) never read or branch on blend. This is the WebGL2/WebGPU
// asymmetry: the WebGL2 sink leaves blend to whatever the GL context has enabled, while
// the WebGPU sink must own it in the pipeline. The PICK pipeline is ALWAYS opaque -- id
// pixels must not blend (blending the 24-bit id corrupts the r|g<<8|b<<16 decode).
//
// Factors are premultiplied-alphaMode safe (the RGB uses src-alpha; the ALPHA channel
// composites its own way so RGB <= A is preserved for correct over-compositing).
const BLEND_MODES = Object.freeze({
  additive: Object.freeze({
    color: Object.freeze({ srcFactor: "src-alpha", dstFactor: "one", operation: "add" }),
    alpha: Object.freeze({ srcFactor: "one", dstFactor: "one", operation: "add" }),
  }),
  alpha: Object.freeze({
    color: Object.freeze({ srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }),
    alpha: Object.freeze({ srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }),
  }),
});

/**
 * Resolve a blend option to a WebGPU blend state (or undefined for opaque). Cold path.
 * null/undefined and "opaque" -> undefined (NO blend key on the target). "additive" /
 * "alpha" -> the frozen descriptor. Any other value FAILS CLOSED with a did-you-mean hint.
 */
function resolveBlend(mode, factory) {
  if (mode === null || mode === undefined || mode === "opaque") return undefined;
  if (typeof mode === "string" && Object.prototype.hasOwnProperty.call(BLEND_MODES, mode)) {
    return BLEND_MODES[mode];
  }
  throw new Error(
    "lite-gl " + factory + ": unknown blend mode " + JSON.stringify(mode)
    + " (did you mean one of: opaque, additive, alpha?)."
  );
}
/** Pooled deferred-pick readback ring depth (Fork A). Two in-flight requests max. */
export const PICK_RING_K = 2;

// === DEVICE / TARGET (fail-closed acquisition) ==============================

/**
 * Acquire a WebGPU device + configure the canvas context. FAIL CLOSED on every
 * unverified state (null is not zero): an absent navigator/navigator.gpu, a null
 * adapter, or a rejected/undefined device all THROW -- this never returns a degraded
 * or null sink. Pass `opts.device` to INJECT a device (the test seam: mockWebGPU
 * enters here, with NO navigator monkey-patching).
 *
 * @param {*} canvas       an HTMLCanvas/OffscreenCanvas-shaped object with getContext("webgpu").
 * @param {{ device?, format?, alphaMode?, reacquire? }} [opts]
 * @returns {Promise<object>} target: { device, context, format, resize, isContextLost,
 *   onContextRestored, dispose, ... }
 */
export async function createGPUTarget(canvas, opts) {
  const o = opts || {};
  let device = o.device || null;
  let format = o.format || null;

  if (!device) {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      throw new Error(
        "lite-gl createGPUTarget: navigator.gpu is unavailable -- WebGPU is not supported "
        + "in this environment. Refusing to return a null sink (fail closed)."
      );
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error(
        "lite-gl createGPUTarget: navigator.gpu.requestAdapter() returned null -- no GPU "
        + "adapter available. Refusing to return a degraded sink (null is not zero)."
      );
    }
    device = await adapter.requestDevice();   // rejects on failure -> propagates (fail closed)
    if (!device) {
      throw new Error("lite-gl createGPUTarget: adapter.requestDevice() yielded no device.");
    }
    if (!format) format = navigator.gpu.getPreferredCanvasFormat();
  }
  if (!format) format = "bgra8unorm";

  if (!canvas || typeof canvas.getContext !== "function") {
    throw new Error("lite-gl createGPUTarget: a canvas with getContext('webgpu') is required.");
  }
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("lite-gl createGPUTarget: canvas.getContext('webgpu') returned null.");
  }
  const alphaMode = o.alphaMode || "premultiplied";
  context.configure({ device, format, alphaMode });

  const reacquire = typeof o.reacquire === "function" ? o.reacquire : null;
  let lost = false;
  const restoreCbs = [];   // reactiveField-style re-seed callbacks (public)
  const sinks = [];        // registered sinks (rebuild GPU resources on restore)
  let frameTex = null;     // clear-coordination: the getCurrentTexture() identity for this frame

  function wireLost() {
    const dl = device && device.lost;
    if (dl && typeof dl.then === "function") {
      dl.then(() => { lost = true; }, () => { lost = true; });
    }
  }
  wireLost();

  const target = {
    get device() { return device; },
    context,
    format,
    /** Track a new drawing-buffer size (sinks read it for the resolution uniform). */
    resize(w, h) {
      for (let i = 0; i < sinks.length; i++) sinks[i].resize(w, h);
    },
    isContextLost() { return lost; },
    /** reactiveField re-seed hook: fired AFTER sink resources rebuild on restore. */
    onContextRestored(cb) {
      restoreCbs.push(cb);
      return () => { const i = restoreCbs.indexOf(cb); if (i >= 0) restoreCbs.splice(i, 1); };
    },
    /**
     * Re-seed after device loss. Mirrors GLBackend.js onRestored ordering: rebuild every
     * sink's GPU resources FIRST, clear the lost flag, THEN fire the app re-seed callbacks
     * (which upload the surviving JS-side field data back into the fresh GPU buffers).
     * `newDevice` defaults to `reacquire()` if provided (the real path); tests pass one in.
     */
    async restore(newDevice) {
      const nd = newDevice || (reacquire ? await reacquire() : null);
      if (nd) {
        device = nd;
        context.configure({ device, format, alphaMode });
      }
      for (let i = 0; i < sinks.length; i++) sinks[i].__rebuild();
      lost = false;
      const cbs = restoreCbs.slice();
      for (let i = 0; i < cbs.length; i++) cbs[i]();
      wireLost();
    },
    /**
     * Acquire this frame's color target for one sink pass, with CLEAR COORDINATION so N
     * sinks composite onto ONE canvas correctly (the "many fields, one context" pattern).
     * The FIRST pass against a given getCurrentTexture() identity clears; every later pass
     * in the same frame loads (preserving prior sinks' pixels). A new frame's texture (new
     * identity) resets to clear. This mirrors WebGL2, whose draw() never clears at all.
     * Fills the caller's preallocated `out` in place (out.view, out.first) -- no allocation.
     */
    __acquireColorTarget(out) {
      const tex = context.getCurrentTexture();
      out.first = (tex !== frameTex);   // first sink to touch this frame's texture
      frameTex = tex;
      out.view = tex.createView();
    },
    __registerSink(s) { sinks.push(s); },
    __unregisterSink(s) { const i = sinks.indexOf(s); if (i >= 0) sinks.splice(i, 1); },
    dispose() {
      sinks.length = 0;
      restoreCbs.length = 0;
      if (context && typeof context.unconfigure === "function") context.unconfigure();
    },
  };
  return target;
}

// === CAPS (v2.0.0 caps seam; same key set/order as GLBackend.js makeCaps) ====

/**
 * Frozen WebGPU sink capability descriptor. Same keys, same order as the WebGL2
 * makeCaps -- so the GL.js core's assertCaps reads it identically. Differences:
 * `api:"webgpu"`, `baseVertex:true` (WebGPU supports it), and `pickMode:"deferred"`
 * (async readback -> pick() may return PICK_PENDING). `precisionHi` is true ONLY on
 * createGPUPointHiSink. `maxInstances` is PICK_MAX_ID + 1, identical to the WebGL2 sink.
 */
function makeGPUCaps(precisionHi) {
  return Object.freeze({
    api: "webgpu",
    instancing: true,
    baseVertex: true,
    maxInstances: PICK_MAX_ID + 1,
    precisionHi: precisionHi,
    pickMode: "deferred",
    version: 1,
  });
}

// === COUNTERS SEAM (wrapper-swap, byte-for-byte the GLBackend.js design) =====
// An OPTIONAL, duck-typed { recordUpload(floatCount), recordDraw(drawCount) } handle.
// Wrapper-swap so the no-counters hot path carries NO branch: a null handle installs
// the base upload/draw; an attached handle installs thin counting wrappers. Validation
// is fail-closed and runs once, at attach (cold). Primitive numbers only.

function validateGPUCounters(handle) {
  if (handle === null || handle === undefined) return null;
  if (typeof handle !== "object"
    || typeof handle.recordUpload !== "function"
    || typeof handle.recordDraw !== "function") {
    throw new TypeError(
      "lite-gl: `counters` must be a handle with recordUpload(n) and recordDraw(n) "
      + "methods (a lite-profiler-compatible counters object), or null to detach."
    );
  }
  return handle;
}

const _gpuSinkCounters = new WeakMap();   // api -> { baseUpload, baseDraw, count*, h }

function installGPUCounters(api, handle, isLost) {
  const counters = validateGPUCounters(handle);
  let rec = _gpuSinkCounters.get(api);
  if (!rec) {
    const baseUpload = api.upload;
    const baseDraw = api.draw;
    rec = {
      baseUpload, baseDraw, h: counters,
      countUpload(data, floatOffset, floatCount) {
        baseUpload(data, floatOffset, floatCount);
        if (!isLost()) rec.h.recordUpload(floatCount);   // only if actually written
      },
      countDraw(count) {
        baseDraw(count);
        if (!isLost() && count > 0) rec.h.recordDraw(1);  // one GPU submit per non-empty draw
      },
    };
    _gpuSinkCounters.set(api, rec);
  }
  rec.h = counters;
  api.upload = counters ? rec.countUpload : rec.baseUpload;
  api.draw = counters ? rec.countDraw : rec.baseDraw;
  return counters;
}

// === DEFERRED PICKER (Fork A -- pooled readback ring, K = 2) =================
//
// Zero per-call JS allocation in steady state: the K slot records, their readback
// GPUBuffers, decode views and the .then continuations are all created ONCE here. A
// resolved-but-unclaimed slot is reusable; both-in-flight applies back-pressure by
// returning PICK_PENDING WITHOUT enqueuing (no unbounded queue). dispose() invalidates
// every slot so a late mapAsync resolution is DROPPED, and each continuation closes over
// NOTHING but its own slot -- never the sink (that would retain it: a B3 leak).

function createGPUPicker() {
  const slots = new Array(PICK_RING_K);
  let disposed = false;

  for (let i = 0; i < PICK_RING_K; i++) {
    const slot = {
      buffer: null, view: null, mappedAB: null,
      inFlight: false, resolved: false, invalid: false,
      x: -1, y: -1, count: -1, id: -1,
      then: null, thenReject: null,
    };
    slot.then = () => {
      // Closes over `slot` ONLY. A resolution after dispose (or after the slot was
      // invalidated by a rebuild) is dropped without touching a freed buffer.
      if (disposed || slot.invalid || !slot.buffer) return;
      const ab = slot.buffer.getMappedRange();
      if (slot.view === null || slot.mappedAB !== ab) {
        slot.view = new Uint8Array(ab);   // created once per backing buffer, then reused
        slot.mappedAB = ab;
      }
      const r = slot.view[0], g = slot.view[1], b = slot.view[2];
      slot.id = (r === 255 && g === 255 && b === 255) ? -1 : (r | (g << 8) | (b << 16));
      slot.buffer.unmap();
      slot.resolved = true;
      slot.inFlight = false;
    };
    // Pre-bound rejection handler (created ONCE, closes over `slot` only): on real
    // hardware dispose()/device-loss destroys the readback buffer and REJECTS the pending
    // mapAsync. Drop the readback quietly -- no throw, no unhandled rejection, no retention.
    slot.thenReject = () => { slot.inFlight = false; };
    slots[i] = slot;
  }

  return {
    slots,
    ensureBuffers(device) {
      for (let i = 0; i < PICK_RING_K; i++) {
        const s = slots[i];
        if (!s.buffer) {
          s.buffer = device.createBuffer({
            size: PICK_READBACK_BYTES,
            usage: GPU_BUFFER_MAP_READ | GPU_BUFFER_COPY_DST,
          });
          s.view = null; s.mappedAB = null;
        }
        s.invalid = false;
      }
    },
    /** After device loss the readback buffers are gone; a pending resolve must be dropped. */
    invalidate() {
      for (let i = 0; i < PICK_RING_K; i++) {
        const s = slots[i];
        s.invalid = true; s.buffer = null; s.view = null; s.mappedAB = null;
        s.inFlight = false; s.resolved = false;
      }
    },
    dispose() {
      disposed = true;
      for (let i = 0; i < PICK_RING_K; i++) {
        const s = slots[i];
        s.invalid = true;
        if (s.buffer && typeof s.buffer.destroy === "function") s.buffer.destroy();
        s.buffer = null; s.view = null; s.mappedAB = null;
      }
    },
  };
}

// WebGPU GPUBufferUsage / GPUTextureUsage bit flags (structural; no @webgpu/types dep).
const GPU_BUFFER_MAP_READ = 0x0001;
const GPU_BUFFER_COPY_DST = 0x0008;
const GPU_BUFFER_COPY_SRC = 0x0004;
const GPU_BUFFER_VERTEX = 0x0020;
const GPU_BUFFER_UNIFORM = 0x0040;
const GPU_TEXTURE_RENDER_ATTACHMENT = 0x10;
const GPU_TEXTURE_COPY_SRC = 0x01;

// === THE SHARED SINK BUILDER ================================================
// One builder drives all four public factories -- the WebGPU field layouts are
// byte-identical to WebGL2, so only the WGSL, the vertex-attribute list, the uniform
// size and (for POINT_HI) the camera differ. upload/draw are HOT: no closures, no
// object literals, no per-call allocation inside them. Every per-frame descriptor
// (render pass, submit array, uniform scratch) is preallocated ONCE at construction
// and mutated in place, so all remaining per-frame allocation is at the device
// boundary (createCommandEncoder / beginRenderPass / submit), never in this code.

function makeGPUSink(target, opts, spec) {
  if (target === null || typeof target !== "object" || !target.device) {
    throw new Error(
      "lite-gl " + spec.factory + ": a target from createGPUTarget(canvas, opts) is required "
      + "(got " + String(target) + "). Refusing to build a sink on an unverified device."
    );
  }
  if (opts === null || typeof opts !== "object" || typeof opts.capacity !== "number") {
    throw new Error("lite-gl " + spec.factory + ": opts.capacity (max instances) is required.");
  }
  const capacity = opts.capacity;
  const stride = spec.stride;                // floats per instance
  const strideBytes = stride * 4;
  const isHi = spec.isHi;
  const caps = makeGPUCaps(!!spec.precisionHi);

  // Blend resolved ONCE, COLD, here -- after the capacity guard, before any device resource
  // (createResources) is built. An unknown mode throws now, so no pipeline/buffer/texture is
  // ever created (pipelineCount stays 0). blendState is consumed only by createResources'
  // DRAW pipeline; blendMode is the normalized string exposed as api.blend for introspection.
  const blendState = resolveBlend(opts.blend, spec.factory);
  const blendMode = (opts.blend === null || opts.blend === undefined) ? "opaque" : opts.blend;

  let resW = spec.resW || 800;
  let resH = spec.resH || 600;

  // JS-owned, preallocated ONCE (never in the hot path). uScratch holds the uniform
  // block; passDesc + its single colorAttachment + submitArray are mutated in place.
  const uScratch = new Float32Array(spec.uniformFloats);
  const clearValue = { r: 0, g: 0, b: 0, a: 0 };
  const colorAttachment = { view: null, clearValue, loadOp: "clear", storeOp: "store" };
  const passDesc = { colorAttachments: [colorAttachment] };
  const submitArray = new Array(1);
  const frameOut = { view: null, first: false };   // reused clear-coordination result
  const uniformBytes = spec.uniformFloats * 4;

  // Camera state (POINT_HI only). Split on the CPU in float64, uploaded as f32s.
  let camHiX = 0, camHiY = 0, camLoX = 0, camLoY = 0;
  let scaleX = 1, scaleY = 1, originX = null, originY = null;
  const ox = () => (originX === null ? resW * 0.5 : originX);
  const oy = () => (originY === null ? resH * 0.5 : originY);

  let scissor = null;
  const sc = { x: 0, y: 0, w: 0, h: 0 };
  let lastCount = 0;

  // Device-owned resources (rebuilt on restore).
  let pipeline = null, pickPipeline = null;
  let vbo = null, uniformBuffer = null, bindGroup = null;
  let idTex = null, idView = null, idW = 0, idH = 0;

  const picker = createGPUPicker();   // holds no sink ref (leak-safe continuations)

  function buildVertexBufferLayout() {
    return {
      arrayStride: strideBytes,
      stepMode: "instance",
      attributes: spec.attributes,   // [{ shaderLocation, offset, format }]
    };
  }

  function createResources() {
    const device = target.device;
    const src = PIPELINE_SOURCES[spec.primitive];
    const drawModule = device.createShaderModule({ code: src.draw });
    const vbLayout = buildVertexBufferLayout();
    pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: drawModule, entryPoint: "vs_main", buffers: [vbLayout] },
      // Opaque (blendState undefined) keeps the target EXACTLY { format } -- byte-equivalent
      // to the pre-blend pipeline; a resolved mode adds the baked blend key. Cold path.
      fragment: {
        module: drawModule, entryPoint: "fs_main",
        targets: [blendState === undefined
          ? { format: target.format }
          : { format: target.format, blend: blendState }],
      },
      primitive: { topology: "triangle-strip" },
    });

    const pickModule = device.createShaderModule({ code: src.pick });
    // The pick pass reads only the geometry attributes (no color), but reusing the full
    // instance layout is valid -- unused attributes are simply not consumed by the shader.
    pickPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: pickModule, entryPoint: "vs_main", buffers: [buildVertexBufferLayout()] },
      fragment: { module: pickModule, entryPoint: "fs_main", targets: [{ format: PICK_ID_FORMAT }] },
      primitive: { topology: "triangle-strip" },
    });

    vbo = device.createBuffer({
      size: capacity * strideBytes,
      usage: GPU_BUFFER_VERTEX | GPU_BUFFER_COPY_DST,
    });
    uniformBuffer = device.createBuffer({
      size: uniformBytes,
      usage: GPU_BUFFER_UNIFORM | GPU_BUFFER_COPY_DST,
    });
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    idTex = null; idView = null; idW = 0; idH = 0;
    picker.ensureBuffers(device);
  }

  function ensureIdTarget() {
    if (idTex && idW === resW && idH === resH) return;
    const device = target.device;
    if (idTex && typeof idTex.destroy === "function") idTex.destroy();
    idTex = device.createTexture({
      size: { width: resW, height: resH },
      format: PICK_ID_FORMAT,
      usage: GPU_TEXTURE_RENDER_ATTACHMENT | GPU_TEXTURE_COPY_SRC,
    });
    idView = idTex.createView();
    idW = resW; idH = resH;
  }

  function writeUniforms(device) {
    const s = uScratch;
    s[0] = resW; s[1] = resH;
    if (isHi) {
      s[2] = camHiX; s[3] = camHiY;
      s[4] = camLoX; s[5] = camLoY;
      s[6] = scaleX; s[7] = scaleY;
      s[8] = ox(); s[9] = oy();
    }
    device.queue.writeBuffer(uniformBuffer, 0, s.buffer, s.byteOffset, uniformBytes);
  }

  function onRebuild() {
    picker.invalidate();
    createResources();
  }
  const sinkEntry = { resize: (w, h) => { resW = w; resH = h; }, __rebuild: onRebuild };

  createResources();
  target.__registerSink(sinkEntry);

  const api = {
    target,
    capacity,
    caps,
    blend: blendMode,   // normalized mode string ("opaque" | "additive" | "alpha"); introspection only

    resize(w, h) { resW = w; resH = h; },

    /** Upload only the dirty float window into the instance buffer (device boundary). */
    upload(data, floatOffset, floatCount) {
      if (target.isContextLost()) return;
      if (floatOffset + floatCount > capacity * stride) {
        throw new RangeError(
          "lite-gl: " + spec.primitive + " upload exceeds sink capacity (" + capacity + " instances). "
          + "Size " + spec.factory + "({ capacity }) to your field's maximum count."
        );
      }
      target.device.queue.writeBuffer(
        vbo, floatOffset * 4, data.buffer, data.byteOffset + floatOffset * 4, floatCount * 4
      );
    },

    /** One instanced draw of a 4-vertex unit primitive for all `count` instances. */
    draw(count) {
      if (target.isContextLost()) return;
      lastCount = count;
      if (count <= 0) return;
      const device = target.device;
      writeUniforms(device);
      // Clear-coordination: the first sink this frame clears the shared canvas, later
      // sinks load onto it -- so a multi-sink scene composites instead of the last sink
      // wiping the others (WebGL2 parity: nothing in draw() clears the canvas).
      target.__acquireColorTarget(frameOut);
      colorAttachment.view = frameOut.view;
      colorAttachment.loadOp = frameOut.first ? "clear" : "load";
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass(passDesc);
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vbo);
      pass.setBindGroup(0, bindGroup);
      if (scissor) pass.setScissorRect(sc.x, sc.y, sc.w, sc.h);
      pass.draw(4, count);
      pass.end();
      submitArray[0] = enc.finish();
      device.queue.submit(submitArray);
    },

    /** Clip draws AND picks to a rect (top-left origin, device px). WebGPU is top-left. */
    setScissor(x, y, w, h) { sc.x = x; sc.y = y; sc.w = w; sc.h = h; scissor = sc; },
    clearScissor() { scissor = null; },

    /** Set the render-pass clear colour (mutates the preallocated clearValue in place). */
    setClearColor(r, g, b, a) { clearValue.r = r; clearValue.g = g; clearValue.b = b; clearValue.a = a; },

    /** Attach/detach an optional lite-profiler-style counters handle (wrapper-swap). */
    setCounters(handle) { installGPUCounters(api, handle, target.isContextLost); },

    onContextRestored(cb) { return target.onContextRestored(cb); },
    isContextLost() { return target.isContextLost(); },

    /**
     * DEFERRED pick. Returns an instance index (>= 0), -1 (confirmed miss), or
     * PICK_PENDING (-2) when the async readback has not resolved. Same signature and
     * fail-closed guards as the WebGL2 sink; the 24-bit id decode and 0xFFFFFF miss
     * sentinel are identical. Poll again (a later frame) to collect the resolved id.
     */
    pick(x, y, count) {
      const n = (count === undefined) ? lastCount : count;
      if (n <= 0) return -1;
      if (n - 1 > PICK_MAX_ID) {
        throw new RangeError(
          "lite-gl: pick over " + n + " instances gives a top index (" + (n - 1) + ") past "
          + "PICK_MAX_ID (" + PICK_MAX_ID + "). The 24-bit id buffer cannot address it without aliasing "
          + "the reserved miss value (0xFFFFFF). Split the field or cap the pickable set."
        );
      }
      if (target.isContextLost()) return PICK_PENDING;
      const px = x | 0, py = y | 0;
      if (px < 0 || py < 0 || px >= resW || py >= resH) return -1;   // OOB never PENDING

      const slots = picker.slots;
      // (3) a resolved result for the SAME request is claimable now.
      for (let i = 0; i < PICK_RING_K; i++) {
        const s = slots[i];
        if (s.resolved && s.x === px && s.y === py && s.count === n) {
          const id = s.id;
          s.resolved = false;   // free the slot
          return id;
        }
      }
      // (4)/(5) find a reusable slot (not in flight); both in flight -> back-pressure.
      let free = -1;
      for (let i = 0; i < PICK_RING_K; i++) {
        if (!slots[i].inFlight) { free = i; break; }
      }
      if (free < 0) return PICK_PENDING;

      const device = target.device;
      ensureIdTarget();
      const s = slots[free];
      s.x = px; s.y = py; s.count = n; s.resolved = false; s.id = -1;

      writeUniforms(device);
      pickAttach.view = idView;
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass(pickPassDesc);
      pass.setPipeline(pickPipeline);
      pass.setVertexBuffer(0, vbo);
      pass.setBindGroup(0, bindGroup);
      if (scissor) pass.setScissorRect(sc.x, sc.y, sc.w, sc.h);
      pass.draw(4, n);
      pass.end();
      pickCopySrc.texture = idTex;
      pickCopySrc.origin.x = px;
      pickCopySrc.origin.y = py;
      pickCopyDst.buffer = s.buffer;
      enc.copyTextureToBuffer(pickCopySrc, pickCopyDst, pickCopySize);
      submitArray[0] = enc.finish();
      device.queue.submit(submitArray);
      s.inFlight = true;
      s.buffer.mapAsync(GPU_BUFFER_MAP_READ).then(s.then, s.thenReject);
      return PICK_PENDING;
    },

    dispose() {
      target.__unregisterSink(sinkEntry);
      picker.dispose();
      if (vbo && typeof vbo.destroy === "function") vbo.destroy();
      if (uniformBuffer && typeof uniformBuffer.destroy === "function") uniformBuffer.destroy();
      if (idTex && typeof idTex.destroy === "function") idTex.destroy();
      vbo = null; uniformBuffer = null; bindGroup = null;
      pipeline = null; pickPipeline = null; idTex = null; idView = null;
    },
  };

  // POINT_HI camera surface, added only to the hi sink (mirrors GLBackend.js semantics).
  if (isHi) {
    api.setCamera = function (x, y, sx, sy, px, py) {
      camHiX = Math.fround(x);
      camHiY = Math.fround(y);
      camLoX = Math.fround(x - camHiX);
      camLoY = Math.fround(y - camHiY);
      if (sx !== undefined) scaleX = sx;
      if (sy !== undefined) scaleY = sy;
      else if (sx !== undefined) scaleY = sx;
      originX = (px === undefined) ? null : px;
      originY = (py === undefined) ? null : py;
    };
    api.getCamera = function () {
      return {
        x: camHiX + camLoX, y: camHiY + camLoY,
        hiX: camHiX, hiY: camHiY, loX: camLoX, loY: camLoY,
        scaleX, scaleY, originX: ox(), originY: oy(),
      };
    };
  }

  // Preallocated pick-pass descriptors (JS-owned; mutated in place, never per call).
  const pickClear = { r: 1, g: 1, b: 1, a: 1 };   // white = miss
  const pickAttach = { view: null, clearValue: pickClear, loadOp: "clear", storeOp: "store" };
  const pickPassDesc = { colorAttachments: [pickAttach] };
  const pickCopySrc = { texture: null, origin: { x: 0, y: 0 } };
  const pickCopyDst = { buffer: null, bytesPerRow: PICK_READBACK_BYTES, rowsPerImage: 1 };
  const pickCopySize = { width: 1, height: 1 };

  const counters0 = opts.counters;
  installGPUCounters(api, counters0 === undefined ? null : counters0, target.isContextLost);
  return api;
}

// === PUBLIC FACTORIES =======================================================

/**
 * WebGPU point sink -- LAYOUT.POINT (stride 8: x, y, size, r, g, b, a, _pad), drawn as
 * instanced unit-quads (size expanded in the vertex shader; round via fragment discard).
 */
export function createGPUPointSink(target, opts) {
  return makeGPUSink(target, opts, {
    factory: "createGPUPointSink",
    primitive: "point",
    stride: 8,
    isHi: false,
    precisionHi: false,
    uniformFloats: 4,     // resolution vec2 (padded to 16 bytes)
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },   // a_pos
      { shaderLocation: 1, offset: 8, format: "float32" },     // a_size
      { shaderLocation: 2, offset: 12, format: "float32x4" },  // a_color
    ],
  });
}

/**
 * WebGPU world-space point sink -- LAYOUT.POINT_HI (stride 10), camera on the GPU with
 * double-emulated precision. precisionHi:true. See POINT_HI_WGSL for the Sterbenz split.
 */
export function createGPUPointHiSink(target, opts) {
  return makeGPUSink(target, opts, {
    factory: "createGPUPointHiSink",
    primitive: "pointHi",
    stride: 10,
    isHi: true,
    precisionHi: true,
    uniformFloats: 12,    // resolution, cameraHi, cameraLo, scale, origin (5 vec2 -> 48 bytes)
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },   // a_posHi
      { shaderLocation: 1, offset: 8, format: "float32x2" },   // a_posLo
      { shaderLocation: 2, offset: 16, format: "float32" },    // a_size
      { shaderLocation: 3, offset: 20, format: "float32x4" },  // a_color
    ],
  });
}

/**
 * WebGPU quad sink -- LAYOUT.QUAD (stride 9: x, y, w, h, rot, r, g, b, a), instanced
 * rotated unit-quads. Bars, sized/rotated markers, heatmap cells.
 */
export function createGPUQuadSink(target, opts) {
  return makeGPUSink(target, opts, {
    factory: "createGPUQuadSink",
    primitive: "quad",
    stride: 9,
    isHi: false,
    precisionHi: false,
    uniformFloats: 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },   // a_pos
      { shaderLocation: 1, offset: 8, format: "float32x2" },   // a_size (w,h)
      { shaderLocation: 2, offset: 16, format: "float32" },    // a_rot
      { shaderLocation: 3, offset: 20, format: "float32x4" },  // a_color
    ],
  });
}

/**
 * WebGPU line sink -- LAYOUT.LINE (stride 9: x0, y0, x1, y1, width, r, g, b, a),
 * instanced butt-capped thick segments expanded from p0/p1 + width in the vertex shader.
 */
export function createGPULineSink(target, opts) {
  return makeGPUSink(target, opts, {
    factory: "createGPULineSink",
    primitive: "line",
    stride: 9,
    isHi: false,
    precisionHi: false,
    uniformFloats: 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },   // a_p0
      { shaderLocation: 1, offset: 8, format: "float32x2" },   // a_p1
      { shaderLocation: 2, offset: 16, format: "float32" },    // a_width
      { shaderLocation: 3, offset: 20, format: "float32x4" },  // a_color
    ],
  });
}
