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
 * _pad) as GL_POINTS in one draw call. Positions are expected in SCREEN PIXELS --
 * do the world->screen projection in your reactive `project` (e.g. from a
 * lite-camera-max view), so the camera stays in the reactive graph and the shader
 * only maps pixels to clip space. Quads/lines follow the same shape with an
 * instanced base geometry and vertexAttribDivisor(1); see the note at the bottom.
 *
 * CONTEXT LOSS: a long-running overlay WILL lose its GL context (GPU reset, driver
 * update, the tab backgrounded on mobile). The sink owns the GL resources, so it
 * owns recovery: it listens for `webglcontextlost`/`webglcontextrestored` on the
 * canvas, no-ops draw/upload while lost, and rebuilds program + VBO + VAO on
 * restore. The restored buffer is EMPTY, so register `onContextRestored(cb)` to
 * re-upload your data -- reactiveField wires `field.touchAll()` + flush for you.
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

const STRIDE = 8;            // LAYOUT.POINT floats
const STRIDE_BYTES = STRIDE * 4;

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

    // All GPU-side resources, in one place so they can be rebuilt after a restore
    // (on context loss every program/buffer/VAO is gone and must be recreated).
    function createResources() {
        program = link(gl, POINT_VS, POINT_FS);
        uResolution = gl.getUniformLocation(program, "u_resolution");
        vao = gl.createVertexArray();
        vbo = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, capacity * STRIDE_BYTES, gl.DYNAMIC_DRAW);   // allocate once
        // a_pos (vec2 @ 0), a_size (float @ 8), a_color (vec4 @ 12)
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE_BYTES, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, STRIDE_BYTES, 8);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE_BYTES, 12);
        gl.bindVertexArray(null);
        gl.viewport(0, 0, resW, resH);
    }

    function onLost(e) {
        // Default behaviour is "context is gone forever"; preventDefault opts into restore.
        e.preventDefault();
        lost = true;
    }
    function onRestored() {
        createResources();          // rebuild program + VBO (empty) + VAO
        lost = false;
        for (let i = 0; i < restoreCbs.length; i++) restoreCbs[i]();   // consumers re-upload
    }

    const canListen = canvas && typeof canvas.addEventListener === "function";
    if (canListen) {
        canvas.addEventListener("webglcontextlost", onLost, false);
        canvas.addEventListener("webglcontextrestored", onRestored, false);
    }

    createResources();

    return {
        gl,
        capacity,   // exposed so callers can size/guard against the fixed VBO
        /** Match the viewport (call on canvas resize). */
        resize(w, h) {
            resW = w; resH = h;
            if (!lost) gl.viewport(0, 0, w, h);
        },
        /** Upload only the dirty float window into the instance VBO (zero copies beyond it). */
        upload(data, floatOffset, floatCount) {
            if (lost) return;
            if (floatOffset + floatCount > capacity * STRIDE) {
                throw new RangeError("lite-gl: point upload exceeds sink capacity (" + capacity + " points). "
                    + "Size createPointSink({ capacity }) to your field's maximum count.");
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            // bufferSubData with a typed-array view range avoids slicing/allocating.
            gl.bufferSubData(gl.ARRAY_BUFFER, floatOffset * 4, data, floatOffset, floatCount);
        },
        /** One draw call for all `count` points. The caller owns clear/blend state. */
        draw(count) {
            if (lost || count <= 0) return;
            gl.useProgram(program);
            gl.uniform2f(uResolution, resW, resH);
            gl.bindVertexArray(vao);
            gl.drawArrays(gl.POINTS, 0, count);
            gl.bindVertexArray(null);
        },
        /**
         * Register a callback fired after the GL context is restored and the sink's
         * resources are rebuilt. Re-upload your data here (the GPU buffer is empty
         * again). Returns an unsubscribe function.
         */
        onContextRestored(cb) {
            restoreCbs.push(cb);
            return () => { const i = restoreCbs.indexOf(cb); if (i >= 0) restoreCbs.splice(i, 1); };
        },
        /** True between `webglcontextlost` and the following `webglcontextrestored`. */
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

/*
 * QUADS / LINES (same pattern, deferred from v1):
 *   - Create a tiny base-geometry VBO (a unit quad = 4 verts as TRIANGLE_STRIP; a
 *     unit segment for lines) on attribute location 0 with the DEFAULT divisor.
 *   - Put the per-instance field rows on a second VBO and set vertexAttribDivisor(loc, 1)
 *     for each instance attribute, so they advance once per instance, not per vertex.
 *   - draw(count) -> gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count).
 *   - `upload` is identical (bufferSubData of the dirty float window on the instance VBO).
 * The GL.js core is unchanged; only the sink differs per primitive.
 */
