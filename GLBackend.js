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

/** Max pickable instance index: 24-bit space minus the reserved "miss" value. */
export const PICK_MAX_ID = 0xFFFFFE;

const PROGRAM_SOURCES = {
    point: [POINT_VS, POINT_FS],
    quad: [QUAD_VS, QUAD_FS],
    line: [LINE_VS, LINE_FS],
    pointPick: [PICK_POINT_VS, PICK_FS],
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
function createPicker(gl, primitive) {
    const key = primitive + "Pick";
    let fbo = null, tex = null, prog = null, uRes = null, tw = 0, th = 0;
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
            return { prog, uRes, fbo };
        },
        prog() { return prog; },
    };
}

/** Apply a top-left-origin scissor rect. GL's scissor origin is bottom-left. */
function applyScissor(gl, sc, resH) {
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(sc.x, resH - sc.y - sc.h, sc.w, sc.h);
}

/**
 * Render the field into the ID target and read back one pixel.
 * Restores the previously bound framebuffer, clear colour and blend state --
 * a pick must never disturb the visible frame.
 */
function pickAt(gl, picker, use, vao, primitive, resW, resH, count, px, py, sc) {
    if (count <= 0) return -1;
    px = px | 0; py = py | 0;
    if (px < 0 || py < 0 || px >= resW || py >= resH) return -1;

    const t = picker.ensure(resW, resH, use);

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevClear = gl.getParameter(gl.COLOR_CLEAR_VALUE);
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
    gl.bindVertexArray(vao);
    if (primitive === "point") gl.drawArrays(gl.POINTS, 0, count);
    else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
    if (sc) gl.disable(gl.SCISSOR_TEST);

    gl.readPixels(px, resH - py - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, PICK_RGBA);

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(0, 0, resW, resH);
    gl.clearColor(prevClear[0], prevClear[1], prevClear[2], prevClear[3]);
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
    const canvas = gl.canvas;

    let program = null, uResolution = null, vao = null, vbo = null;
    let resW = gl.drawingBufferWidth, resH = gl.drawingBufferHeight;
    let lost = false;
    let scissor = null, lastCount = 0;
    const sc = { x: 0, y: 0, w: 0, h: 0 };   // reused -- setScissor allocates nothing
    const heldKeys = new Set();
    const use = (key) => { heldKeys.add(key); return acquireProgram(gl, key); };
    const picker = createPicker(gl, "point");
    const restoreCbs = [];

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

    return {
        gl,
        capacity,
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
         * Instance index under (x, y) -- device px, top-left origin -- or -1 for a miss.
         * Renders one ID pass offscreen and reads back a single pixel: no CPU hit-testing,
         * so this is O(1) on the CPU even at 1M instances. Defaults to the count last drawn.
         * Call it on demand (a throttled pointermove), never every frame.
         */
        pick(x, y, count) {
            const n = (count === undefined) ? lastCount : count;
            return pickAt(gl, picker, use, vao, "point", resW, resH, n, x, y, scissor);
        },
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
    const canvas = gl.canvas;

    let program = null, uResolution = null, vao = null;
    let baseVbo = null, instanceVbo = null;
    let resW = gl.drawingBufferWidth, resH = gl.drawingBufferHeight;
    let lost = false;
    let scissor = null, lastCount = 0;
    const sc = { x: 0, y: 0, w: 0, h: 0 };   // reused -- setScissor allocates nothing
    const heldKeys = new Set();
    const use = (key) => { heldKeys.add(key); return acquireProgram(gl, key); };
    const picker = createPicker(gl, "quad");
    const restoreCbs = [];

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

    return {
        gl,
        capacity,
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
        /**
         * Instance index under (x, y) -- device px, top-left origin -- or -1 for a miss.
         * Renders one ID pass offscreen and reads back a single pixel: no CPU hit-testing,
         * so this is O(1) on the CPU even at 1M instances. Defaults to the count last drawn.
         * Call it on demand (a throttled pointermove), never every frame.
         */
        pick(x, y, count) {
            const n = (count === undefined) ? lastCount : count;
            return pickAt(gl, picker, use, vao, "quad", resW, resH, n, x, y, scissor);
        },
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
    const canvas = gl.canvas;

    let program = null, uResolution = null, vao = null;
    let baseVbo = null, instanceVbo = null;
    let resW = gl.drawingBufferWidth, resH = gl.drawingBufferHeight;
    let lost = false;
    let scissor = null, lastCount = 0;
    const sc = { x: 0, y: 0, w: 0, h: 0 };   // reused -- setScissor allocates nothing
    const heldKeys = new Set();
    const use = (key) => { heldKeys.add(key); return acquireProgram(gl, key); };
    const picker = createPicker(gl, "line");
    const restoreCbs = [];

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

    return {
        gl,
        capacity,
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
        /**
         * Instance index under (x, y) -- device px, top-left origin -- or -1 for a miss.
         * Renders one ID pass offscreen and reads back a single pixel: no CPU hit-testing,
         * so this is O(1) on the CPU even at 1M instances. Defaults to the count last drawn.
         * Call it on demand (a throttled pointermove), never every frame.
         */
        pick(x, y, count) {
            const n = (count === undefined) ? lastCount : count;
            return pickAt(gl, picker, use, vao, "line", resW, resH, n, x, y, scissor);
        },
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
}
