/**
 * Backend coverage for GLBackend.js (the WebGL2 sink). There is no GPU/context in
 * a headless sandbox, so we drive createPointSink against a MOCK WebGL2 context
 * that records the call sequence and hands back fake GL objects -- the same way
 * the core suite uses mockSink(). This verifies the GL wiring (compile/link,
 * one-time VBO allocation, the three instance attributes, dirty-window uploads,
 * a single POINTS draw, viewport/uniform, teardown) without a real GPU. The last
 * test runs the GL.js core THROUGH this backend so the seam is covered too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPointSink, createQuadSink, createLineSink } from "../GLBackend.js";
import { createField, LAYOUT } from "../GL.js";

// Minimal WebGL2 mock: distinct numeric enums, fake objects for create*, a call log.
// opts.compileOK / opts.linkOK drive the failure paths; opts.log is the info log.
function makeGL(opts = {}) {
    const compileOK = opts.compileOK !== false;
    const linkOK = opts.linkOK !== false;
    const log = opts.log || "";
    const calls = [];
    const rec = (name) => (...args) => { calls.push({ name, args }); };
    let n = 0;
    const obj = (tag) => ({ __tag: tag, __id: ++n });
    const gl = {
        // --- enum constants the backend reads off the context ---
        COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
        VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
        ARRAY_BUFFER: 0x8892, FLOAT: 0x1406, DYNAMIC_DRAW: 0x88e8, STATIC_DRAW: 0x88e4,
        POINTS: 0x0000, TRIANGLE_STRIP: 0x0005,
        drawingBufferWidth: 800, drawingBufferHeight: 600,
        calls,
        count(name) { return calls.filter((c) => c.name === name).length; },
        find(name) { return calls.find((c) => c.name === name); },
        all(name) { return calls.filter((c) => c.name === name); },
        // --- shader/program ---
        createShader: (type) => { calls.push({ name: "createShader", args: [type] }); return obj("shader"); },
        shaderSource: rec("shaderSource"),
        compileShader: rec("compileShader"),
        getShaderParameter: (sh, p) => { calls.push({ name: "getShaderParameter", args: [sh, p] }); return compileOK; },
        getShaderInfoLog: () => log,
        deleteShader: rec("deleteShader"),
        createProgram: () => { calls.push({ name: "createProgram", args: [] }); return obj("program"); },
        attachShader: rec("attachShader"),
        linkProgram: rec("linkProgram"),
        getProgramParameter: (pr, p) => { calls.push({ name: "getProgramParameter", args: [pr, p] }); return linkOK; },
        getProgramInfoLog: () => log,
        deleteProgram: rec("deleteProgram"),
        useProgram: rec("useProgram"),
        getUniformLocation: (pr, name) => { calls.push({ name: "getUniformLocation", args: [pr, name] }); return obj("uniform:" + name); },
        uniform2f: rec("uniform2f"),
        // --- VAO/VBO ---
        createVertexArray: () => { calls.push({ name: "createVertexArray", args: [] }); return obj("vao"); },
        createBuffer: () => { calls.push({ name: "createBuffer", args: [] }); return obj("vbo"); },
        bindVertexArray: rec("bindVertexArray"),
        bindBuffer: rec("bindBuffer"),
        bufferData: rec("bufferData"),
        bufferSubData: rec("bufferSubData"),
        enableVertexAttribArray: rec("enableVertexAttribArray"),
        vertexAttribPointer: rec("vertexAttribPointer"),
        deleteVertexArray: rec("deleteVertexArray"),
        deleteBuffer: rec("deleteBuffer"),
        // --- misc ---
        viewport: rec("viewport"),
        drawArrays: rec("drawArrays"),
        drawArraysInstanced: rec("drawArraysInstanced"),
        vertexAttribDivisor: rec("vertexAttribDivisor"),

        // --- v1.3: pick pass (FBO + ID texture + readback) and scissor ---
        TEXTURE_2D: 0x0de1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
        TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, NEAREST: 0x2600,
        FRAMEBUFFER: 0x8d40, COLOR_ATTACHMENT0: 0x8ce0, FRAMEBUFFER_BINDING: 0x8ca6,
        COLOR_BUFFER_BIT: 0x4000, SCISSOR_TEST: 0x0c11, BLEND: 0x0be2,
        COLOR_CLEAR_VALUE: 0x0c22,

        // The pixel readPixels() will hand back. Tests set gl.__pixel = [r,g,b,a]
        // to simulate "the instance with this id is under the cursor".
        __pixel: [255, 255, 255, 255],
        // Simulated GL state the backend must save/restore around a pick.
        __boundFbo: null,
        __clearColor: [0, 0, 0, 0],
        __blend: false,

        createTexture: () => { calls.push({ name: "createTexture", args: [] }); return obj("tex"); },
        bindTexture: rec("bindTexture"),
        texImage2D: rec("texImage2D"),
        texParameteri: rec("texParameteri"),
        deleteTexture: rec("deleteTexture"),
        createFramebuffer: () => { calls.push({ name: "createFramebuffer", args: [] }); return obj("fbo"); },
        bindFramebuffer(target, fbo) { calls.push({ name: "bindFramebuffer", args: [target, fbo] }); gl.__boundFbo = fbo; },
        framebufferTexture2D: rec("framebufferTexture2D"),
        deleteFramebuffer: rec("deleteFramebuffer"),
        readPixels(x, y, w, h, fmt, type, out) {
            calls.push({ name: "readPixels", args: [x, y, w, h, fmt, type, out] });
            out[0] = gl.__pixel[0]; out[1] = gl.__pixel[1]; out[2] = gl.__pixel[2]; out[3] = gl.__pixel[3];
        },
        getParameter(p) {
            calls.push({ name: "getParameter", args: [p] });
            if (p === 0x8ca6) return gl.__boundFbo;      // FRAMEBUFFER_BINDING
            if (p === 0x0c22) return gl.__clearColor;    // COLOR_CLEAR_VALUE
            return null;
        },
        isEnabled(cap) { calls.push({ name: "isEnabled", args: [cap] }); return cap === 0x0be2 ? gl.__blend : false; },
        enable(cap) { calls.push({ name: "enable", args: [cap] }); if (cap === 0x0be2) gl.__blend = true; },
        disable(cap) { calls.push({ name: "disable", args: [cap] }); if (cap === 0x0be2) gl.__blend = false; },
        scissor: rec("scissor"),
        clearColor(r, g, b, a) { calls.push({ name: "clearColor", args: [r, g, b, a] }); gl.__clearColor = [r, g, b, a]; },
        clear: rec("clear"),
    };
    return gl;
}

test("createPointSink compiles two shaders, links a program, allocates the VBO once, and configures three attributes", () => {
    const gl = makeGL();
    const sink = createPointSink(gl, { capacity: 1000 });

    // shader + program lifecycle
    assert.equal(gl.count("createShader"), 2, "vertex + fragment shader");
    assert.deepEqual(gl.all("createShader").map((c) => c.args[0]).sort(),
        [gl.FRAGMENT_SHADER, gl.VERTEX_SHADER].sort(), "compiled VS and FS");
    assert.equal(gl.count("compileShader"), 2);
    assert.equal(gl.count("createProgram"), 1);
    assert.equal(gl.count("attachShader"), 2);
    assert.equal(gl.count("linkProgram"), 1);
    assert.equal(gl.count("deleteShader"), 2, "shaders detached/deleted after link");
    assert.ok(gl.find("getUniformLocation").args[1] === "u_resolution");

    // one-time VBO allocation sized to capacity * stride(8) * 4 bytes
    assert.equal(gl.count("createVertexArray"), 1);
    assert.equal(gl.count("createBuffer"), 1);
    const bd = gl.find("bufferData");
    assert.equal(bd.args[0], gl.ARRAY_BUFFER);
    assert.equal(bd.args[1], 1000 * 8 * 4, "VBO sized once to capacity*stride*4 bytes");
    assert.equal(bd.args[2], gl.DYNAMIC_DRAW);

    // three attributes: a_pos(0,vec2@0) a_size(1,float@8) a_color(2,vec4@12), stride 32
    assert.equal(gl.count("enableVertexAttribArray"), 3);
    const ptr = gl.all("vertexAttribPointer").map((c) => c.args);
    assert.deepEqual(ptr[0], [0, 2, gl.FLOAT, false, 32, 0]);
    assert.deepEqual(ptr[1], [1, 1, gl.FLOAT, false, 32, 8]);
    assert.deepEqual(ptr[2], [2, 4, gl.FLOAT, false, 32, 12]);

    // sink surface
    for (const m of ["upload", "draw", "resize", "dispose"]) assert.equal(typeof sink[m], "function");
    assert.equal(sink.gl, gl);
});

test("a shader that fails to compile throws with the info log (and cleans up)", () => {
    const gl = makeGL({ compileOK: false, log: "syntax error near vec2" });
    assert.throws(() => createPointSink(gl, { capacity: 16 }), /shader compile failed/);
    assert.ok(gl.count("deleteShader") >= 1, "failed shader deleted");
});

test("a program that fails to link throws", () => {
    const gl = makeGL({ linkOK: false, log: "no fragment output" });
    assert.throws(() => createPointSink(gl, { capacity: 16 }), /program link failed/);
    assert.equal(gl.count("deleteProgram"), 1, "failed program deleted");
});

test("upload writes only the dirty float window via bufferSubData", () => {
    const gl = makeGL();
    const sink = createPointSink(gl, { capacity: 1000 });
    const data = new Float32Array(8000);
    sink.upload(data, 16, 8);   // floatOffset 16, floatCount 8

    const sub = gl.find("bufferSubData");
    assert.ok(sub, "bufferSubData issued");
    assert.equal(sub.args[0], gl.ARRAY_BUFFER);
    assert.equal(sub.args[1], 16 * 4, "byte offset = floatOffset * 4");
    assert.equal(sub.args[2], data, "the field's own typed array (no slice/copy)");
    assert.equal(sub.args[3], 16, "src offset = floatOffset");
    assert.equal(sub.args[4], 8, "length = floatCount");
});

test("draw sets the resolution uniform and issues one POINTS draw; count<=0 is a no-op", () => {
    const gl = makeGL();
    const sink = createPointSink(gl, { capacity: 1000 });
    sink.resize(800, 600);

    const before = gl.count("drawArrays");
    sink.draw(500);
    assert.equal(gl.count("drawArrays") - before, 1, "exactly one draw");
    const da = gl.all("drawArrays").at(-1);
    assert.deepEqual(da.args, [gl.POINTS, 0, 500]);
    const u = gl.all("uniform2f").at(-1);
    assert.deepEqual(u.args.slice(1), [800, 600], "u_resolution set to the viewport");

    const n = gl.count("drawArrays");
    sink.draw(0);
    sink.draw(-3);
    assert.equal(gl.count("drawArrays"), n, "no draw issued for count <= 0");
});

test("resize updates the viewport and the resolution used by the next draw", () => {
    const gl = makeGL();
    const sink = createPointSink(gl, { capacity: 16 });
    sink.resize(1024, 768);
    assert.deepEqual(gl.all("viewport").at(-1).args, [0, 0, 1024, 768]);
    sink.draw(10);
    assert.deepEqual(gl.all("uniform2f").at(-1).args.slice(1), [1024, 768]);
});

test("dispose releases program, VAO, and VBO", () => {
    const gl = makeGL();
    const sink = createPointSink(gl, { capacity: 16 });
    sink.dispose();
    assert.equal(gl.count("deleteBuffer"), 1);
    assert.equal(gl.count("deleteVertexArray"), 1);
    assert.equal(gl.count("deleteProgram"), 1);
});

test("end-to-end: the GL.js core field flushes through the real WebGL2 sink", () => {
    const gl = makeGL();
    const sink = createPointSink(gl, { capacity: 1024 });
    const field = createField({ capacity: 1024, stride: LAYOUT.POINT });

    // write 3 points (8 floats each)
    const writePoint = (x, y) => (d, b) => {
        d[b] = x; d[b + 1] = y; d[b + 2] = 4;          // pos + size
        d[b + 3] = 1; d[b + 4] = 1; d[b + 5] = 1; d[b + 6] = 1; d[b + 7] = 0;  // rgba + pad
    };
    field.push(writePoint(10, 20));
    field.push(writePoint(30, 40));
    field.push(writePoint(50, 60));

    field.flush(sink);
    // first flush: whole dirty range [0..2] -> 24 floats from offset 0, then draw 3
    let sub = gl.all("bufferSubData").at(-1);
    assert.deepEqual([sub.args[1], sub.args[3], sub.args[4]], [0, 0, 24], "uploaded floats 0..24");
    assert.deepEqual(gl.all("drawArrays").at(-1).args, [gl.POINTS, 0, 3]);

    // append one more, flush: only the new instance's window uploads, draw 4
    const subsBefore = gl.count("bufferSubData");
    field.push(writePoint(70, 80));
    field.flush(sink);
    assert.equal(gl.count("bufferSubData") - subsBefore, 1, "one incremental upload");
    sub = gl.all("bufferSubData").at(-1);
    assert.deepEqual([sub.args[1], sub.args[3], sub.args[4]], [24 * 4, 24, 8], "only the 4th point's window");
    assert.deepEqual(gl.all("drawArrays").at(-1).args, [gl.POINTS, 0, 4]);
});

test("upload beyond the sink capacity throws a clear error instead of a cryptic GL crash", () => {
    const gl = makeGL();
    const sink = createPointSink(gl, { capacity: 100 });   // VBO holds 100 points -> 800 floats
    assert.equal(sink.capacity, 100, "capacity exposed for guarding/sizing");
    const data = new Float32Array(2000);
    assert.doesNotThrow(() => sink.upload(data, 0, 800), "exactly at capacity is fine");
    assert.throws(() => sink.upload(data, 0, 808), /exceeds sink capacity/, "one point past capacity throws");
});

// ---------------------------------------------------------------------------
// QUAD sink (v1.1): instanced unit-quad pipeline. Same mock-GL discipline as the
// point sink -- verify the base + instance VBO wiring, the four per-instance
// attributes with vertexAttribDivisor(1), the dirty-window upload into the
// INSTANCE buffer, and the single drawArraysInstanced(TRIANGLE_STRIP) call.
// ---------------------------------------------------------------------------

test("createQuadSink links a program, allocates a static base VBO + a dynamic instance VBO, and configures 5 attributes", () => {
    const gl = makeGL();
    const sink = createQuadSink(gl, { capacity: 1000 });

    // shader + program lifecycle (same as points)
    assert.equal(gl.count("createShader"), 2, "vertex + fragment shader");
    assert.equal(gl.count("linkProgram"), 1);
    assert.equal(gl.count("deleteShader"), 2, "shaders deleted after link");
    assert.ok(gl.find("getUniformLocation").args[1] === "u_resolution");

    // one VAO, two buffers (base geometry + per-instance data)
    assert.equal(gl.count("createVertexArray"), 1);
    assert.equal(gl.count("createBuffer"), 2, "baseVbo + instanceVbo");

    // two bufferData calls: static unit quad, then the dynamic instance store
    const bd = gl.all("bufferData");
    assert.equal(bd.length, 2);
    const staticBd = bd.find((c) => c.args[2] === gl.STATIC_DRAW);
    const dynBd = bd.find((c) => c.args[2] === gl.DYNAMIC_DRAW);
    assert.ok(staticBd, "static base geometry uploaded");
    assert.ok(staticBd.args[1] instanceof Float32Array, "base geometry is a Float32Array (unit quad)");
    assert.equal(staticBd.args[1].length, 8, "unit quad = 4 verts * 2 floats");
    assert.ok(dynBd, "dynamic instance VBO sized once");
    assert.equal(dynBd.args[1], 1000 * 9 * 4, "instance VBO = capacity * stride(9) * 4 bytes");

    // 5 attributes: loc0 base (vec2), loc1..4 per-instance
    assert.equal(gl.count("enableVertexAttribArray"), 5);
    const ptr = gl.all("vertexAttribPointer").map((c) => c.args);
    assert.deepEqual(ptr[0], [0, 2, gl.FLOAT, false, 0, 0], "loc0 base unit-quad vertex, tightly packed");
    assert.deepEqual(ptr[1], [1, 2, gl.FLOAT, false, 36, 0], "loc1 a_pos vec2 @ 0, stride 36");
    assert.deepEqual(ptr[2], [2, 2, gl.FLOAT, false, 36, 8], "loc2 a_size vec2 @ 8");
    assert.deepEqual(ptr[3], [3, 1, gl.FLOAT, false, 36, 16], "loc3 a_rot float @ 16");
    assert.deepEqual(ptr[4], [4, 4, gl.FLOAT, false, 36, 20], "loc4 a_color vec4 @ 20");

    // divisor 1 on the 4 per-instance attrs only (loc0 keeps the default 0)
    const div = gl.all("vertexAttribDivisor").map((c) => c.args);
    assert.equal(div.length, 4, "only the per-instance attributes get a divisor");
    assert.deepEqual(div.map((d) => d[0]).sort(), [1, 2, 3, 4], "locs 1..4");
    assert.ok(div.every((d) => d[1] === 1), "all per-instance divisors are 1");

    for (const m of ["upload", "draw", "resize", "onContextRestored", "isContextLost", "dispose"]) {
        assert.equal(typeof sink[m], "function");
    }
    assert.equal(sink.gl, gl);
    assert.equal(sink.capacity, 1000, "capacity exposed for guarding/sizing");
});

test("quad upload writes only the dirty float window into the instance VBO", () => {
    const gl = makeGL();
    const sink = createQuadSink(gl, { capacity: 1000 });
    const data = new Float32Array(9000);
    sink.upload(data, 18, 9);   // instance 2 (18 = 2 * 9)

    const sub = gl.find("bufferSubData");
    assert.ok(sub, "bufferSubData issued");
    assert.equal(sub.args[0], gl.ARRAY_BUFFER);
    assert.equal(sub.args[1], 18 * 4, "byte offset = floatOffset * 4");
    assert.equal(sub.args[2], data, "the field's own typed array (no slice/copy)");
    assert.equal(sub.args[3], 18, "src offset = floatOffset");
    assert.equal(sub.args[4], 9, "length = floatCount (one quad)");
});

test("quad draw sets the resolution uniform and issues one instanced TRIANGLE_STRIP draw; count<=0 is a no-op", () => {
    const gl = makeGL();
    const sink = createQuadSink(gl, { capacity: 1000 });
    sink.resize(1280, 720);

    const before = gl.count("drawArraysInstanced");
    sink.draw(250);
    assert.equal(gl.count("drawArraysInstanced") - before, 1, "exactly one instanced draw");
    const da = gl.all("drawArraysInstanced").at(-1);
    assert.deepEqual(da.args, [gl.TRIANGLE_STRIP, 0, 4, 250], "4-vert strip, 250 instances");
    assert.deepEqual(gl.all("uniform2f").at(-1).args.slice(1), [1280, 720], "u_resolution set to viewport");

    const n = gl.count("drawArraysInstanced");
    sink.draw(0);
    sink.draw(-5);
    assert.equal(gl.count("drawArraysInstanced"), n, "no draw for count <= 0");
});

test("quad upload beyond the sink capacity throws a clear error", () => {
    const gl = makeGL();
    const sink = createQuadSink(gl, { capacity: 100 });   // 100 quads -> 900 floats
    const data = new Float32Array(2000);
    assert.doesNotThrow(() => sink.upload(data, 0, 900), "exactly at capacity is fine");
    assert.throws(() => sink.upload(data, 0, 909), /exceeds sink capacity/, "one quad past capacity throws");
});

test("quad dispose releases program, VAO, and both buffers", () => {
    const gl = makeGL();
    const sink = createQuadSink(gl, { capacity: 16 });
    sink.dispose();
    assert.equal(gl.count("deleteBuffer"), 2, "baseVbo + instanceVbo");
    assert.equal(gl.count("deleteVertexArray"), 1);
    assert.equal(gl.count("deleteProgram"), 1);
});

test("end-to-end: the GL.js core flushes a LAYOUT.QUAD field through the real quad sink", () => {
    const gl = makeGL();
    const sink = createQuadSink(gl, { capacity: 1024 });
    const field = createField({ capacity: 1024, stride: LAYOUT.QUAD });

    const writeQuad = (x, y, w, h, rot) => (d, b) => {
        d[b] = x; d[b + 1] = y; d[b + 2] = w; d[b + 3] = h; d[b + 4] = rot;
        d[b + 5] = 1; d[b + 6] = 0; d[b + 7] = 0; d[b + 8] = 1;   // rgba
    };
    field.push(writeQuad(10, 20, 4, 4, 0));
    field.push(writeQuad(30, 40, 8, 2, 0.5));
    field.push(writeQuad(50, 60, 2, 8, 1.0));

    field.flush(sink);
    // whole dirty range [0..2] -> 27 floats from offset 0, then instanced draw of 3
    let sub = gl.all("bufferSubData").at(-1);
    assert.deepEqual([sub.args[1], sub.args[3], sub.args[4]], [0, 0, 27], "uploaded floats 0..27 (3 quads)");
    assert.deepEqual(gl.all("drawArraysInstanced").at(-1).args, [gl.TRIANGLE_STRIP, 0, 4, 3]);

    // append one more -> only its 9-float window uploads, instanced draw of 4
    const subsBefore = gl.count("bufferSubData");
    field.push(writeQuad(70, 80, 3, 3, 0));
    field.flush(sink);
    assert.equal(gl.count("bufferSubData") - subsBefore, 1, "one incremental upload");
    sub = gl.all("bufferSubData").at(-1);
    assert.deepEqual([sub.args[1], sub.args[3], sub.args[4]], [27 * 4, 27, 9], "only the 4th quad's window");
    assert.deepEqual(gl.all("drawArraysInstanced").at(-1).args, [gl.TRIANGLE_STRIP, 0, 4, 4]);
});

// ---------------------------------------------------------------------------
// LINE sink (v1.2): instanced thick-segment pipeline. Same mock-GL discipline
// as points/quads -- verify the static base descriptor VBO + dynamic instance
// VBO, the four per-instance attributes (p0, p1, width, color) with
// vertexAttribDivisor(1), the dirty-window upload into the INSTANCE buffer, and
// the single drawArraysInstanced(TRIANGLE_STRIP) call.
// ---------------------------------------------------------------------------

test("createLineSink links a program, allocates a static base VBO + a dynamic instance VBO, and configures 5 attributes", () => {
    const gl = makeGL();
    const sink = createLineSink(gl, { capacity: 1000 });

    assert.equal(gl.count("createShader"), 2, "vertex + fragment shader");
    assert.equal(gl.count("linkProgram"), 1);
    assert.equal(gl.count("deleteShader"), 2, "shaders deleted after link");
    assert.ok(gl.find("getUniformLocation").args[1] === "u_resolution");

    assert.equal(gl.count("createVertexArray"), 1);
    assert.equal(gl.count("createBuffer"), 2, "baseVbo + instanceVbo");

    const bd = gl.all("bufferData");
    assert.equal(bd.length, 2);
    const staticBd = bd.find((c) => c.args[2] === gl.STATIC_DRAW);
    const dynBd = bd.find((c) => c.args[2] === gl.DYNAMIC_DRAW);
    assert.ok(staticBd, "static base geometry uploaded");
    assert.ok(staticBd.args[1] instanceof Float32Array, "base geometry is a Float32Array (t,s descriptors)");
    assert.equal(staticBd.args[1].length, 8, "4 corners * 2 descriptors");
    assert.ok(dynBd, "dynamic instance VBO sized once");
    assert.equal(dynBd.args[1], 1000 * 9 * 4, "instance VBO = capacity * stride(9) * 4 bytes");

    assert.equal(gl.count("enableVertexAttribArray"), 5);
    const ptr = gl.all("vertexAttribPointer").map((c) => c.args);
    assert.deepEqual(ptr[0], [0, 2, gl.FLOAT, false, 0, 0], "loc0 base (t,s) tightly packed");
    assert.deepEqual(ptr[1], [1, 2, gl.FLOAT, false, 36, 0], "loc1 a_p0 vec2 @ 0, stride 36");
    assert.deepEqual(ptr[2], [2, 2, gl.FLOAT, false, 36, 8], "loc2 a_p1 vec2 @ 8");
    assert.deepEqual(ptr[3], [3, 1, gl.FLOAT, false, 36, 16], "loc3 a_width float @ 16");
    assert.deepEqual(ptr[4], [4, 4, gl.FLOAT, false, 36, 20], "loc4 a_color vec4 @ 20");

    const div = gl.all("vertexAttribDivisor").map((c) => c.args);
    assert.equal(div.length, 4, "only the per-instance attributes get a divisor");
    assert.deepEqual(div.map((d) => d[0]).sort(), [1, 2, 3, 4], "locs 1..4");
    assert.ok(div.every((d) => d[1] === 1), "all per-instance divisors are 1");

    for (const m of ["upload", "draw", "resize", "onContextRestored", "isContextLost", "dispose"]) {
        assert.equal(typeof sink[m], "function");
    }
    assert.equal(sink.gl, gl);
    assert.equal(sink.capacity, 1000);
});

test("line upload writes only the dirty float window into the instance VBO", () => {
    const gl = makeGL();
    const sink = createLineSink(gl, { capacity: 1000 });
    const data = new Float32Array(9000);
    sink.upload(data, 18, 9);   // segment 2 (18 = 2 * 9)

    const sub = gl.find("bufferSubData");
    assert.ok(sub, "bufferSubData issued");
    assert.equal(sub.args[0], gl.ARRAY_BUFFER);
    assert.equal(sub.args[1], 18 * 4, "byte offset = floatOffset * 4");
    assert.equal(sub.args[2], data, "the field's own typed array (no slice/copy)");
    assert.equal(sub.args[3], 18, "src offset = floatOffset");
    assert.equal(sub.args[4], 9, "length = floatCount (one segment)");
});

test("line draw sets the resolution uniform and issues one instanced TRIANGLE_STRIP draw; count<=0 is a no-op", () => {
    const gl = makeGL();
    const sink = createLineSink(gl, { capacity: 1000 });
    sink.resize(1280, 720);

    const before = gl.count("drawArraysInstanced");
    sink.draw(250);
    assert.equal(gl.count("drawArraysInstanced") - before, 1, "exactly one instanced draw");
    const da = gl.all("drawArraysInstanced").at(-1);
    assert.deepEqual(da.args, [gl.TRIANGLE_STRIP, 0, 4, 250], "4-vert strip, 250 instances");
    assert.deepEqual(gl.all("uniform2f").at(-1).args.slice(1), [1280, 720], "u_resolution set to viewport");

    const n = gl.count("drawArraysInstanced");
    sink.draw(0);
    sink.draw(-5);
    assert.equal(gl.count("drawArraysInstanced"), n, "no draw for count <= 0");
});

test("line upload beyond the sink capacity throws a clear error", () => {
    const gl = makeGL();
    const sink = createLineSink(gl, { capacity: 100 });   // 100 segments -> 900 floats
    const data = new Float32Array(2000);
    assert.doesNotThrow(() => sink.upload(data, 0, 900), "exactly at capacity is fine");
    assert.throws(() => sink.upload(data, 0, 909), /exceeds sink capacity/, "one segment past capacity throws");
});

test("line dispose releases program, VAO, and both buffers", () => {
    const gl = makeGL();
    const sink = createLineSink(gl, { capacity: 16 });
    sink.dispose();
    assert.equal(gl.count("deleteBuffer"), 2, "baseVbo + instanceVbo");
    assert.equal(gl.count("deleteVertexArray"), 1);
    assert.equal(gl.count("deleteProgram"), 1);
});

test("end-to-end: the GL.js core flushes a LAYOUT.LINE field through the real line sink", () => {
    const gl = makeGL();
    const sink = createLineSink(gl, { capacity: 1024 });
    const field = createField({ capacity: 1024, stride: LAYOUT.LINE });

    const writeSeg = (x0, y0, x1, y1, w) => (d, b) => {
        d[b] = x0; d[b + 1] = y0; d[b + 2] = x1; d[b + 3] = y1; d[b + 4] = w;
        d[b + 5] = 0; d[b + 6] = 1; d[b + 7] = 0; d[b + 8] = 1;   // rgba
    };
    field.push(writeSeg(10, 20, 30, 40, 2));
    field.push(writeSeg(30, 40, 55, 60, 2));
    field.push(writeSeg(55, 60, 80, 62, 2));

    field.flush(sink);
    let sub = gl.all("bufferSubData").at(-1);
    assert.deepEqual([sub.args[1], sub.args[3], sub.args[4]], [0, 0, 27], "uploaded floats 0..27 (3 segments)");
    assert.deepEqual(gl.all("drawArraysInstanced").at(-1).args, [gl.TRIANGLE_STRIP, 0, 4, 3]);

    const subsBefore = gl.count("bufferSubData");
    field.push(writeSeg(80, 62, 100, 40, 2));
    field.flush(sink);
    assert.equal(gl.count("bufferSubData") - subsBefore, 1, "one incremental upload");
    sub = gl.all("bufferSubData").at(-1);
    assert.deepEqual([sub.args[1], sub.args[3], sub.args[4]], [27 * 4, 27, 9], "only the 4th segment's window");
    assert.deepEqual(gl.all("drawArraysInstanced").at(-1).args, [gl.TRIANGLE_STRIP, 0, 4, 4]);
});

// ---------------------------------------------------------------------------
// v1.3: shared program cache, scissor regions, ID-buffer picking.
// ---------------------------------------------------------------------------

test("N sinks of the same type in one context share ONE linked program", () => {
    const gl = makeGL();
    const a = createPointSink(gl, { capacity: 100 });
    assert.equal(gl.count("linkProgram"), 1, "first sink compiles + links");
    assert.equal(gl.count("createShader"), 2);

    const b = createPointSink(gl, { capacity: 100 });
    const c = createPointSink(gl, { capacity: 100 });
    assert.equal(gl.count("linkProgram"), 1, "2nd and 3rd sinks reuse the cached program");
    assert.equal(gl.count("createShader"), 2, "no extra shader compiles");
    // ...but each still gets its own VAO + VBO (its own data).
    assert.equal(gl.count("createVertexArray"), 3);

    // A different primitive type links its own program.
    createQuadSink(gl, { capacity: 100 });
    assert.equal(gl.count("linkProgram"), 2, "quad links its own program");
    a.dispose(); b.dispose(); c.dispose();
});

test("a program is NOT deleted while another sink still uses it (refcounted dispose)", () => {
    const gl = makeGL();
    const a = createPointSink(gl, { capacity: 100 });
    const b = createPointSink(gl, { capacity: 100 });

    a.dispose();
    assert.equal(gl.count("deleteProgram"), 0, "b still holds the shared program");
    assert.equal(gl.count("deleteVertexArray"), 1, "but a's own VAO is gone");

    b.dispose();
    assert.equal(gl.count("deleteProgram"), 1, "last ref released -> program deleted exactly once");
});

test("programs are cached PER CONTEXT (a WebGLProgram cannot cross contexts)", () => {
    const gl1 = makeGL();
    const gl2 = makeGL();
    createPointSink(gl1, { capacity: 100 });
    createPointSink(gl2, { capacity: 100 });
    assert.equal(gl1.count("linkProgram"), 1, "context 1 links its own program");
    assert.equal(gl2.count("linkProgram"), 1, "context 2 links its OWN program, not gl1's");
    assert.equal(gl2.count("createShader"), 2, "context 2 compiles its own shaders");
});

test("setScissor clips the draw to a top-left-origin rect and is disabled afterwards", () => {
    const gl = makeGL();
    const sink = createQuadSink(gl, { capacity: 100 });
    sink.resize(1000, 800);

    sink.setScissor(100, 50, 400, 300);        // top-left origin
    sink.draw(10);
    const en = gl.all("enable").filter((c) => c.args[0] === gl.SCISSOR_TEST);
    assert.equal(en.length, 1, "scissor test enabled for the draw");
    // GL's scissor origin is bottom-left: y_gl = resH - y - h = 800 - 50 - 300 = 450
    assert.deepEqual(gl.find("scissor").args, [100, 450, 400, 300], "y flipped into GL space");
    const dis = gl.all("disable").filter((c) => c.args[0] === gl.SCISSOR_TEST);
    assert.equal(dis.length, 1, "scissor test disabled again (no leaking state)");

    sink.clearScissor();
    const before = gl.count("scissor");
    sink.draw(10);
    assert.equal(gl.count("scissor"), before, "no scissor call once cleared");
});

test("pick() renders an ID pass offscreen and decodes the instance index from one pixel", () => {
    const gl = makeGL();
    const sink = createQuadSink(gl, { capacity: 1000 });
    sink.resize(640, 480);
    sink.draw(500);                       // pick defaults to the count last drawn

    // id 197121 = 0x030201 -> little-endian bytes r=1, g=2, b=3
    gl.__pixel = [1, 2, 3, 255];
    const id = sink.pick(320, 240);
    assert.equal(id, 1 | (2 << 8) | (3 << 16), "24-bit little-endian decode");

    // lazily built its own FBO + ID texture, sized to the canvas
    assert.equal(gl.count("createFramebuffer"), 1);
    assert.equal(gl.count("createTexture"), 1);
    const ti = gl.find("texImage2D").args;
    assert.equal(ti[3], 640, "ID texture width == canvas width");
    assert.equal(ti[4], 480, "ID texture height == canvas height");

    // read the pixel under the cursor, y flipped into GL space (480 - 240 - 1)
    const rp = gl.find("readPixels").args;
    assert.deepEqual([rp[0], rp[1], rp[2], rp[3]], [320, 239, 1, 1], "single pixel, y-flipped");

    // a second pick reuses the same target
    sink.pick(10, 10);
    assert.equal(gl.count("createFramebuffer"), 1, "FBO reused across picks");
});

test("pick() returns -1 for background, empty fields, and out-of-bounds coordinates", () => {
    const gl = makeGL();
    const sink = createPointSink(gl, { capacity: 1000 });
    sink.resize(640, 480);

    assert.equal(sink.pick(10, 10), -1, "nothing drawn yet -> miss");

    sink.draw(100);
    gl.__pixel = [255, 255, 255, 255];               // white = background
    assert.equal(sink.pick(10, 10), -1, "background -> -1");

    gl.__pixel = [0, 0, 0, 255];                     // id 0 is a VALID instance
    assert.equal(sink.pick(10, 10), 0, "instance 0 is not confused with a miss");

    const reads = gl.count("readPixels");
    assert.equal(sink.pick(-1, 10), -1, "negative -> -1");
    assert.equal(sink.pick(640, 10), -1, "past the right edge -> -1");
    assert.equal(sink.pick(10, 480), -1, "past the bottom edge -> -1");
    assert.equal(gl.count("readPixels"), reads, "no GL work for out-of-bounds picks");
});

test("pick() must not disturb the visible frame: blend off during the ID pass, all state restored", () => {
    const gl = makeGL();
    const sink = createPointSink(gl, { capacity: 1000 });
    sink.resize(640, 480);
    sink.draw(100);

    // Simulate the demo's additive blending + transparent clear colour.
    gl.enable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.__boundFbo = null;                            // drawing to the canvas
    const callsBefore = gl.calls.length;

    gl.__pixel = [7, 0, 0, 255];
    assert.equal(sink.pick(100, 100), 7);

    const after = gl.calls.slice(callsBefore);
    const idx = (pred) => after.findIndex(pred);
    const iDisableBlend = idx((c) => c.name === "disable" && c.args[0] === gl.BLEND);
    const iDraw = idx((c) => c.name === "drawArrays");
    const iEnableBlend = idx((c) => c.name === "enable" && c.args[0] === gl.BLEND);
    assert.ok(iDisableBlend >= 0 && iDisableBlend < iDraw, "blending is OFF for the ID pass (ids must not blend)");
    assert.ok(iEnableBlend > iDraw, "blending restored after the pass");
    assert.equal(gl.__blend, true, "BLEND left enabled, as it was");

    // ID target cleared to white BEFORE the draw, and the canvas' clear colour put back.
    const clearWhite = after.find((c) => c.name === "clearColor" && c.args[0] === 1);
    assert.ok(clearWhite, "ID target cleared to white (miss)");
    assert.deepEqual(gl.__clearColor, [0, 0, 0, 0], "the app's clear colour is restored");
    assert.equal(gl.__boundFbo, null, "the previously bound framebuffer (the canvas) is rebound");
});

test("pick() honours the scissor rect, so a hover cannot hit a neighbouring pane", () => {
    const gl = makeGL();
    const sink = createLineSink(gl, { capacity: 1000 });
    sink.resize(1000, 800);
    sink.setScissor(0, 0, 500, 800);        // left pane only
    sink.draw(200);

    const before = gl.calls.length;
    gl.__pixel = [5, 0, 0, 255];
    sink.pick(100, 100);
    const after = gl.calls.slice(before);

    const iClear = after.findIndex((c) => c.name === "clear");
    const iScissorOn = after.findIndex((c) => c.name === "enable" && c.args[0] === gl.SCISSOR_TEST);
    const iDraw = after.findIndex((c) => c.name === "drawArraysInstanced");
    assert.ok(iClear >= 0 && iClear < iScissorOn,
        "the WHOLE ID target is cleared before the scissor goes on (else stale ids survive outside the pane)");
    assert.ok(iScissorOn < iDraw, "the ID draw is clipped to the pane");
});

test("a lost context drops the shared programs so they are relinked on restore", () => {
    const gl = makeGL();
    const canvas = { listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; }, removeEventListener() {} };
    gl.canvas = canvas;

    const sink = createPointSink(gl, { capacity: 100 });
    assert.equal(gl.count("linkProgram"), 1);

    canvas.listeners.webglcontextlost({ preventDefault() {} });
    assert.equal(sink.isContextLost(), true);

    canvas.listeners.webglcontextrestored();
    assert.equal(sink.isContextLost(), false);
    assert.equal(gl.count("linkProgram"), 2, "program relinked after restore (the old one died with the context)");
});
