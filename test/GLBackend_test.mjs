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
import { createPointSink } from "../GLBackend.js";
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
        ARRAY_BUFFER: 0x8892, FLOAT: 0x1406, DYNAMIC_DRAW: 0x88e8, POINTS: 0x0000,
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
