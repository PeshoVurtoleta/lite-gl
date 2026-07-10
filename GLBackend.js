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
    const restoreCbs = [];

    function createResources() {
        program = link(gl, POINT_VS, POINT_FS);
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
            if (lost || count <= 0) return;
            gl.useProgram(program);
            gl.uniform2f(uResolution, resW, resH);
            gl.bindVertexArray(vao);
            gl.drawArrays(gl.POINTS, 0, count);
            gl.bindVertexArray(null);
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
            if (program) gl.deleteProgram(program);
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
    const restoreCbs = [];

    function createResources() {
        program = link(gl, QUAD_VS, QUAD_FS);
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
            if (lost || count <= 0) return;
            gl.useProgram(program);
            gl.uniform2f(uResolution, resW, resH);
            gl.bindVertexArray(vao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
            gl.bindVertexArray(null);
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
            if (program) gl.deleteProgram(program);
        },
    };
}
