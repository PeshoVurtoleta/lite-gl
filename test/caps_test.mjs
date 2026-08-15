/**
 * test/caps_test.mjs -- GL8a boundary suite for the v2.0.0 caps seam (assertCaps).
 *
 * A4: a sink with caps absent/null throws at BIND; a POINT_HI field on a
 * precisionHi:false sink throws; capacity > maxInstances throws. Every case here
 * exercises reactiveField's bind-time call into assertCaps (GL.js) directly --
 * never GLBackend.js -- with lightweight mock sinks that mirror the ones in
 * test/GL_test.mjs. Positive controls prove the gate can also NOT fire.
 *
 * MIT (c) 2026 Zahary Shinikchiev
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createScope } from "@zakkster/lite-signal";
import { createField, reactiveField, LAYOUT } from "../GL.js";
import { createPointSink, createQuadSink, createLineSink, createPointHiSink } from "../GLBackend.js";

function withRoot(fn) {
    let ret;
    const disposer = createScope((d) => { ret = fn(); return d; });
    return { value: ret, dispose: disposer };
}

// A minimal sink surface: caps + the two calls reactiveField's bind path and
// frame() can reach (upload/draw). No onContextRestored -- reactiveField already
// guards that as optional (`typeof sink.onContextRestored === "function"`).
function mockSinkWithCaps(caps) {
    return {
        caps,
        uploads: 0, draws: 0,
        upload(_data, _fo, _fc) { this.uploads++; },
        draw(_count) { this.draws++; },
    };
}

const validCaps = Object.freeze({
    api: "mock", instancing: true, baseVertex: false,
    maxInstances: 0xFFFFFF, precisionHi: false, pickMode: "sync", version: 1,
});
const validCapsHi = Object.freeze({
    api: "mock", instancing: true, baseVertex: false,
    maxInstances: 0xFFFFFF, precisionHi: true, pickMode: "sync", version: 1,
});

const noopProject = (field) => { field.setCount(0); };

// ===========================================================================
// A4 -- boundary matrix for assertCaps.
// ===========================================================================

test("A4: bind with sink.caps === null throws (fail closed, null is not zero)", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    const sink = mockSinkWithCaps(null);
    assert.throws(
        () => withRoot(() => reactiveField(f, { manual: true, sink, project: noopProject })),
        /sink\.caps is missing/,
        "null caps must throw naming the missing descriptor"
    );
});

test("A4: bind with sink.caps === undefined throws", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    const sink = mockSinkWithCaps(undefined);
    assert.throws(
        () => withRoot(() => reactiveField(f, { manual: true, sink, project: noopProject })),
        /sink\.caps is missing/,
        "undefined caps must throw naming the missing descriptor"
    );
});

test("A4: bind with a caps key entirely missing from the sink object throws", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    // No `caps` property at all -- sink.caps reads as undefined, same code path
    // as the explicit-undefined case above, but exercised via a genuinely absent key.
    const sink = { uploads: 0, draws: 0, upload() { this.uploads++; }, draw() { this.draws++; } };
    assert.ok(!("caps" in sink), "sanity: the mock sink truly has no caps key");
    assert.throws(
        () => withRoot(() => reactiveField(f, { manual: true, sink, project: noopProject })),
        /sink\.caps is missing/,
        "a sink missing the caps property altogether must throw"
    );
});

test("A4: bind with a sink === null throws (caps read off a null sink)", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    assert.throws(
        () => withRoot(() => reactiveField(f, { manual: true, sink: null, project: noopProject })),
        /sink\.caps is missing/,
        "a null sink itself must throw, not crash on `sink.caps`"
    );
});

test("A4: bind with caps omitting maxInstances (non-finite) throws -- the fail-closed hardening", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    // precisionHi is a valid boolean, but maxInstances is simply absent -> `field.capacity
    // > undefined` would silently be false (fail OPEN) without the explicit finite-number
    // guard in assertCaps. Verify it genuinely throws rather than binding.
    const sink = mockSinkWithCaps(Object.freeze({ precisionHi: false }));
    assert.throws(
        () => withRoot(() => reactiveField(f, { manual: true, sink, project: noopProject })),
        /caps\.maxInstances must be a finite number/,
        "a caps descriptor with no maxInstances must throw, not bind fail-open"
    );
});

test("A4: bind with caps.maxInstances === NaN throws (non-finite, not just absent)", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    const sink = mockSinkWithCaps(Object.freeze({ precisionHi: false, maxInstances: NaN }));
    assert.throws(
        () => withRoot(() => reactiveField(f, { manual: true, sink, project: noopProject })),
        /caps\.maxInstances must be a finite number/,
        "NaN maxInstances must throw"
    );
});

test("A4: bind with caps.maxInstances === Infinity throws (non-finite)", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    const sink = mockSinkWithCaps(Object.freeze({ precisionHi: false, maxInstances: Infinity }));
    assert.throws(
        () => withRoot(() => reactiveField(f, { manual: true, sink, project: noopProject })),
        /caps\.maxInstances must be a finite number/,
        "Infinity maxInstances must throw (Infinity > 0 is fail-open shaped, but Number.isFinite catches it)"
    );
});

test("A4: bind with caps.precisionHi not a boolean throws", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    for (const badPrecisionHi of [undefined, null, 0, 1, "true", "false", NaN]) {
        const sink = mockSinkWithCaps(Object.freeze({ precisionHi: badPrecisionHi, maxInstances: 0xFFFFFF }));
        assert.throws(
            () => withRoot(() => reactiveField(f, { manual: true, sink, project: noopProject })),
            /caps\.precisionHi must be a boolean/,
            "precisionHi=" + String(badPrecisionHi) + " must throw"
        );
    }
});

test("A4: a LAYOUT.POINT_HI field bound to a sink with caps.precisionHi:false throws", () => {
    const fHi = createField({ capacity: 8, stride: LAYOUT.POINT_HI });
    const sink = mockSinkWithCaps(validCaps);   // precisionHi: false
    assert.throws(
        () => withRoot(() => reactiveField(fHi, { manual: true, sink, project: noopProject })),
        /does not advertise precisionHi/,
        "POINT_HI on a non-precisionHi sink must throw, never silently drop precision"
    );
});

test("A4: a field whose capacity exceeds caps.maxInstances throws", () => {
    // A small-maxInstances caps triggers the boundary WITHOUT allocating 16M
    // instances: field.capacity (pow2 from 8 -> 8) > caps.maxInstances (4).
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    assert.equal(f.capacity, 8, "sanity: field capacity is 8");
    const sink = mockSinkWithCaps(Object.freeze({ precisionHi: false, maxInstances: 4 }));
    assert.throws(
        () => withRoot(() => reactiveField(f, { manual: true, sink, project: noopProject })),
        /field capacity 8 exceeds sink caps\.maxInstances 4/,
        "over-capacity field must throw with a size hint naming both numbers"
    );
});

test("A4: a field whose capacity exactly equals caps.maxInstances does NOT throw (boundary N)", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    assert.equal(f.capacity, 8);
    const sink = mockSinkWithCaps(Object.freeze({ precisionHi: false, maxInstances: 8 }));
    const r = withRoot(() => reactiveField(f, { manual: true, sink, project: noopProject }));
    assert.ok(r.value, "capacity === maxInstances is the boundary, not the violation -- must bind");
    r.dispose();
});

// ===========================================================================
// POSITIVE controls -- a gate that only ever throws proves nothing.
// ===========================================================================

test("A4 positive control: a well-formed POINT field on valid caps binds WITHOUT throwing", () => {
    const f = createField({ capacity: 16, stride: LAYOUT.POINT });
    const sink = mockSinkWithCaps(validCaps);
    let handle;
    const r = withRoot(() => {
        handle = reactiveField(f, {
            manual: true, sink,
            project: (fld) => { fld.set(0, (d, b) => { d[b] = 1; }); fld.setCount(1); },
        });
        return handle;
    });
    assert.equal(typeof r.value.frame, "function", "bind succeeded and returned a live handle");
    r.value.frame();
    assert.equal(sink.draws, 1, "the bound field actually draws -- the positive path is real, not just non-throwing");
    r.dispose();
});

test("A4 positive control: a POINT_HI field on caps.precisionHi:true binds fine", () => {
    const fHi = createField({ capacity: 16, stride: LAYOUT.POINT_HI });
    const sink = mockSinkWithCaps(validCapsHi);
    let handle;
    const r = withRoot(() => {
        handle = reactiveField(fHi, {
            manual: true, sink,
            project: (fld) => { fld.setCount(1); },
        });
        return handle;
    });
    r.value.frame();
    assert.equal(sink.draws, 1, "POINT_HI on a precisionHi sink binds and draws");
    r.dispose();
});

// ===========================================================================
// caps provenance -- the four REAL backend sinks (GLBackend.js) must each hand
// back a genuinely frozen caps descriptor, and precisionHi must be true on
// EXACTLY createPointHiSink. Uses a minimal mock WebGL2 context (mirrors
// test/GLBackend_test.mjs's makeGL) so this runs headless, no GPU required.
// ===========================================================================

// A trimmed mock WebGL2 context: enough surface for createPointSink/QuadSink/
// LineSink/PointHiSink to compile+link a program, allocate VAO/VBOs, and set up
// the pick FBO/texture, without recording every call (this suite only cares
// about the returned caps object, not the wiring, which GLBackend_test.mjs
// already covers exhaustively).
function makeGL() {
    let n = 0;
    const obj = (tag) => ({ __tag: tag, __id: ++n });
    const noop = () => {};
    return {
        COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
        VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
        ARRAY_BUFFER: 0x8892, FLOAT: 0x1406, DYNAMIC_DRAW: 0x88e8, STATIC_DRAW: 0x88e4,
        POINTS: 0x0000, TRIANGLE_STRIP: 0x0005,
        drawingBufferWidth: 800, drawingBufferHeight: 600,
        TEXTURE_2D: 0x0de1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
        TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, NEAREST: 0x2600,
        FRAMEBUFFER: 0x8d40, COLOR_ATTACHMENT0: 0x8ce0, FRAMEBUFFER_BINDING: 0x8ca6,
        COLOR_BUFFER_BIT: 0x4000, SCISSOR_TEST: 0x0c11, BLEND: 0x0be2, COLOR_CLEAR_VALUE: 0x0c22,
        canvas: { addEventListener: noop, removeEventListener: noop },
        createShader: () => obj("shader"), shaderSource: noop, compileShader: noop,
        getShaderParameter: () => true, getShaderInfoLog: () => "", deleteShader: noop,
        createProgram: () => obj("program"), attachShader: noop, linkProgram: noop,
        getProgramParameter: () => true, getProgramInfoLog: () => "", deleteProgram: noop, useProgram: noop,
        getUniformLocation: () => obj("uniform"), uniform2f: noop, uniform4f: noop, uniform1f: noop, uniform1i: noop,
        createVertexArray: () => obj("vao"), createBuffer: () => obj("vbo"),
        bindVertexArray: noop, bindBuffer: noop, bufferData: noop, bufferSubData: noop,
        enableVertexAttribArray: noop, vertexAttribPointer: noop, deleteVertexArray: noop, deleteBuffer: noop,
        viewport: noop, drawArrays: noop, drawArraysInstanced: noop, vertexAttribDivisor: noop,
        createTexture: () => obj("tex"), bindTexture: noop, texImage2D: noop, texParameteri: noop, deleteTexture: noop,
        createFramebuffer: () => obj("fbo"), bindFramebuffer: noop, framebufferTexture2D: noop, deleteFramebuffer: noop,
        readPixels(x, y, w, h, f, t, out) { out[0] = 1; out[1] = 2; out[2] = 3; out[3] = 255; },
        getParameter(p) { if (p === 0x0c22) return new Float32Array(4); return null; },
        isEnabled: () => false, enable: noop, disable: noop, scissor: noop, clearColor: noop, clear: noop,
    };
}

const REAL_SINKS = [
    ["createPointSink", createPointSink, false],
    ["createQuadSink", createQuadSink, false],
    ["createLineSink", createLineSink, false],
    ["createPointHiSink", createPointHiSink, true],
];

for (const [name, factory, expectPrecisionHi] of REAL_SINKS) {
    test("A4 caps provenance: " + name + "'s caps is genuinely frozen, precisionHi=" + expectPrecisionHi, () => {
        const gl = makeGL();
        const sink = factory(gl, { capacity: 16 });
        assert.ok(sink.caps, name + " exposes a caps object");
        assert.ok(Object.isFrozen(sink.caps), name + "'s caps must be Object.freeze()'d");
        assert.equal(typeof sink.caps.precisionHi, "boolean", name + "'s caps.precisionHi is a genuine boolean");
        assert.equal(sink.caps.precisionHi, expectPrecisionHi, name + "'s caps.precisionHi must be exactly " + expectPrecisionHi);
        assert.equal(typeof sink.caps.maxInstances, "number", name + "'s caps.maxInstances is a number");
        assert.ok(Number.isFinite(sink.caps.maxInstances), name + "'s caps.maxInstances is finite");
        // frozen means a write attempt is silently ignored (sloppy mode) or throws
        // (strict mode) -- either way the value must not change.
        const before = sink.caps.precisionHi;
        try { sink.caps.precisionHi = !before; } catch (_e) { /* strict-mode throw is fine too */ }
        assert.equal(sink.caps.precisionHi, before, name + "'s caps.precisionHi is immutable even under a direct write attempt");
        sink.dispose();
    });
}

test("A4 caps provenance: precisionHi is true on EXACTLY createPointHiSink, never the other three", () => {
    const trueOn = REAL_SINKS.filter(([, factory]) => {
        const gl = makeGL();
        const sink = factory(gl, { capacity: 16 });
        const hi = sink.caps.precisionHi;
        sink.dispose();
        return hi === true;
    }).map(([n]) => n);
    assert.deepEqual(trueOn, ["createPointHiSink"], "precisionHi:true must be advertised by createPointHiSink alone");
});
