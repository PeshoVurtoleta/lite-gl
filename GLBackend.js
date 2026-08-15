/**
 * @zakkster/lite-gl -- WebGL2 backend (the GPU `sink`).
 * -----------------------------------------------------------------------------
 * BROWSER-ONLY. This file calls the WebGL2 API (no GPU/context exists in a
 * headless sandbox, so it is NOT covered by the package's node:test suite). It is
 * covered instead by a browser smoke test (test/smoke.html, run by hand in each
 * target browser, and test/smoke.spec.mjs under Playwright in CI) that renders
 * known points and reads pixels back. It implements the `sink` interface the GL.js
 * core flushes to: `upload(data, floatOffset, floatCount, instanceOffset, stride)`
 * and `draw(count)`. Swap this for a WebGPU/canvas sink without touching the core.
 *
 * createPointSink renders the LAYOUT.POINT field (stride 8: x, y, size, r, g, b, a,
 * _pad) as GL_POINTS in one draw call.
 *
 * createQuadSink (v1.1) renders LAYOUT.QUAD (stride 9: x, y, w, h, rot, r, g, b, a)
 * as instanced TRIANGLE_STRIP quads. Uses a static unit-quad base geometry (loc 0,
 * divisor 0) + per-instance attributes (loc 1..4, divisor 1) via vertexAttribDivisor.
 * Same dirty-window upload + context-loss recovery as points. Unlocks bars,
 * scatter markers (sized/rotated), heatmap cells in lite-charts-gl.
 *
 * Positions/sizes expected in SCREEN PIXELS -- project in your reactive `project()`.
 * Shader only does pixel->clip + per-instance transform/rotate.
 *
 * CONTEXT LOSS: both sinks own their own recovery. They listen for
 * webglcontextlost/restored on gl.canvas, no-op draw/upload while lost, and rebuild
 * program + VBO(s) + VAO on restore. The restored GPU buffer is empty, so
 * onContextRestored(cb) lets the driver re-seed it (reactiveField wires
 * field.touchAll() + flush automatically); isContextLost() reflects the state.
 *
 * MIT (c) 2026 Zahary Shinikchiev
 */

const POINT_VS = `#version 300 es
layout(location=0) in vec2 a_pos;     // screen pixels
layout(location=1) in float a_size;   // diameter in pixels
layout(location=2) in vec4 a_color;
uniform vec2 u_resolution;
out vec4 v_color;
void main() {
  vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_size;
  v_color = a_color;
}`;

const POINT_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;        // round the square point sprite
  if (dot(c, c) > 0.25) discard;
  outColor = v_color;
}`;

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 a_local;   // base unit quad vertex (centered -0.5..0.5)
layout(location=1) in vec2 a_pos;     // instance center (screen px)
layout(location=2) in vec2 a_size;    // w, h (pixels)
layout(location=3) in float a_rot;    // rotation radians
layout(location=4) in vec4 a_color;
uniform vec2 u_resolution;
out vec4 v_color;
void main() {
  float c = cos(a_rot);
  float s = sin(a_rot);
  vec2 rot = vec2(
    a_local.x * c - a_local.y * s,
    a_local.x * s + a_local.y * c
  );
  vec2 world = a_pos + rot * a_size;
  vec2 clip = (world / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}`;

const QUAD_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec2 a_ts;      // .x=t (0..1 along segment), .y=s (-1 or +1 side)
layout(location=1) in vec2 a_p0;      // instance start (screen px)
layout(location=2) in vec2 a_p1;      // instance end   (screen px)
layout(location=3) in float a_width;  // thickness in pixels
layout(location=4) in vec4 a_color;
uniform vec2 u_resolution;
out vec4 v_color;

void main() {
  float t = a_ts.x;
  float s = a_ts.y;

  vec2 dir = a_p1 - a_p0;
  float len = length(dir);
  vec2 unitDir = (len > 0.0001) ? (dir / len) : vec2(1.0, 0.0);
  vec2 perp = vec2(-unitDir.y, unitDir.x);   // rotate 90 deg for consistent sides

  vec2 base = mix(a_p0, a_p1, t);
  vec2 offset = s * (a_width * 0.5) * perp;

  vec2 world = base + offset;
  vec2 clip = (world / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}`;

const LINE_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}`;

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error("lite-gl shader compile failed: " + log);
    }
    return sh;
}

function link(gl, vsSrc, fsSrc) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error("lite-gl program link failed: " + log);
    }
    return prog;
}

// === PICK PASS (v1.3) ========================================================
// An offscreen RGBA8 target where each instance is drawn in a flat colour that
// encodes its index (24-bit little-endian). One readPixels of a single pixel
// decodes the instance under the cursor -- no CPU hit-testing, so hover works
// at 1M instances. White (0xFFFFFF) is reserved as "miss" (background).
//
// NOTE: the fragment shader MUST declare `precision highp int`. The default
// integer precision in a fragment shader is mediump, which is only guaranteed
// 16 bits -- ids above 65535 would be truncated.

const PICK_POINT_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
layout(location=1) in float a_size;
uniform vec2 u_resolution;
flat out uint v_id;
void main() {
  vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = max(a_size, 3.0);   // widen the hit area a little
  v_id = uint(gl_VertexID);
}`;

const PICK_QUAD_VS = `#version 300 es
layout(location=0) in vec2 a_local;
layout(location=1) in vec2 a_pos;
layout(location=2) in vec2 a_size;
layout(location=3) in float a_rot;
uniform vec2 u_resolution;
flat out uint v_id;
void main() {
  float c = cos(a_rot);
  float s = sin(a_rot);
  vec2 rot = vec2(a_local.x * c - a_local.y * s, a_local.x * s + a_local.y * c);
  vec2 world = a_pos + rot * a_size;
  vec2 clip = (world / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_id = uint(gl_InstanceID);
}`;

const PICK_LINE_VS = `#version 300 es
layout(location=0) in vec2 a_ts;
layout(location=1) in vec2 a_p0;
layout(location=2) in vec2 a_p1;
layout(location=3) in float a_width;
uniform vec2 u_resolution;
flat out uint v_id;
void main() {
  vec2 dir = a_p1 - a_p0;
  float len = length(dir);
  vec2 unitDir = (len > 0.0001) ? (dir / len) : vec2(1.0, 0.0);
  vec2 perp = vec2(-unitDir.y, unitDir.x);
  vec2 base = mix(a_p0, a_p1, a_ts.x);
  vec2 world = base + a_ts.y * (max(a_width, 4.0) * 0.5) * perp;   // min hit width
  vec2 clip = (world / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_id = uint(gl_InstanceID);
}`;

const PICK_FS = `#version 300 es
precision mediump float;
precision highp int;
flat in uint v_id;
out vec4 outColor;
void main() {
  uint id = v_id;
  outColor = vec4(
    float( id        & 0xFFu) / 255.0,
    float((id >>  8) & 0xFFu) / 255.0,
    float((id >> 16) & 0xFFu) / 255.0,
    1.0);
}`;

// === v1.4.0: POINT_HI -- world coords, GPU camera, double-emulated precision ======
//
// The relative-to-eye subtraction MUST happen before anything else touches the value.
// `a_posHi - u_cameraHi` is a subtraction of two float32s of near-identical magnitude,
// so it cancels EXACTLY (Sterbenz lemma) and the residuals carry the detail. Do it in
// the other order -- scale first, subtract later -- and the precision is already gone.
//
// `precision highp float` is not decoration. It is the default for floats in an ES 3.00
// vertex shader, but stating it makes the requirement explicit: at mediump this whole
// scheme collapses to worse than plain float32.
const POINT_HI_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_posHi;   // world coord, high part
layout(location=1) in vec2 a_posLo;   // world coord, residual
layout(location=2) in float a_size;   // diameter in pixels
layout(location=3) in vec4 a_color;
uniform vec2 u_resolution;
uniform vec2 u_cameraHi;              // eye, split the same way
uniform vec2 u_cameraLo;
uniform vec2 u_scale;                 // world units -> pixels
uniform vec2 u_origin;                // pixel position of the eye
out vec4 v_color;
void main() {
  vec2 rel = (a_posHi - u_cameraHi) + (a_posLo - u_cameraLo);
  vec2 px = rel * u_scale + u_origin;
  vec2 clip = (px / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_size;
  v_color = a_color;
}`;

const PICK_POINT_HI_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_posHi;
layout(location=1) in vec2 a_posLo;
layout(location=2) in float a_size;
uniform vec2 u_resolution;
uniform vec2 u_cameraHi;
uniform vec2 u_cameraLo;
uniform vec2 u_scale;
uniform vec2 u_origin;
flat out uint v_id;
void main() {
  vec2 rel = (a_posHi - u_cameraHi) + (a_posLo - u_cameraLo);
  vec2 px = rel * u_scale + u_origin;
  vec2 clip = (px / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = max(a_size, 3.0);   // widen the hit area a little, matching the POINT pick pass
  v_id = uint(gl_VertexID);
}`;

/**
 * Max pickable instance index: 24-bit space minus the reserved "miss" value.
 *
 * HARD CAP. `draw(count)` renders any count fine -- colour output is unaffected --
 * but the ID buffer encodes instance indices in 24 bits. Valid indices are 0..count-1,
 * so the largest pickable index is PICK_MAX_ID and the largest pickable count is
 * PICK_MAX_ID + 1 (0xFFFFFF instances). `pick()` on a larger field would give a top
 * index at or past the reserved miss (0xFFFFFF), so it throws a RangeError rather than
 * returning a wrong (aliased) instance (fail closed, GL-07). The guard lives in the
 * on-demand pick path, never in the per-frame draw hot body.
 */
export const PICK_MAX_ID = 0xFFFFFE;

/**
 * Frozen sink capability descriptor (v2.0.0 -- the caps seam). The GL-agnostic core
 * (reactiveField -> assertCaps) reads this EXACTLY ONCE at bind, never per frame, and
 * the per-frame closure gains no `caps.*` read. Frozen so a bound field's capabilities
 * cannot mutate under it. `maxInstances` is PICK_MAX_ID + 1 (0xFFFFFF), the largest
 * pickable count. All four WebGL2 sinks advertise `pickMode:"sync"`; only createPointHiSink
 * advertises `precisionHi:true`. Built once per sink on the cold construction path.
 */
function makeCaps(precisionHi) {
    return Object.freeze({
        api: "webgl2",
        instancing: true,
        baseVertex: false,
        maxInstances: PICK_MAX_ID + 1,
        precisionHi: precisionHi,
        pickMode: "sync",
        version: 1,
    });
}

const PROGRAM_SOURCES = {
    point: [POINT_VS, POINT_FS],
    quad: [QUAD_VS, QUAD_FS],
    line: [LINE_VS, LINE_FS],
    pointHi: [POINT_HI_VS, POINT_FS],
    pointPick: [PICK_POINT_VS, PICK_FS],
    pointHiPick: [PICK_POINT_HI_VS, PICK_FS],
    quadPick: [PICK_QUAD_VS, PICK_FS],
    linePick: [PICK_LINE_VS, PICK_FS],
};

// === SHARED PROGRAM CACHE (v1.3) ============================================
// N sinks of the same primitive type in the SAME context share one linked
// program: the first pays the compile/link, the rest reuse it.
//
// Keyed per WebGL2RenderingContext -- a WebGLProgram belongs to the context
// that created it, and using it with another context is an INVALID_OPERATION.
// (A page can easily hold several contexts; the demo has one per scene.)
// Refcounted, so dispose()ing one sink cannot delete a program another still uses.
const programCache = new WeakMap();   // gl -> Map<key, { prog, refs }>

function acquireProgram(gl, key) {
    let byKey = programCache.get(gl);
    if (!byKey) { byKey = new Map(); programCache.set(gl, byKey); }
    let entry = byKey.get(key);
    if (!entry) {
        const src = PROGRAM_SOURCES[key];
        entry = { prog: link(gl, src[0], src[1]), refs: 0 };
        byKey.set(key, entry);
    }
    entry.refs++;
    return entry.prog;
}

function releaseProgram(gl, key) {
    const byKey = programCache.get(gl);
    if (!byKey) return;
    const entry = byKey.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
        gl.deleteProgram(entry.prog);
        byKey.delete(key);
        if (byKey.size === 0) programCache.delete(gl);
    }
}

/** A lost context destroys every program it owns; drop them so we relink on restore. */
function dropProgramCache(gl) { programCache.delete(gl); }

/** Scratch for readPixels -- module-level so pick() allocates nothing. */
const PICK_RGBA = new Uint8Array(4);

/** Lazily-built offscreen ID target for one sink. */
function createPicker(gl, primitive, extraUniforms) {
    const key = primitive + "Pick";
    let fbo = null, tex = null, prog = null, uRes = null, tw = 0, th = 0;
    let extra = null;
    // Reused result object -- ensure() must allocate NOTHING per pick (GL-05): a
    // fresh { prog, uRes, fbo, extra } every call would leak ~50 B onto the heap
    // for every hover pixel. Mutated in place, same reference each call.
    const out = { prog: null, uRes: null, fbo: null, extra: null };
    return {
        key,
        /** After context loss the FBO/texture/program are gone; rebuild on next pick. */
        invalidate() { fbo = null; tex = null; prog = null; tw = 0; th = 0; },
        dispose() {
            if (tex) gl.deleteTexture(tex);
            if (fbo) gl.deleteFramebuffer(fbo);
            tex = null; fbo = null; prog = null;
        },
        ensure(resW, resH, use) {
            if (!prog) {
                prog = use(key);
                uRes = gl.getUniformLocation(prog, "u_resolution");
                if (extraUniforms) {
                    extra = {};
                    for (let i = 0; i < extraUniforms.length; i++) {
                        extra[extraUniforms[i]] = gl.getUniformLocation(prog, extraUniforms[i]);
                    }
                }
            }
            if (!fbo || tw !== resW || th !== resH) {   // (re)size with the canvas
                if (tex) gl.deleteTexture(tex);
                if (fbo) gl.deleteFramebuffer(fbo);
                tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, resW, resH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.bindTexture(gl.TEXTURE_2D, null);
                fbo = gl.createFramebuffer();
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                tw = resW; th = resH;
            }
            out.prog = prog; out.uRes = uRes; out.fbo = fbo; out.extra = extra;
            return out;
        },
        prog() { return prog; },
    };
}

// === COUNTERS SEAM (v1.5.0) ==================================================
// An OPTIONAL, duck-typed draw/upload counters handle -- the shape @zakkster/
// lite-profiler 1.2.0 exposes: { recordUpload(floatCount), recordDraw(drawCount) }.
// lite-profiler stays a PEER/optional integration, never a runtime dependency
// (package.json `dependencies` is empty). A sink records the dirty-window float
// count on each upload and one draw per non-empty draw, passing PRIMITIVE NUMBERS
// only -- no per-call object. When no handle is attached the hot path guards on a
// single truthiness check and allocates nothing, so field.flush stays byte-identical
// to v1.4.1. Validation is fail-closed and runs once, at attach time (cold path):
// a non-null handle missing either method throws with a clear hint.
function validateCounters(handle) {
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

// Per-sink counter wiring, cached so a re-attach never rebuilds the wrappers. The
// no-counters path is the ORIGINAL base upload/draw (byte-identical to v1.4.1): a
// null handle installs the base methods, an attached handle installs thin counting
// wrappers. So `counters === null` adds NO branch to the shared hot path -- the cost
// lives only while a handle is attached, and only on the public upload()/draw(). A
// pick()'s internal ID render calls gl.drawArrays directly (never sink.draw), so a
// pick can never touch the counters.
const _sinkCounters = new WeakMap();   // api -> { base*, count*, h }

function installCounters(api, handle, isLost) {
    const counters = validateCounters(handle);
    let rec = _sinkCounters.get(api);
    if (!rec) {
        const baseUpload = api.upload;   // the byte-identical v1.4.1 method
        const baseDraw = api.draw;
        rec = {
            baseUpload, baseDraw, h: counters,
            countUpload(data, floatOffset, floatCount) {
                baseUpload(data, floatOffset, floatCount);
                if (!isLost()) rec.h.recordUpload(floatCount);   // only if actually uploaded
            },
            countDraw(count) {
                baseDraw(count);
                if (!isLost() && count > 0) rec.h.recordDraw(1); // one GPU draw per non-empty draw
            },
        };
        _sinkCounters.set(api, rec);
    }
    rec.h = counters;
    api.upload = counters ? rec.countUpload : rec.baseUpload;
    api.draw = counters ? rec.countDraw : rec.baseDraw;
    return counters;
}

/** Apply a top-left-origin scissor rect. GL's scissor origin is bottom-left. */
function applyScissor(gl, sc, resH) {
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(sc.x, resH - sc.y - sc.h, sc.w, sc.h);
}

/**
 * Render the field into the ID target and read back one pixel.
 * Restores the sink's default draw framebuffer, its clear colour and the blend
 * state -- a pick must never disturb the visible frame.
 *
 * ZERO ALLOCATION (GL-05). The old path called
 * `gl.getParameter(gl.COLOR_CLEAR_VALUE)`, which returns a FRESH `Float32Array(4)`
 * every call -- ~60 heap allocs/sec while a pointer hovers. The clear colour is now
 * restored from the sink's own JS mirror (`clearRGBA`, which the sink owns via
 * `setClearColor`); the default draw target is the canvas (null); and blend is read
 * through the non-allocating `isEnabled` boolean. No allocating GL getter remains.
 *
 * HARD CAP (GL-07). Valid instance indices are 0..count-1; the top index must stay
 * <= PICK_MAX_ID (0xFFFFFE) to remain distinct from the reserved miss value
 * (0xFFFFFF). So a count of PICK_MAX_ID + 1 (top index == PICK_MAX_ID) is still
 * valid; only a larger count -- whose top index would reach or pass the miss
 * sentinel -- fails closed, rather than returning a wrong (aliased) instance.
 */
function pickAt(gl, picker, use, vao, primitive, resW, resH, count, px, py, sc, applyExtra, clearRGBA) {
    if (count <= 0) return -1;
    if (count - 1 > PICK_MAX_ID) {   // top index (count-1) would reach/pass the miss sentinel
        throw new RangeError(
            "lite-gl: pick over " + count + " instances gives a top index (" + (count - 1) + ") past "
            + "PICK_MAX_ID (" + PICK_MAX_ID + "). The 24-bit ID buffer cannot address it without aliasing "
            + "the reserved miss value (0xFFFFFF). Split the field or cap the pickable set."
        );
    }
    px = px | 0; py = py | 0;
    if (px < 0 || py < 0 || px >= resW || py >= resH) return -1;

    const t = picker.ensure(resW, resH, use);

    // No allocating getParameter: blend is a boolean, the default draw target is the
    // canvas (null), and the clear colour comes from the sink's JS mirror.
    const blendOn = gl.isEnabled(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, resW, resH);
    // IDs are bit patterns, not colours: blending them would corrupt the readback.
    if (blendOn) gl.disable(gl.BLEND);
    gl.clearColor(1, 1, 1, 1);            // white = miss
    gl.clear(gl.COLOR_BUFFER_BIT);        // clear the WHOLE target first...

    if (sc) applyScissor(gl, sc, resH);   // ...then clip the draw to the pane
    gl.useProgram(t.prog);
    gl.uniform2f(t.uRes, resW, resH);
    // The ID pass must project through EXACTLY the same camera as the visible pass, or
    // the pixel you read back belongs to a different instance than the one you see.
    if (applyExtra) applyExtra(t.extra);
    gl.bindVertexArray(vao);
    if (primitive === "point" || primitive === "pointHi") gl.drawArrays(gl.POINTS, 0, count);
    else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
    if (sc) gl.disable(gl.SCISSOR_TEST);

    gl.readPixels(px, resH - py - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, PICK_RGBA);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);   // the sink draws to the default framebuffer (the canvas)
    gl.viewport(0, 0, resW, resH);
    gl.clearColor(clearRGBA[0], clearRGBA[1], clearRGBA[2], clearRGBA[3]);
    if (blendOn) gl.enable(gl.BLEND);

    const r = PICK_RGBA[0], g = PICK_RGBA[1], b = PICK_RGBA[2];
    if (r === 255 && g === 255 && b === 255) return -1;
    return r | (g << 8) | (b << 16);
}

const POINT_STRIDE = 8;
const POINT_STRIDE_BYTES = POINT_STRIDE * 4;

/**
 * @param {WebGL2RenderingContext} gl
 * @param {{ capacity: number }} opts  max points (sizes the VBO once).
 * @returns {object} sink: { upload, draw, resize, onContextRestored, isContextLost, dispose, gl }
 */
export function createPointSink(gl, opts) {
    const capacity = opts.capacity;
    const caps = makeCaps(false);
    const canvas = gl.canvas;

    let program = null, uResolution = null, vao = null, vbo = null;
    let resW = gl.drawingBufferWidth, resH = gl.drawingBufferHeight;
    let lost = false;
    let scissor = null, lastCount = 0;
    const sc = { x: 0, y: 0, w: 0, h: 0 };   // reused -- setScissor allocates nothing
    // The clear colour the pick pass restores after its offscreen ID render. The
    // sink owns this write (setClearColor), so pick reads no allocating GL getter.
    const clearRGBA = [0, 0, 0, 0];   // default (0,0,0,0), the GL default clear colour; plain array preserves the app value exactly
    const heldKeys = new Set();
    const use = (key) => { heldKeys.add(key); return acquireProgram(gl, key); };
    const picker = createPicker(gl, "point");
    const restoreCbs = [];
    // Optional lite-profiler-style draw/upload counters (v1.5.0). Null unless attached;
    // the hot path guards on a single truthiness check and allocates nothing.
    let counters = validateCounters(opts.counters);

    function createResources() {
        program = use("point");
        uResolution = gl.getUniformLocation(program, "u_resolution");
        vao = gl.createVertexArray();
        vbo = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, capacity * POINT_STRIDE_BYTES, gl.DYNAMIC_DRAW);
        // a_pos (vec2 @ 0), a_size (float @ 8), a_color (vec4 @ 12)
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, POINT_STRIDE_BYTES, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, POINT_STRIDE_BYTES, 8);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, POINT_STRIDE_BYTES, 12);
        gl.bindVertexArray(null);
        gl.viewport(0, 0, resW, resH);
    }

    function onLost(e) {
        e.preventDefault();
        lost = true;
        dropProgramCache(gl);   // every program in this context is gone
        picker.invalidate();
    }
    function onRestored() {
        createResources();
        lost = false;
        for (let i = 0; i < restoreCbs.length; i++) restoreCbs[i]();
    }

    const canListen = canvas && typeof canvas.addEventListener === "function";
    if (canListen) {
        canvas.addEventListener("webglcontextlost", onLost, false);
        canvas.addEventListener("webglcontextrestored", onRestored, false);
    }

    createResources();

    const api = {
        gl,
        capacity,
        caps,
        resize(w, h) {
            resW = w; resH = h;
            if (!lost) gl.viewport(0, 0, w, h);
        },
        upload(data, floatOffset, floatCount) {
            if (lost) return;
            if (floatOffset + floatCount > capacity * POINT_STRIDE) {
                throw new RangeError("lite-gl: point upload exceeds sink capacity (" + capacity + " points). "
                    + "Size createPointSink({ capacity }) to your field's maximum count.");
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferSubData(gl.ARRAY_BUFFER, floatOffset * 4, data, floatOffset, floatCount);
        },
        draw(count) {
            if (lost) return;
            lastCount = count;
            if (count <= 0) return;
            gl.useProgram(program);
            gl.uniform2f(uResolution, resW, resH);
            gl.bindVertexArray(vao);
            if (scissor) applyScissor(gl, scissor, resH);
            gl.drawArrays(gl.POINTS, 0, count);
            if (scissor) gl.disable(gl.SCISSOR_TEST);
            gl.bindVertexArray(null);
        },
        /** Clip draws AND picks to a rect (top-left origin, device px). One pane of a multi-pane chart. */
        setScissor(x, y, w, h) { sc.x = x; sc.y = y; sc.w = w; sc.h = h; scissor = sc; },
        /** Draw to the whole viewport again. */
        clearScissor() { scissor = null; },
        /**
         * Set the clear colour, owning the write so pick() can restore it without an
         * allocating getParameter. Applies it now; pass your app's clear colour here
         * (default is 0,0,0,0) if you want a pick to leave it untouched.
         */
        setClearColor(r, g, b, a) { clearRGBA[0] = r; clearRGBA[1] = g; clearRGBA[2] = b; clearRGBA[3] = a; gl.clearColor(r, g, b, a); },
        /**
         * Instance index under (x, y) -- device px, top-left origin -- or -1 for a miss.
         * Renders one ID pass offscreen and reads back a single pixel: no CPU hit-testing,
         * so this is O(1) on the CPU even at 1M instances. Defaults to the count last drawn.
         * Call it on demand (a throttled pointermove), never every frame.
         */
        pick(x, y, count) {
            const n = (count === undefined) ? lastCount : count;
            return pickAt(gl, picker, use, vao, "point", resW, resH, n, x, y, scissor, undefined, clearRGBA);
        },
        /**
         * Attach (or detach with null) an optional lite-profiler-style counters handle
         * { recordUpload(floatCount), recordDraw(drawCount) }. Zero runtime dep; the sink
         * records the dirty-window float count per upload and one draw per non-empty draw.
         * Zero-overhead when unset: swaps the counting wrappers in, so the no-counters
         * upload/draw stay byte-identical to v1.4.1 -- no branch on the shared hot path.
         */
        setCounters(handle) { counters = installCounters(api, handle); },
        onContextRestored(cb) {
            restoreCbs.push(cb);
            return () => { const i = restoreCbs.indexOf(cb); if (i >= 0) restoreCbs.splice(i, 1); };
        },
        isContextLost() { return lost; },
        dispose() {
            if (canListen) {
                canvas.removeEventListener("webglcontextlost", onLost, false);
                canvas.removeEventListener("webglcontextrestored", onRestored, false);
            }
            if (vbo) gl.deleteBuffer(vbo);
            if (vao) gl.deleteVertexArray(vao);
            picker.dispose();
            // Programs are shared: release our refs; the cache deletes at zero.
            for (const k of heldKeys) releaseProgram(gl, k);
            heldKeys.clear();
        },
    };
    const isLost = () => lost;
    counters = installCounters(api, counters, isLost);
    return api;
}

const POINT_HI_STRIDE = 10;
const POINT_HI_STRIDE_BYTES = POINT_HI_STRIDE * 4;

/**
 * createPointHiSink (v1.4.0) -- LAYOUT.POINT_HI: WORLD coordinates, camera on the GPU.
 *
 * The other sinks take screen pixels: `project()` bakes the camera in on the CPU, so a
 * pan re-projects every instance and re-uploads the dirty range. At 1M points that is
 * ~5 ms of JS and a 31 MB upload -- per frame, for a camera that moved one pixel.
 *
 * This sink takes world coordinates instead, uploaded once, and applies the camera in the
 * vertex shader. A pan or zoom is `setCamera(...)`: four floats of uniform, no CPU work,
 * no upload. Coordinates are double-emulated (hi/lo float32 pair) so epoch-millisecond
 * timestamps survive -- a plain float32 world coord would quantize a whole minute of
 * one-second ticks onto a single value.
 *
 * Write instances with `writePointHi()` from GL.js; it does the split for you.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {{ capacity: number }} opts  max points (sizes the VBO once).
 */
export function createPointHiSink(gl, opts) {
    const capacity = opts.capacity;
    const caps = makeCaps(true);
    const canvas = gl.canvas;

    let program = null, vao = null, vbo = null;
    let uResolution = null, uCameraHi = null, uCameraLo = null, uScale = null, uOrigin = null;
    let resW = gl.drawingBufferWidth, resH = gl.drawingBufferHeight;
    let lost = false;
    let scissor = null, lastCount = 0;
    const sc = { x: 0, y: 0, w: 0, h: 0 };
    // Clear-colour mirror owned by the sink so pick() restores it with no allocating getter.
    const clearRGBA = [0, 0, 0, 0];   // default (0,0,0,0); plain array preserves the app value exactly
    const heldKeys = new Set();
    const use = (key) => { heldKeys.add(key); return acquireProgram(gl, key); };
    const picker = createPicker(gl, "pointHi", ["u_cameraHi", "u_cameraLo", "u_scale", "u_origin"]);
    const restoreCbs = [];
    // Optional lite-profiler-style draw/upload counters (v1.5.0). Null unless attached.
    let counters = validateCounters(opts.counters);

    // Camera state. Split on the CPU in float64, uploaded as four float32s.
    // Origin defaults to the canvas centre; null means "recompute on resize".
    let camHiX = 0, camHiY = 0, camLoX = 0, camLoY = 0;
    let scaleX = 1, scaleY = 1;
    let originX = null, originY = null;

    function createResources() {
        program = use("pointHi");
        uResolution = gl.getUniformLocation(program, "u_resolution");
        uCameraHi = gl.getUniformLocation(program, "u_cameraHi");
        uCameraLo = gl.getUniformLocation(program, "u_cameraLo");
        uScale = gl.getUniformLocation(program, "u_scale");
        uOrigin = gl.getUniformLocation(program, "u_origin");

        vao = gl.createVertexArray();
        vbo = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, capacity * POINT_HI_STRIDE_BYTES, gl.DYNAMIC_DRAW);
        // a_posHi (vec2 @0), a_posLo (vec2 @8), a_size (float @16), a_color (vec4 @20)
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, POINT_HI_STRIDE_BYTES, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, POINT_HI_STRIDE_BYTES, 8);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 1, gl.FLOAT, false, POINT_HI_STRIDE_BYTES, 16);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 4, gl.FLOAT, false, POINT_HI_STRIDE_BYTES, 20);
        gl.bindVertexArray(null);
        gl.viewport(0, 0, resW, resH);
    }

    function onLost(e) {
        e.preventDefault();
        lost = true;
        dropProgramCache(gl);
        picker.invalidate();
    }
    function onRestored() {
        createResources();
        lost = false;
        for (let i = 0; i < restoreCbs.length; i++) restoreCbs[i]();
    }

    const canListen = canvas && typeof canvas.addEventListener === "function";
    if (canListen) {
        canvas.addEventListener("webglcontextlost", onLost, false);
        canvas.addEventListener("webglcontextrestored", onRestored, false);
    }

    createResources();

    const ox = () => (originX === null ? resW * 0.5 : originX);
    const oy = () => (originY === null ? resH * 0.5 : originY);

    /** Push the camera into a program's uniforms. Shared by the visible and ID passes. */
    function setCameraUniforms(uHi, uLo, uSc, uOr) {
        gl.uniform2f(uHi, camHiX, camHiY);
        gl.uniform2f(uLo, camLoX, camLoY);
        gl.uniform2f(uSc, scaleX, scaleY);
        gl.uniform2f(uOr, ox(), oy());
    }

    const applyPickCamera = (extra) => {
        setCameraUniforms(extra.u_cameraHi, extra.u_cameraLo, extra.u_scale, extra.u_origin);
    };

    const api = {
        gl,
        capacity,
        caps,

        /**
         * Move the camera. Zero allocation, zero upload -- this is the whole point of the
         * layout. `x`/`y` are float64 WORLD coordinates (a raw epoch-ms timestamp is fine);
         * they are split hi/lo here, in float64, before they ever touch a float32.
         *
         * @param {number} x  world x at the eye
         * @param {number} y  world y at the eye
         * @param {number} [sx=1] world x units -> pixels
         * @param {number} [sy=sx] world y units -> pixels
         * @param {number} [px] pixel x of the eye (default: canvas centre)
         * @param {number} [py] pixel y of the eye (default: canvas centre)
         */
        setCamera(x, y, sx, sy, px, py) {
            camHiX = Math.fround(x);
            camHiY = Math.fround(y);
            camLoX = Math.fround(x - camHiX);
            camLoY = Math.fround(y - camHiY);
            if (sx !== undefined) scaleX = sx;
            if (sy !== undefined) scaleY = sy;
            else if (sx !== undefined) scaleY = sx;
            originX = (px === undefined) ? null : px;
            originY = (py === undefined) ? null : py;
        },

        /** Current camera, for tests and debugging. Allocates -- do not call per frame. */
        getCamera() {
            return {
                x: camHiX + camLoX, y: camHiY + camLoY,
                hiX: camHiX, hiY: camHiY, loX: camLoX, loY: camLoY,
                scaleX, scaleY, originX: ox(), originY: oy(),
            };
        },

        resize(w, h) {
            resW = w; resH = h;
            if (!lost) gl.viewport(0, 0, w, h);
        },

        upload(data, floatOffset, floatCount) {
            if (lost) return;
            if (floatOffset + floatCount > capacity * POINT_HI_STRIDE) {
                throw new RangeError("lite-gl: point_hi upload exceeds sink capacity (" + capacity + " points). "
                    + "Size createPointHiSink({ capacity }) to your field's maximum count.");
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferSubData(gl.ARRAY_BUFFER, floatOffset * 4, data, floatOffset, floatCount);
        },

        draw(count) {
            if (lost) return;
            lastCount = count;
            if (count <= 0) return;
            gl.useProgram(program);
            gl.uniform2f(uResolution, resW, resH);
            setCameraUniforms(uCameraHi, uCameraLo, uScale, uOrigin);
            gl.bindVertexArray(vao);
            if (scissor) applyScissor(gl, scissor, resH);
            gl.drawArrays(gl.POINTS, 0, count);
            if (scissor) gl.disable(gl.SCISSOR_TEST);
            gl.bindVertexArray(null);
        },

        setScissor(x, y, w, h) { sc.x = x; sc.y = y; sc.w = w; sc.h = h; scissor = sc; },
        clearScissor() { scissor = null; },

        /** Set the clear colour, owning the write so pick() restores it with no allocating getter. */
        setClearColor(r, g, b, a) { clearRGBA[0] = r; clearRGBA[1] = g; clearRGBA[2] = b; clearRGBA[3] = a; gl.clearColor(r, g, b, a); },

        /** Instance index under (x, y) -- device px, top-left origin -- or -1. */
        pick(x, y, count) {
            const n = (count === undefined) ? lastCount : count;
            return pickAt(gl, picker, use, vao, "pointHi", resW, resH, n, x, y, scissor, applyPickCamera, clearRGBA);
        },

        /** Attach (or detach with null) an optional lite-profiler-style counters handle
         *  { recordUpload(floatCount), recordDraw(drawCount) }. Zero runtime dep; the
         *  no-counters upload/draw stay byte-identical to v1.4.1 (swap, not a branch). */
        setCounters(handle) { counters = installCounters(api, handle); },

        onContextRestored(cb) {
            restoreCbs.push(cb);
            return () => { const i = restoreCbs.indexOf(cb); if (i >= 0) restoreCbs.splice(i, 1); };
        },
        isContextLost() { return lost; },
        dispose() {
            if (canListen) {
                canvas.removeEventListener("webglcontextlost", onLost, false);
                canvas.removeEventListener("webglcontextrestored", onRestored, false);
            }
            if (vbo) gl.deleteBuffer(vbo);
            if (vao) gl.deleteVertexArray(vao);
            picker.dispose();
            for (const k of heldKeys) releaseProgram(gl, k);
            heldKeys.clear();
        },
    };
    const isLost = () => lost;
    counters = installCounters(api, counters, isLost);
    return api;
}

const QUAD_STRIDE = 9;
const QUAD_STRIDE_BYTES = QUAD_STRIDE * 4;

const UNIT_QUAD = new Float32Array([
  -0.5, -0.5,
   0.5, -0.5,
  -0.5,  0.5,
   0.5,  0.5
]);

/**
 * createQuadSink: instanced unit quad pipeline (v1.1).
 * Uses LAYOUT.QUAD stride-9 instances (x,y,w,h,rot,rgba) + static base geometry.
 * Same dirty-window discipline and context-loss handling as POINT sink.
 * Gate: 1M-instance flat-counter test (core already passes via createField + reactiveField).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {{ capacity: number }} opts
 * @returns {object} QuadSink
 */
export function createQuadSink(gl, opts) {
    const capacity = opts.capacity;
    const caps = makeCaps(false);
    const canvas = gl.canvas;

    let program = null, uResolution = null, vao = null;
    let baseVbo = null, instanceVbo = null;
    let resW = gl.drawingBufferWidth, resH = gl.drawingBufferHeight;
    let lost = false;
    let scissor = null, lastCount = 0;
    const sc = { x: 0, y: 0, w: 0, h: 0 };   // reused -- setScissor allocates nothing
    // Clear-colour mirror owned by the sink so pick() restores it with no allocating getter.
    const clearRGBA = [0, 0, 0, 0];   // default (0,0,0,0); plain array preserves the app value exactly
    const heldKeys = new Set();
    const use = (key) => { heldKeys.add(key); return acquireProgram(gl, key); };
    const picker = createPicker(gl, "quad");
    const restoreCbs = [];
    // Optional lite-profiler-style draw/upload counters (v1.5.0). Null unless attached.
    let counters = validateCounters(opts.counters);

    function createResources() {
        program = use("quad");
        uResolution = gl.getUniformLocation(program, "u_resolution");

        vao = gl.createVertexArray();
        baseVbo = gl.createBuffer();
        instanceVbo = gl.createBuffer();

        gl.bindVertexArray(vao);

        // Static base geometry (unit quad, centered). Divisor 0 (default).
        gl.bindBuffer(gl.ARRAY_BUFFER, baseVbo);
        gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        // vertexAttribDivisor(0, 0) is default -- advances per-vertex

        // Per-instance data VBO (dirty uploads go here). Divisor 1 for all attrs.
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceVbo);
        gl.bufferData(gl.ARRAY_BUFFER, capacity * QUAD_STRIDE_BYTES, gl.DYNAMIC_DRAW);

        // loc1: a_pos (vec2)
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, QUAD_STRIDE_BYTES, 0);
        gl.vertexAttribDivisor(1, 1);

        // loc2: a_size (vec2 w,h)
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, QUAD_STRIDE_BYTES, 8);
        gl.vertexAttribDivisor(2, 1);

        // loc3: a_rot (float)
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 1, gl.FLOAT, false, QUAD_STRIDE_BYTES, 16);
        gl.vertexAttribDivisor(3, 1);

        // loc4: a_color (vec4)
        gl.enableVertexAttribArray(4);
        gl.vertexAttribPointer(4, 4, gl.FLOAT, false, QUAD_STRIDE_BYTES, 20);
        gl.vertexAttribDivisor(4, 1);

        gl.bindVertexArray(null);
        gl.viewport(0, 0, resW, resH);
    }

    function onLost(e) {
        e.preventDefault();
        lost = true;
        dropProgramCache(gl);   // every program in this context is gone
        picker.invalidate();
    }
    function onRestored() {
        createResources();
        lost = false;
        for (let i = 0; i < restoreCbs.length; i++) restoreCbs[i]();
    }

    const canListen = canvas && typeof canvas.addEventListener === "function";
    if (canListen) {
        canvas.addEventListener("webglcontextlost", onLost, false);
        canvas.addEventListener("webglcontextrestored", onRestored, false);
    }

    createResources();

    const api = {
        gl,
        capacity,
        caps,
        /** Match the viewport (call on canvas resize). */
        resize(w, h) {
            resW = w; resH = h;
            if (!lost) gl.viewport(0, 0, w, h);
        },
        /** Upload only the dirty float window into the *instance* VBO. */
        upload(data, floatOffset, floatCount) {
            if (lost) return;
            if (floatOffset + floatCount > capacity * QUAD_STRIDE) {
                throw new RangeError("lite-gl: quad upload exceeds sink capacity (" + capacity + " quads). "
                    + "Size createQuadSink({ capacity }) to your field's maximum count.");
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, instanceVbo);
            gl.bufferSubData(gl.ARRAY_BUFFER, floatOffset * 4, data, floatOffset, floatCount);
        },
        /** One instanced draw call for all `count` quads. */
        draw(count) {
            if (lost) return;
            lastCount = count;
            if (count <= 0) return;
            gl.useProgram(program);
            gl.uniform2f(uResolution, resW, resH);
            gl.bindVertexArray(vao);
            if (scissor) applyScissor(gl, scissor, resH);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
            if (scissor) gl.disable(gl.SCISSOR_TEST);
            gl.bindVertexArray(null);
        },
        /** Clip draws AND picks to a rect (top-left origin, device px). One pane of a multi-pane chart. */
        setScissor(x, y, w, h) { sc.x = x; sc.y = y; sc.w = w; sc.h = h; scissor = sc; },
        /** Draw to the whole viewport again. */
        clearScissor() { scissor = null; },
        /** Set the clear colour, owning the write so pick() restores it with no allocating getter. */
        setClearColor(r, g, b, a) { clearRGBA[0] = r; clearRGBA[1] = g; clearRGBA[2] = b; clearRGBA[3] = a; gl.clearColor(r, g, b, a); },
        /**
         * Instance index under (x, y) -- device px, top-left origin -- or -1 for a miss.
         * Renders one ID pass offscreen and reads back a single pixel: no CPU hit-testing,
         * so this is O(1) on the CPU even at 1M instances. Defaults to the count last drawn.
         * Call it on demand (a throttled pointermove), never every frame.
         */
        pick(x, y, count) {
            const n = (count === undefined) ? lastCount : count;
            return pickAt(gl, picker, use, vao, "quad", resW, resH, n, x, y, scissor, undefined, clearRGBA);
        },
        /** Attach (or detach with null) an optional lite-profiler-style counters handle
         *  { recordUpload(floatCount), recordDraw(drawCount) }. Zero runtime dep; the
         *  no-counters upload/draw stay byte-identical to v1.4.1 (swap, not a branch). */
        setCounters(handle) { counters = installCounters(api, handle); },
        onContextRestored(cb) {
            restoreCbs.push(cb);
            return () => { const i = restoreCbs.indexOf(cb); if (i >= 0) restoreCbs.splice(i, 1); };
        },
        isContextLost() { return lost; },
        dispose() {
            if (canListen) {
                canvas.removeEventListener("webglcontextlost", onLost, false);
                canvas.removeEventListener("webglcontextrestored", onRestored, false);
            }
            if (baseVbo) gl.deleteBuffer(baseVbo);
            if (instanceVbo) gl.deleteBuffer(instanceVbo);
            if (vao) gl.deleteVertexArray(vao);
            picker.dispose();
            // Programs are shared: release our refs; the cache deletes at zero.
            for (const k of heldKeys) releaseProgram(gl, k);
            heldKeys.clear();
        },
    };
    const isLost = () => lost;
    counters = installCounters(api, counters, isLost);
    return api;
}

const LINE_STRIDE = 9;
const LINE_STRIDE_BYTES = LINE_STRIDE * 4;

// Static base geometry: 4 corner descriptors (t along segment, s = which side).
const UNIT_LINE = new Float32Array([
    0, -1,   // t=0 (p0), s=-1
    0,  1,   // t=0 (p0), s=+1
    1, -1,   // t=1 (p1), s=-1
    1,  1    // t=1 (p1), s=+1
]);

/**
 * createLineSink: instanced thick-segment pipeline (v1.2, browser-only).
 * Each instance is one butt-capped thick line segment (x0,y0,x1,y1,width,rgba),
 * matching LAYOUT.LINE (stride 9). A static 4-vertex base (t,s descriptors) is
 * expanded into a screen-space quad in the vertex shader from p0/p1 + width;
 * per-instance attributes use vertexAttribDivisor(1). One instanced
 * TRIANGLE_STRIP draw for the whole set. Same dirty-window upload and
 * context-loss discipline as POINT/QUAD.
 *
 * Endpoints and width are in screen pixels -- do world->screen in `project`.
 * Butt caps only in 1.2 (ends cut perpendicular at p0/p1); a polyline is N-1
 * independent segments. Round joins are deferred to 1.3.
 */
export function createLineSink(gl, opts) {
    const capacity = opts.capacity;
    const caps = makeCaps(false);
    const canvas = gl.canvas;

    let program = null, uResolution = null, vao = null;
    let baseVbo = null, instanceVbo = null;
    let resW = gl.drawingBufferWidth, resH = gl.drawingBufferHeight;
    let lost = false;
    let scissor = null, lastCount = 0;
    const sc = { x: 0, y: 0, w: 0, h: 0 };   // reused -- setScissor allocates nothing
    // Clear-colour mirror owned by the sink so pick() restores it with no allocating getter.
    const clearRGBA = [0, 0, 0, 0];   // default (0,0,0,0); plain array preserves the app value exactly
    const heldKeys = new Set();
    const use = (key) => { heldKeys.add(key); return acquireProgram(gl, key); };
    const picker = createPicker(gl, "line");
    const restoreCbs = [];
    // Optional lite-profiler-style draw/upload counters (v1.5.0). Null unless attached.
    let counters = validateCounters(opts.counters);

    function createResources() {
        program = use("line");
        uResolution = gl.getUniformLocation(program, "u_resolution");

        vao = gl.createVertexArray();
        baseVbo = gl.createBuffer();
        instanceVbo = gl.createBuffer();

        gl.bindVertexArray(vao);

        // Static base geometry (t,s corner descriptors). Divisor 0 (default).
        gl.bindBuffer(gl.ARRAY_BUFFER, baseVbo);
        gl.bufferData(gl.ARRAY_BUFFER, UNIT_LINE, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        // vertexAttribDivisor(0, 0) is default -- advances per-vertex

        // Per-instance data VBO (dirty uploads go here). Divisor 1 for all attrs.
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceVbo);
        gl.bufferData(gl.ARRAY_BUFFER, capacity * LINE_STRIDE_BYTES, gl.DYNAMIC_DRAW);

        // loc1: a_p0 (vec2)
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, LINE_STRIDE_BYTES, 0);
        gl.vertexAttribDivisor(1, 1);

        // loc2: a_p1 (vec2)
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, LINE_STRIDE_BYTES, 8);
        gl.vertexAttribDivisor(2, 1);

        // loc3: a_width (float)
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 1, gl.FLOAT, false, LINE_STRIDE_BYTES, 16);
        gl.vertexAttribDivisor(3, 1);

        // loc4: a_color (vec4)
        gl.enableVertexAttribArray(4);
        gl.vertexAttribPointer(4, 4, gl.FLOAT, false, LINE_STRIDE_BYTES, 20);
        gl.vertexAttribDivisor(4, 1);

        gl.bindVertexArray(null);
        gl.viewport(0, 0, resW, resH);
    }

    function onLost(e) {
        e.preventDefault();
        lost = true;
        dropProgramCache(gl);   // every program in this context is gone
        picker.invalidate();
    }
    function onRestored() {
        createResources();
        lost = false;
        for (let i = 0; i < restoreCbs.length; i++) restoreCbs[i]();
    }

    const canListen = canvas && typeof canvas.addEventListener === "function";
    if (canListen) {
        canvas.addEventListener("webglcontextlost", onLost, false);
        canvas.addEventListener("webglcontextrestored", onRestored, false);
    }

    createResources();

    const api = {
        gl,
        capacity,
        caps,
        /** Match the viewport (call on canvas resize). */
        resize(w, h) {
            resW = w; resH = h;
            if (!lost) gl.viewport(0, 0, w, h);
        },
        /** Upload only the dirty float window into the *instance* VBO. */
        upload(data, floatOffset, floatCount) {
            if (lost) return;
            if (floatOffset + floatCount > capacity * LINE_STRIDE) {
                throw new RangeError("lite-gl: line upload exceeds sink capacity (" + capacity + " lines). "
                    + "Size createLineSink({ capacity }) to your field's maximum count.");
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, instanceVbo);
            gl.bufferSubData(gl.ARRAY_BUFFER, floatOffset * 4, data, floatOffset, floatCount);
        },
        /** One instanced draw call for all `count` segments. */
        draw(count) {
            if (lost) return;
            lastCount = count;
            if (count <= 0) return;
            gl.useProgram(program);
            gl.uniform2f(uResolution, resW, resH);
            gl.bindVertexArray(vao);
            if (scissor) applyScissor(gl, scissor, resH);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
            if (scissor) gl.disable(gl.SCISSOR_TEST);
            gl.bindVertexArray(null);
        },
        /** Clip draws AND picks to a rect (top-left origin, device px). One pane of a multi-pane chart. */
        setScissor(x, y, w, h) { sc.x = x; sc.y = y; sc.w = w; sc.h = h; scissor = sc; },
        /** Draw to the whole viewport again. */
        clearScissor() { scissor = null; },
        /** Set the clear colour, owning the write so pick() restores it with no allocating getter. */
        setClearColor(r, g, b, a) { clearRGBA[0] = r; clearRGBA[1] = g; clearRGBA[2] = b; clearRGBA[3] = a; gl.clearColor(r, g, b, a); },
        /**
         * Instance index under (x, y) -- device px, top-left origin -- or -1 for a miss.
         * Renders one ID pass offscreen and reads back a single pixel: no CPU hit-testing,
         * so this is O(1) on the CPU even at 1M instances. Defaults to the count last drawn.
         * Call it on demand (a throttled pointermove), never every frame.
         */
        pick(x, y, count) {
            const n = (count === undefined) ? lastCount : count;
            return pickAt(gl, picker, use, vao, "line", resW, resH, n, x, y, scissor, undefined, clearRGBA);
        },
        /** Attach (or detach with null) an optional lite-profiler-style counters handle
         *  { recordUpload(floatCount), recordDraw(drawCount) }. Zero runtime dep; the
         *  no-counters upload/draw stay byte-identical to v1.4.1 (swap, not a branch). */
        setCounters(handle) { counters = installCounters(api, handle); },
        onContextRestored(cb) {
            restoreCbs.push(cb);
            return () => { const i = restoreCbs.indexOf(cb); if (i >= 0) restoreCbs.splice(i, 1); };
        },
        isContextLost() { return lost; },
        dispose() {
            if (canListen) {
                canvas.removeEventListener("webglcontextlost", onLost, false);
                canvas.removeEventListener("webglcontextrestored", onRestored, false);
            }
            if (baseVbo) gl.deleteBuffer(baseVbo);
            if (instanceVbo) gl.deleteBuffer(instanceVbo);
            if (vao) gl.deleteVertexArray(vao);
            picker.dispose();
            // Programs are shared: release our refs; the cache deletes at zero.
            for (const k of heldKeys) releaseProgram(gl, k);
            heldKeys.clear();
        },
    };
    const isLost = () => lost;
    counters = installCounters(api, counters, isLost);
    return api;
}
