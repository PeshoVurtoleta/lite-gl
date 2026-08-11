// test/torture.mjs -- node --expose-gc test/torture.mjs
//
// The mandatory zero-GC gate for @zakkster/lite-gl (GL1). It is the executable
// form of LITEGL_SESSIONS.md section 3. "No gate output is a FAIL": every tier
// prints an explicit PASS/FAIL line and the process exits non-zero on ANY tier
// failure OR on missing instrumentation.
//
// Two instruments (torture-harness law):
//   - @zakkster/lite-gc-profiler -- budget: did V8 allocate/collect where it must not?
//   - @zakkster/lite-leak        -- retention: did a create/dispose cycle orphan anything?
//
// Tiers implemented now: T0 (dirty-range metamorphic laws), T1 (degenerate values),
// T2 (aliasing matrix vs a shadow buffer), T6 (zero-alloc gate over project+flush+draw
// for every layout), T7 (1M soak + create/dispose conservation), T9 (controls: the
// gate must be able to fail). T3/T4/T5 land with GL2; T8 with GL6.
//
// MIT (c) 2026 Zahary Shinikchiev

// The two instruments are loaded through a guarded dynamic import: if either
// fails to resolve/link (e.g. a lite-signal API drift under lite-leak), the
// harness prints an explicit FAIL line and exits NON-ZERO -- "no gate output is
// a FAIL" -- rather than dying with an uncaught SyntaxError that a CI grep for
// PASS/FAIL would misread as "no findings".
function failInstrumentation(reason) {
    console.error("FAIL instrumentation: " + reason);
    console.log("GATE leak=size -/-  findings=- warnings=- | gc major=- minor=- maxMs=- | alloc=- B/op | FAIL");
    process.exit(1);
}
async function loadInstruments() {
    let gcp, leak;
    try {
        gcp = await import("@zakkster/lite-gc-profiler");
        leak = await import("@zakkster/lite-leak");
    } catch (e) {
        // Fail closed on an import/link error (e.g. a lite-signal API drift under
        // lite-leak): print an explicit FAIL gate line rather than dying with an
        // uncaught SyntaxError that a PASS/FAIL grep would misread.
        failInstrumentation("import: " + (e && e.message ? e.message : String(e)));
    }
    // Fail closed on API drift too: a missing named export destructures to
    // undefined and would otherwise throw a bare TypeError deep in a tier with no
    // gate line. Validate every symbol the harness calls is actually a function.
    const need = {
        "lite-gc-profiler.GcProfiler": gcp.GcProfiler,
        "lite-gc-profiler.checkNoGc": gcp.checkNoGc,
        "lite-leak.createLeakTracker": leak.createLeakTracker,
        "lite-leak.createOwnerCascadeOrphanKernel": leak.createOwnerCascadeOrphanKernel,
        "lite-leak.createObserverOrphanKernel": leak.createObserverOrphanKernel,
        "lite-leak.createAsyncRetentionKernel": leak.createAsyncRetentionKernel,
    };
    for (const k of Object.keys(need)) {
        if (typeof need[k] !== "function") failInstrumentation("missing/!function export: " + k);
    }
    return { gcp, leak };
}
const { gcp: _gcp, leak: _leak } = await loadInstruments();
const { GcProfiler, checkNoGc } = _gcp;
const {
    createLeakTracker,
    createOwnerCascadeOrphanKernel,
    createObserverOrphanKernel,
    createAsyncRetentionKernel,
} = _leak;

import {
    createScope,
    effect as sEffect,
    onCleanup as sOnCleanup,
    dispose as sDispose,
} from "@zakkster/lite-signal";

import { createField, createDriver, LAYOUT, writePointHi } from "../GL.js";
import {
    createPointSink,
    createPointHiSink,
    createQuadSink,
    createLineSink,
} from "../GLBackend.js";

// ===========================================================================
// Instrumentation guard -- a gate that cannot observe is a FAIL, not a pass.
// ===========================================================================
if (typeof globalThis.gc !== "function") {
    failInstrumentation("run with `node --expose-gc test/torture.mjs`");
}
{
    // Confirm the profiler's precise node channel is live before we trust any number.
    const probe = new GcProfiler(256, { source: "gc" }).start();
    await probe.settle();
    const ps = probe.summary();
    probe.stop();
    if (ps.source !== "gc") {
        failInstrumentation("lite-gc-profiler source is '" + ps.source + "', expected 'gc'");
    }
}

// The per-op detection floor, in bytes. The empty-loop calibration below reads
// ~0.1-0.2 B/op of pure instrument noise (the sampleHeap + memoryUsage path);
// the smallest real per-op allocation observable here is an empty object at
// ~14 B/op (see the T9 control) or a typed array at far more. 1.0 B/op sits
// strictly between the two: it is a detection threshold below any possible real
// allocation, NOT a widened budget. The zero-alloc contract is proven by the hot
// paths reading at or below the empty calibration, not by hugging this ceiling.
const INSTRUMENT_FLOOR = 1.0;

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail: detail || "" });

// ---------------------------------------------------------------------------
// bytesPerOp: run `op` `iters` times under the precise GC channel, sampling the
// heap, and report cumulative positive heap growth per op (an allocation-rate
// proxy immune to the scavenge-reset that fools a naive end-minus-start delta).
// ---------------------------------------------------------------------------
async function bytesPerOp(iters, op, source = "gc") {
    const warm = Math.min(iters, 20000);
    for (let i = 0; i < warm; i++) op(i);
    globalThis.gc();
    const gc = new GcProfiler(256, { source }).start();
    for (let i = 0; i < iters; i++) {
        op(i);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    await gc.settle();
    const s = gc.summary();
    gc.stop();
    return {
        perOp: s.heap.allocBytes / iters,
        allocBytes: s.heap.allocBytes,
        major: s.gc.major,
        minor: s.gc.minor,
        maxMs: s.gc.maxMs,
        source: s.source,
        supported: s.heap.supported,
        observed: s.observed !== false,
    };
}

// A frame path passes iff it was genuinely observed on the precise channel AND
// allocated nothing beyond instrument noise AND triggered no major GC.
const framePasses = (r) =>
    r.source === "gc" && r.supported && r.observed && r.major === 0 && r.perOp < INSTRUMENT_FLOOR;

// ===========================================================================
// A pure mock sink: records the exact upload window (data, off, cnt, base,
// stride) and draw count, and folds each uploaded window into a shadow buffer.
// The shadow is what a GPU would hold if it started empty and applied only the
// dirty-range uploads -- so `shadow[active] === field.data[active]` proves the
// dirty-range batching reconstructs the buffer exactly. Zero allocation per call.
// ===========================================================================
function mockSink(shadowFloats) {
    return {
        uploads: 0,
        draws: 0,
        off: -1,
        cnt: -1,
        base: -1,
        stride: -1,
        drawCount: -1,
        shadow: new Float32Array(shadowFloats),
        upload(data, floatOffset, floatCount, instanceOffset, stride) {
            this.uploads++;
            this.off = floatOffset;
            this.cnt = floatCount;
            this.base = instanceOffset;
            this.stride = stride;
            const sh = this.shadow;
            for (let k = 0; k < floatCount; k++) sh[floatOffset + k] = data[floatOffset + k];
        },
        draw(count) {
            this.draws++;
            this.drawCount = count;
        },
        reset() {
            this.uploads = 0;
            this.draws = 0;
            this.off = -1;
            this.cnt = -1;
            this.base = -1;
            this.stride = -1;
            this.drawCount = -1;
        },
    };
}

// ===========================================================================
// A zero-allocation mock WebGL2 context for the real sinks (T6/T7). It mirrors
// the enum + fake-object shape of test/GLBackend_test.mjs's makeGL, but the hot
// methods are no-ops: a call-recording mock (as in the call-sequence suite)
// would itself allocate an object per call and could never clear a zero-alloc
// gate. getParameter(COLOR_CLEAR_VALUE) returns a FRESH Float32Array(4), exactly
// as a real WebGL2 context does -- that is the GL-05 allocation the pick sub-gate
// is meant to catch, so the mock reproduces it faithfully rather than hiding it.
// ===========================================================================
function silentGL() {
    let n = 0;
    const obj = (t) => ({ __tag: t, __id: ++n });
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
        createShader: () => obj("sh"), shaderSource: noop, compileShader: noop,
        getShaderParameter: () => true, getShaderInfoLog: () => "", deleteShader: noop,
        createProgram: () => obj("pr"), attachShader: noop, linkProgram: noop,
        getProgramParameter: () => true, getProgramInfoLog: () => "", deleteProgram: noop, useProgram: noop,
        getUniformLocation: () => obj("u"), uniform2f: noop, uniform4f: noop, uniform1f: noop, uniform1i: noop,
        createVertexArray: () => obj("vao"), createBuffer: () => obj("vbo"),
        bindVertexArray: noop, bindBuffer: noop, bufferData: noop, bufferSubData: noop,
        enableVertexAttribArray: noop, vertexAttribPointer: noop, deleteVertexArray: noop, deleteBuffer: noop,
        viewport: noop, drawArrays: noop, drawArraysInstanced: noop, vertexAttribDivisor: noop,
        createTexture: () => obj("t"), bindTexture: noop, texImage2D: noop, texParameteri: noop, deleteTexture: noop,
        createFramebuffer: () => obj("f"), bindFramebuffer: noop, framebufferTexture2D: noop, deleteFramebuffer: noop,
        readPixels(x, y, w, h, f, t, out) { out[0] = 1; out[1] = 2; out[2] = 3; out[3] = 255; },
        getParameter(p) {
            if (p === 0x8ca6) return null;             // FRAMEBUFFER_BINDING
            if (p === 0x0c22) return new Float32Array(4); // COLOR_CLEAR_VALUE -- allocates, per spec (GL-05)
            return null;
        },
        isEnabled: () => false, enable: noop, disable: noop, scissor: noop, clearColor: noop, clear: noop,
    };
}

// Per-layout: stride, a sink factory, and a preallocated projection writer.
// The writers read projection scalars from a preallocated Float64Array. This is
// deliberate: a plain `let _py` closed over by a writer would box each fractional
// assignment into a HeapNumber (~8 B/op of context garbage) and the zero-alloc
// gate would -- correctly -- fail on the harness's own instrumentation. A typed
// array slot never boxes, so the measured frame allocates nothing.
const _proj = new Float64Array(2);   // [x, y]
// T9(a) escape sink: the injected per-frame object is stored here and summed
// after the run, so the optimizer cannot elide the allocation the control needs.
const _t9ring = new Array(1024).fill(null);
let _t9sum = 0;
const layouts = {
    POINT: {
        stride: LAYOUT.POINT,
        make: (gl, cap) => createPointSink(gl, { capacity: cap }),
        write: (data, base) => {
            data[base] = _proj[0]; data[base + 1] = _proj[1]; data[base + 2] = 3;
            data[base + 3] = 1; data[base + 4] = 1; data[base + 5] = 1; data[base + 6] = 1; data[base + 7] = 0;
        },
    },
    POINT_HI: {
        stride: LAYOUT.POINT_HI,
        make: (gl, cap) => { const s = createPointHiSink(gl, { capacity: cap }); s.setCamera(0, 0, 1, 1, 0, 0); return s; },
        write: (data, base) => { writePointHi(data, base, _proj[0], _proj[1], 3, 1, 1, 1, 1); },
    },
    QUAD: {
        stride: LAYOUT.QUAD,
        make: (gl, cap) => createQuadSink(gl, { capacity: cap }),
        write: (data, base) => {
            data[base] = _proj[0]; data[base + 1] = _proj[1]; data[base + 2] = 4; data[base + 3] = 4; data[base + 4] = 0;
            data[base + 5] = 1; data[base + 6] = 1; data[base + 7] = 1; data[base + 8] = 1;
        },
    },
    LINE: {
        stride: LAYOUT.LINE,
        make: (gl, cap) => createLineSink(gl, { capacity: cap }),
        write: (data, base) => {
            data[base] = _proj[0]; data[base + 1] = _proj[1]; data[base + 2] = _proj[0] + 1; data[base + 3] = _proj[1] + 1; data[base + 4] = 2;
            data[base + 5] = 1; data[base + 6] = 1; data[base + 7] = 1; data[base + 8] = 1;
        },
    },
};

// ===========================================================================
// Tier T0 -- dirty-range metamorphic laws.
// ===========================================================================
function tierT0() {
    const errs = [];
    const check = (c, m) => { if (!c) errs.push(m); };
    const stride = LAYOUT.POINT;
    const f = createField({ capacity: 64, stride });
    const sink = mockSink(f.data.length);
    let _v = 0;
    const w = (data, base) => { for (let k = 0; k < stride; k++) data[base + k] = _v + k; };

    // push then flush -> exactly [i, i]
    _v = 10; const i0 = f.push(w);
    f.flush(sink);
    check(sink.off === i0 * stride && sink.cnt === stride && sink.base === i0, "push->flush uploads [i,i]");
    check(sink.draws === 1, "push->flush draws once");

    // scattered set -> [min, max], never the whole buffer
    for (let k = 0; k < 20; k++) { _v = k; f.push(w); } // count now 21
    f.flush(sink); sink.reset();
    _v = 100; f.set(3, w);
    _v = 200; f.set(17, w);
    _v = 150; f.set(9, w);
    f.flush(sink);
    check(sink.off === 3 * stride && sink.cnt === (17 - 3 + 1) * stride, "scattered set -> [min,max]");
    check(sink.cnt < f.count * stride, "scattered set is NOT a whole-buffer upload");

    // clearDirty then flush -> no upload, still draws
    sink.reset(); _v = 5; f.set(2, w); f.clearDirty();
    f.flush(sink);
    check(sink.uploads === 0, "clearDirty -> no upload");
    check(sink.draws === 1, "clearDirty -> still draws");

    // touchAll then flush -> exactly [0, count-1]
    sink.reset(); f.touchAll(); f.flush(sink);
    check(sink.off === 0 && sink.cnt === f.count * stride, "touchAll -> [0,count-1]");

    // swapRemove(last) marks nothing dirty
    f.clearDirty(); sink.reset();
    const last = f.count - 1;
    f.swapRemove(last);
    check(f.dirtyLo() === -1, "swapRemove(last) marks nothing dirty");
    f.flush(sink);
    check(sink.uploads === 0, "swapRemove(last) -> no upload");

    record("T0 dirty-range metamorphic laws", errs.length === 0, errs.join("; "));
}

// ===========================================================================
// Tier T1 -- degenerate values (NaN / Inf / -0, capacity edges, empty draw).
// ===========================================================================
function tierT1() {
    const errs = [];
    const check = (c, m) => { if (!c) errs.push(m); };

    // Contract for NaN / +-Inf / -0: WRITE-THROUGH. The packer never substitutes
    // a "safe" value silently -- a wrong pixel must be traceable to the input.
    const hi = createField({ capacity: 4, stride: LAYOUT.POINT_HI });
    writePointHi(hi.data, 0, NaN, Infinity, 3, 1, 1, 1, 1);
    check(Number.isNaN(hi.data[0]), "writePointHi NaN -> hi is NaN (write-through)");
    check(Number.isNaN(hi.data[2]), "writePointHi NaN -> lo is NaN (write-through)");
    check(hi.data[1] === Infinity, "writePointHi +Inf -> hi is +Inf (write-through)");
    check(Number.isNaN(hi.data[3]), "writePointHi +Inf -> lo is NaN (Inf-Inf), not a silent 0");
    writePointHi(hi.data, LAYOUT.POINT_HI, -0, 2, 3, 1, 1, 1, 1);
    check(Object.is(hi.data[LAYOUT.POINT_HI], -0), "writePointHi -0 -> hi preserves signed zero");

    // project (a set-writer) carries NaN through to the field verbatim.
    const pf = createField({ capacity: 4, stride: LAYOUT.POINT });
    pf.push((data, base) => { data[base] = NaN; data[base + 1] = -Infinity; });
    check(Number.isNaN(pf.data[0]), "project NaN -> stored verbatim");
    check(pf.data[1] === -Infinity, "project -Inf -> stored verbatim");

    // GL2 fail-closed construction (validation at construction ONLY -- the hot
    // bodies gain zero branches). Reject: missing/invalid stride, non-positive
    // capacity, unknown keys (with a did-you-mean).
    let e1 = null; try { createField({ capacity: 8 }); } catch (e) { e1 = e; }
    check(e1 !== null && /stride/.test(e1.message), "createField without stride throws, naming `stride`");
    let e2 = null; try { createField({ stride: 8, strid: 8 }); } catch (e) { e2 = e; }
    check(e2 !== null && /did you mean 'stride'/.test(e2.message), "createField unknown key `strid` -> did-you-mean `stride`");
    let e3 = null; try { createField({ stride: 0 }); } catch (e) { e3 = e; }
    check(e3 !== null, "createField stride 0 throws");

    // Fail-OPEN guard: `Infinity > 0` is true, so a bare `> 0` capacity test would
    // let Infinity / values past 2^30 reach nextPow2 and HANG (Int32 shift wrap).
    // These must throw fast, never loop. nextPow2 is bounded so a regression here
    // fails-fast (a huge Float32Array throws) rather than hanging the whole gate.
    for (const badCap of [Infinity, 2 ** 31, (1 << 30) + 1, NaN, -1, 3.5]) {
        let eh = null; try { createField({ stride: LAYOUT.POINT, capacity: badCap }); } catch (e) { eh = e; }
        check(eh !== null, "createField capacity " + String(badCap) + " throws (does not hang)");
    }

    // capacity edges: 0 -> THROWS (fail closed: 0 is not positive; was an implicit
    // default pre-GL2), 1 -> 1, non-pow2 POSITIVE -> next pow2.
    let e0 = null; try { createField({ capacity: 0, stride: LAYOUT.POINT }); } catch (e) { e0 = e; }
    check(e0 !== null && /capacity/.test(e0.message), "capacity 0 -> throws (degenerate, not an implicit default)");
    const c1 = createField({ capacity: 1, stride: LAYOUT.POINT });
    check(c1.capacity === 1, "capacity 1 -> 1");
    check(c1.data.length === LAYOUT.POINT, "capacity 1 -> no zero-length buffer");
    check(createField({ capacity: 3, stride: LAYOUT.POINT }).capacity === 4, "capacity 3 -> pow2 4");
    check(createField({ capacity: 100, stride: LAYOUT.POINT }).capacity === 128, "capacity 100 -> pow2 128");

    // setCount(0) then flush -> draw(0), no upload, no throw.
    const ef = createField({ capacity: 8, stride: LAYOUT.POINT });
    const sink = mockSink(ef.data.length);
    ef.setCount(0);
    ef.flush(sink);
    check(sink.uploads === 0, "setCount(0) -> no upload");
    check(sink.draws === 1 && sink.drawCount === 0, "setCount(0) -> draw(0)");

    record("T1 degenerate values", errs.length === 0, errs.join("; "));
}

// ===========================================================================
// Tier T2 -- the aliasing matrix. Randomized op stream (no growth) with a
// shadow buffer; every flush uploads the tight [dLo,dHi] window and every active
// instance matches the shadow the uploads reconstruct.
// ===========================================================================
function tierT2() {
    const errs = [];
    const check = (c, m) => { if (!c && errs.length < 8) errs.push(m); };
    const stride = LAYOUT.POINT;
    const cap = 256;
    const f = createField({ capacity: cap, stride });
    const sink = mockSink(f.data.length);
    let _v = 0;
    const w = (data, base) => { for (let k = 0; k < stride; k++) data[base + k] = _v * 31 + k; };

    // deterministic PRNG so a failure reproduces.
    let seed = 0x1234abcd;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };

    f.setCount(0);
    for (let step = 0; step < 20000; step++) {
        const r = rnd();
        if (r < 0.35 && f.count < cap) { _v = step; f.push(w); }
        else if (r < 0.6 && f.count > 0) { _v = step; f.set((rnd() * f.count) | 0, w); }
        else if (r < 0.75 && f.count > 0) { f.swapRemove((rnd() * f.count) | 0); }
        else if (r < 0.85) { const n = (rnd() * cap) | 0; _v = step; f.setCount(n); }
        else {
            const dLo = f.dirtyLo(), dHi = f.dirtyHi(), cnt = f.count;
            const upBefore = sink.uploads;
            f.flush(sink);
            if (dLo >= 0) {
                // N-3: the uploaded window is [dLo, min(dHi, count-1)] -- a post-shrink
                // stale dHi is clamped to the active range, never uploaded past it.
                const hi = dHi < cnt ? dHi : cnt - 1;
                if (hi >= dLo) {
                    check(sink.uploads === upBefore + 1, "an in-range dirty window uploads once");
                    check(sink.off === dLo * stride && sink.cnt === (hi - dLo + 1) * stride, "flush uploads tight [dLo, min(dHi,count-1)]");
                } else {
                    check(sink.uploads === upBefore, "a wholly-stale dirty window uploads nothing");
                }
            }
            // every active instance matches the shadow the uploads built.
            for (let i = 0; i < f.count; i++) {
                const b = i * stride;
                for (let k = 0; k < stride; k++) {
                    if (sink.shadow[b + k] !== f.data[b + k]) { check(false, "active instance " + i + " diverged from shadow"); break; }
                }
            }
        }
    }

    // explicit coalesce: set(2), set(9), set(5) -> one upload [2,9].
    f.setCount(10); f.clearDirty(); sink.reset();
    _v = 1; f.set(2, w); _v = 2; f.set(9, w); _v = 3; f.set(5, w);
    f.flush(sink);
    check(sink.uploads === 1 && sink.off === 2 * stride && sink.cnt === (9 - 2 + 1) * stride, "overlapping ranges coalesce to one [2,9] upload");

    // swapRemove while a dirty range is open -> moved slot lands inside the window.
    f.setCount(10); f.clearDirty(); sink.reset();
    _v = 7; f.set(1, w);        // opens dirty at 1
    f.swapRemove(3);            // moves instance 9 into slot 3, marks 3
    const lo = f.dirtyLo(), hi = f.dirtyHi();
    check(lo <= 3 && hi >= 3, "swapRemove marks the moved slot inside the open window");
    f.flush(sink);
    check(sink.off === lo * stride && sink.cnt === (hi - lo + 1) * stride, "post-swapRemove upload is the tight window");

    record("T2 aliasing matrix vs shadow", errs.length === 0, errs.join("; "));
}

// ===========================================================================
// A counting GL mock for the lifecycle tier (T4). Unlike silentGL it records a
// few call counts and drives a real canvas event listener list so context
// loss/restore can be fired deterministically. Allocation here is irrelevant --
// T4 is a correctness tier, not a zero-alloc one.
// ===========================================================================
function countingGL() {
    let n = 0;
    const obj = (t) => ({ __tag: t, __id: ++n });
    const counts = {};
    const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
    const listeners = {};
    const canvas = {
        addEventListener: (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); },
        removeEventListener: (type, fn) => { const a = listeners[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    };
    const noop = () => {};
    const lastUpload = { off: -1, cnt: -1 };
    return {
        __counts: counts,
        __lastUpload: lastUpload,
        __fire: (type, ev) => { const a = listeners[type]; if (a) for (const fn of a.slice()) fn(ev || { preventDefault() {} }); },
        canvas,
        COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
        ARRAY_BUFFER: 0x8892, FLOAT: 0x1406, DYNAMIC_DRAW: 0x88e8, STATIC_DRAW: 0x88e4,
        POINTS: 0x0000, TRIANGLE_STRIP: 0x0005, drawingBufferWidth: 800, drawingBufferHeight: 600,
        TEXTURE_2D: 0x0de1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
        TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, NEAREST: 0x2600,
        FRAMEBUFFER: 0x8d40, COLOR_ATTACHMENT0: 0x8ce0, FRAMEBUFFER_BINDING: 0x8ca6,
        COLOR_BUFFER_BIT: 0x4000, SCISSOR_TEST: 0x0c11, BLEND: 0x0be2, COLOR_CLEAR_VALUE: 0x0c22,
        createShader: () => obj("sh"), shaderSource: noop, compileShader: noop,
        getShaderParameter: () => true, getShaderInfoLog: () => "", deleteShader: noop,
        createProgram: () => { bump("createProgram"); return obj("pr"); },
        attachShader: noop, linkProgram: noop, getProgramParameter: () => true, getProgramInfoLog: () => "",
        deleteProgram: () => { bump("deleteProgram"); }, useProgram: noop,
        getUniformLocation: () => obj("u"), uniform2f: noop, uniform4f: noop, uniform1f: noop,
        createVertexArray: () => obj("vao"), createBuffer: () => obj("vbo"),
        bindVertexArray: noop, bindBuffer: noop, bufferData: noop,
        bufferSubData: (target, byteOffset, data, srcOffset, length) => { bump("bufferSubData"); lastUpload.off = srcOffset; lastUpload.cnt = length; },
        enableVertexAttribArray: noop, vertexAttribPointer: noop, deleteVertexArray: noop, deleteBuffer: noop,
        viewport: noop, drawArrays: () => { bump("drawArrays"); }, drawArraysInstanced: () => { bump("drawArraysInstanced"); }, vertexAttribDivisor: noop,
        createTexture: () => obj("t"), bindTexture: noop, texImage2D: noop, texParameteri: noop, deleteTexture: noop,
        createFramebuffer: () => obj("f"), bindFramebuffer: noop, framebufferTexture2D: noop, deleteFramebuffer: noop,
        readPixels(x, y, w, h, f, t, out) { out[0] = 1; out[1] = 2; out[2] = 3; out[3] = 255; },
        getParameter: () => null, isEnabled: () => false, enable: noop, disable: noop, scissor: noop, clearColor: noop, clear: noop,
    };
}

// ===========================================================================
// Tier T3 -- adversarial sequences: grow across a pow2 boundary mid-dirty-range.
// The grow copy must preserve every prior instance AND the still-open dirty range
// must flush correctly after the reallocation.
// ===========================================================================
function tierT3() {
    const errs = [];
    const check = (c, m) => { if (!c && errs.length < 8) errs.push(m); };
    const stride = LAYOUT.POINT;
    const f = createField({ capacity: 4, stride });   // pow2 4
    const sink = mockSink(1 << 16);                    // oversized shadow to survive growth
    let _v = 0;
    const w = (data, base) => { for (let k = 0; k < stride; k++) data[base + k] = _v * 100 + k; };

    for (let i = 0; i < 4; i++) { _v = i; f.push(w); }
    f.flush(sink); sink.reset();
    check(f.capacity === 4, "T3 capacity starts at pow2 4");

    // open a dirty range on an existing instance, then push past capacity -> grow.
    _v = 900; f.set(1, w);            // dirty [1,1]
    const capBefore = f.capacity;
    _v = 4; const i4 = f.push(w);     // triggers grow 4 -> 8, dirties 4
    check(f.capacity > capBefore, "T3 push past capacity grew the buffer (" + capBefore + "->" + f.capacity + ")");
    check(i4 === 4, "T3 grown push index stays contiguous");

    for (let i = 0; i < 4; i++) {
        const exp = (i === 1 ? 900 : i) * 100;
        check(f.data[i * stride] === exp, "T3 instance " + i + " preserved across grow");
    }
    check(f.dirtyLo() === 1 && f.dirtyHi() === 4, "T3 dirty range coalesces across grow to [1,4]");
    f.flush(sink);
    check(sink.off === 1 * stride && sink.cnt === (4 - 1 + 1) * stride, "T3 flush uploads exactly [1,4] after grow");
    for (let i = 0; i < f.count; i++) {
        const b = i * stride;
        for (let k = 0; k < stride; k++) {
            if (sink.shadow[b + k] !== f.data[b + k]) { check(false, "T3 shadow diverged @" + i); i = f.count; break; }
        }
    }

    // random walk thrashing the grow path near pow2 edges.
    const f2 = createField({ capacity: 2, stride });
    let seed = 0x9e3779b1;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
    for (let step = 0; step < 5000; step++) {
        if (rnd() < 0.6) { _v = step; f2.push(w); }
        else if (f2.count > 0) { f2.swapRemove((rnd() * f2.count) | 0); }
        check((f2.capacity & (f2.capacity - 1)) === 0, "T3 capacity stays a power of two");
        check(f2.capacity >= f2.count, "T3 capacity always covers count");
    }
    record("T3 grow across pow2 boundary mid-dirty-range", errs.length === 0, errs.join("; "));
}

// ===========================================================================
// Tier T4 -- handle/buffer abuse (lifecycle / context loss).
//   (a) dispose() then flush()/frame() -> no-op (GL2 GL-09 guard).
//   (b) double dispose() -> idempotent, no throw.
//   (c) context loss + restore -> one full re-upload, for POINT and POINT_HI.
//   (d) program-cache refcount returns to 0 (a fresh sink relinks after teardown).
// ===========================================================================
function tierT4() {
    const errs = [];
    const check = (c, m) => { if (!c) errs.push(m); };
    const { reactiveField: rf } = createDriver({ effect: sEffect, onCleanup: sOnCleanup, dispose: sDispose });

    // (a)+(b): post-dispose flush no-op + double dispose.
    const gl = countingGL();
    const sink = createPointSink(gl, { capacity: 64 });
    const field = createField({ capacity: 64, stride: LAYOUT.POINT });
    field.setCount(8);
    let handle;
    const scopeDispose = createScope((d) => {
        handle = rf(field, { manual: true, sink, project: (fl) => { fl.touchAll(); } });
        return d;
    });
    handle.flush();
    const drawsBefore = gl.__counts.drawArrays || 0;
    const uploadsBefore = gl.__counts.bufferSubData || 0;
    check(drawsBefore >= 1, "T4 flush draws before dispose");

    handle.dispose();
    handle.flush();   // GL-09: must be a no-op now
    handle.frame();   // frame() was already guarded
    check((gl.__counts.drawArrays || 0) === drawsBefore, "T4 flush after dispose does NOT draw (GL-09)");
    check((gl.__counts.bufferSubData || 0) === uploadsBefore, "T4 flush after dispose does NOT upload");

    let threw = false; try { handle.dispose(); } catch (_e) { threw = true; }
    check(!threw, "T4 double dispose does not throw");
    scopeDispose();
    sink.dispose();

    // (c): context loss + restore re-seeds the whole active range in ONE upload.
    for (const layout of ["POINT", "POINT_HI"]) {
        const g = countingGL();
        const L = layouts[layout];
        const s = L.make(g, 64);
        const fld = createField({ capacity: 64, stride: L.stride });
        fld.setCount(10);
        const dsp = createScope((d) => {
            rf(fld, { manual: true, sink: s, project: (fl) => { for (let i = 0; i < 10; i++) fl.touch(i); } });
            return d;
        });
        fld.touchAll(); fld.flush(s);   // initial seed (outside the measured window)
        const upBefore = g.__counts.bufferSubData || 0;
        g.__fire("webglcontextlost", { preventDefault() {} });
        check(s.isContextLost(), "T4 " + layout + " reports context lost");
        g.__fire("webglcontextrestored");
        check(!s.isContextLost(), "T4 " + layout + " reports restored");
        const upAfter = g.__counts.bufferSubData || 0;
        check(upAfter === upBefore + 1, "T4 " + layout + " restore re-seeds in ONE upload (" + (upAfter - upBefore) + ")");
        // ...and that upload is the WHOLE active range [0, count-1], not a partial re-seed.
        check(g.__lastUpload.off === 0 && g.__lastUpload.cnt === 10 * L.stride,
            "T4 " + layout + " re-seed spans [0,count-1] (off=" + g.__lastUpload.off + " cnt=" + g.__lastUpload.cnt + " expected 0/" + (10 * L.stride) + ")");
        dsp();
        s.dispose();
    }

    // (d): program-cache refcount returns to 0 -- a fresh sink after full teardown relinks.
    const gc2 = countingGL();
    const a = createPointSink(gc2, { capacity: 16 });
    const b = createPointSink(gc2, { capacity: 16 });   // shares the 'point' program (refcount 2)
    const createdWhileShared = gc2.__counts.createProgram || 0;
    a.dispose();   // refcount 1 -> program NOT deleted
    check((gc2.__counts.deleteProgram || 0) === 0, "T4 disposing one of two sharers keeps the shared program");
    b.dispose();   // refcount 0 -> program deleted
    check((gc2.__counts.deleteProgram || 0) >= 1, "T4 disposing the last sharer deletes the program (refcount 0)");
    const c = createPointSink(gc2, { capacity: 16 });   // cache emptied -> must relink
    check((gc2.__counts.createProgram || 0) > createdWhileShared, "T4 a fresh sink after full teardown relinks (cache emptied to 0)");
    c.dispose();

    record("T4 dispose/flush guard, context-loss re-seed, program-cache refcount", errs.length === 0, errs.join("; "));
}

// ===========================================================================
// Tier T5 -- differential fuzz against a naive full-upload oracle. Identical op
// streams applied to the real dirty-range field and a naive oracle (uploads the
// WHOLE active range every flush): active-range buffers must stay identical, and
// the real field must upload <= the oracle's floats (the dirty-range win is real).
// ===========================================================================
function tierT5() {
    const errs = [];
    const check = (c, m) => { if (!c && errs.length < 8) errs.push(m); };
    const stride = LAYOUT.QUAD;
    const cap = 512;
    const f = createField({ capacity: cap, stride });
    const sink = mockSink(cap * stride);

    // oracle: identical data, but every flush re-uploads the whole active range.
    const oData = new Float32Array(cap * stride);
    let oCount = 0, oDirty = false;

    let _v = 0;
    const wReal = (data, base) => { for (let k = 0; k < stride; k++) data[base + k] = (_v * 7 + k) & 0xffff; };
    const applyOracleWrite = (base) => { for (let k = 0; k < stride; k++) oData[base + k] = (_v * 7 + k) & 0xffff; };

    let seed = 0x51ed270b;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };

    let realFloats = 0, oracleFloats = 0;
    const flushBoth = () => {
        sink.reset();
        f.flush(sink);
        if (sink.uploads > 0) realFloats += sink.cnt;
        if (oDirty && oCount > 0) oracleFloats += oCount * stride;
        oDirty = false;
        for (let i = 0; i < f.count; i++) {
            const b = i * stride;
            for (let k = 0; k < stride; k++) {
                if (f.data[b + k] !== oData[b + k]) { check(false, "T5 field vs oracle diverged @" + i + "," + k); return; }
            }
        }
    };

    f.setCount(0);
    for (let step = 0; step < 10000; step++) {
        const r = rnd();
        if (r < 0.4 && f.count < cap) {
            _v = step; const i = f.push(wReal); applyOracleWrite(i * stride); oCount++; oDirty = true;
        } else if (r < 0.7 && f.count > 0) {
            const i = (rnd() * f.count) | 0; _v = step; f.set(i, wReal); applyOracleWrite(i * stride); oDirty = true;
        } else if (r < 0.85 && f.count > 0) {
            const i = (rnd() * f.count) | 0, last = f.count - 1;
            f.swapRemove(i);
            if (i !== last) { for (let k = 0; k < stride; k++) oData[i * stride + k] = oData[last * stride + k]; oDirty = true; }
            oCount = last;
        } else {
            flushBoth();
        }
    }
    flushBoth();

    check(realFloats <= oracleFloats, "T5 real uploads <= oracle (" + realFloats + " <= " + oracleFloats + ")");
    check(realFloats < oracleFloats, "T5 dirty-range strictly beats full-upload on a non-trivial stream (" + realFloats + " < " + oracleFloats + ")");
    record("T5 differential fuzz vs naive full-upload oracle", errs.length === 0, errs.length ? errs.join("; ") : ("real=" + realFloats + " oracle=" + oracleFloats + " floats"));
}

// ===========================================================================
// Tier T6 -- the zero-alloc gate. project + flush(upload+draw) for every layout
// must read below the instrument floor with zero major GCs. pick() is a REAL
// sub-gate folded in here (GL3): its per-call getParameter(COLOR_CLEAR_VALUE)
// Float32Array is gone, so 10k+ isolated picks must net 0 B/op with zero major
// GC. If pick allocates, this tier FAILS -- there is no pending marker to hide it.
// ===========================================================================
async function tierT6() {
    const errs = [];
    const ITERS = 1_000_000;
    const CAP = 4096;
    const N = 2000;

    // Calibration: an empty op (identical sampling) measures the instrument's own
    // fixed cost. Every hot path is gated on its NET reading (perOp - calib), so
    // the sampler's overhead is subtracted out rather than charged to the code
    // under test. A truly zero-alloc frame nets ~0; a single injected object nets
    // ~14 B/op (T9). The floor of 1.0 B/op sits below any real per-op allocation.
    const calib = await bytesPerOp(ITERS, (i) => { _proj[0] = i; _proj[1] = i * 0.5; });
    const netPasses = (r) =>
        r.source === "gc" && r.supported && r.observed && r.major === 0 &&
        (r.perOp - calib.perOp) < INSTRUMENT_FLOOR;
    let worstNet = 0;
    let worstPick = 0;

    for (const name of Object.keys(layouts)) {
        const L = layouts[name];
        const gl = silentGL();
        const sink = L.make(gl, CAP);
        const f = createField({ capacity: CAP, stride: L.stride });
        f.setCount(N);
        const write = L.write;
        const mask = 1023;
        // one hot frame: re-project one instance, flush the dirty window + draw.
        const frame = (i) => { _proj[0] = i; _proj[1] = i * 0.5; f.set(i & mask, write); f.flush(sink); };
        const r = await bytesPerOp(ITERS, frame);
        const net = r.perOp - calib.perOp;
        if (net > worstNet) worstNet = net;
        if (!netPasses(r)) {
            errs.push(name + " frame netPerOp=" + net.toFixed(3) + " (perOp=" + r.perOp.toFixed(3) + ") major=" + r.major);
        }

        // pick sub-gate (GL3): pick() must now allocate NOTHING. 100k isolated
        // picks (>> the 10k floor) net against the same calibration; a real PASS
        // folded into the gate, not a pending line.
        const pick = await bytesPerOp(100000, () => { sink.pick(10, 10, N); });
        const pickNet = pick.perOp - calib.perOp;
        if (pickNet > worstPick) worstPick = pickNet;
        if (!(pick.source === "gc" && pick.supported && pick.observed && pick.major === 0 && pickNet < INSTRUMENT_FLOOR)) {
            errs.push(name + ".pick netPerOp=" + pickNet.toFixed(3) + " (perOp=" + pick.perOp.toFixed(3) + ") major=" + pick.major);
        }
        sink.dispose();
    }

    const ok = errs.length === 0;
    const worstReport = worstNet < 0 ? 0 : worstNet;
    const pickReport = worstPick < 0 ? 0 : worstPick;
    const detail = "calib=" + calib.perOp.toFixed(3) + "B/op worstFrameNet=" + worstReport.toFixed(3)
        + "B/op worstPickNet=" + pickReport.toFixed(3) + "B/op";
    record("T6 zero-alloc project+flush+draw + pick (POINT/POINT_HI/QUAD/LINE)", ok, detail + (ok ? "" : " | " + errs.join("; ")));
    return worstReport;
}

// ===========================================================================
// Tier T7 -- soak and conservation.
//   (a) 1M-instance soak, 600 frames: no major GC, maxPause < 2ms, heap flat.
//   (b) 200 create/dispose cycles: lite-leak tracker.size() returns to baseline.
// ===========================================================================
async function tierT7() {
    const errs = [];
    const check = (c, m) => { if (!c) errs.push(m); };

    // (a) 1M soak.
    const CAP = 1 << 20; // 1,048,576
    const stride = LAYOUT.POINT;
    const gl = silentGL();
    const sink = createPointSink(gl, { capacity: CAP });
    const f = createField({ capacity: CAP, stride });
    f.setCount(1_000_000);
    let _v = 0;
    const w = (data, base) => { for (let k = 0; k < stride; k++) data[base + k] = _v + k; };
    // seed once, outside the measured window.
    f.touchAll(); f.flush(sink);
    globalThis.gc();

    const gc = new GcProfiler(1024, { source: "gc" }).start();
    let firstHeap = 0, lastHeap = 0;
    for (let frame = 0; frame < 600; frame++) {
        // mutate a moving 4096-wide window in place (zero allocation).
        const start = (frame * 4096) % 900000;
        _v = frame;
        for (let i = 0; i < 4096; i++) f.set(start + i, w);
        f.flush(sink);
        const hu = process.memoryUsage().heapUsed;
        gc.sampleHeap(performance.now(), hu);
        if (frame === 0) firstHeap = hu;
        lastHeap = hu;
    }
    await gc.settle();
    const s = gc.summary();
    gc.stop();
    const rep = checkNoGc(s, { maxMajor: 0, maxPauseMs: 2 });
    check(rep.ok, "1M soak: maxMajor=0 & maxPause<2ms (major=" + s.gc.major + " maxMs=" + s.gc.maxMs.toFixed(2) + ")");
    const heapGrowth = (lastHeap - firstHeap) / (1024 * 1024);
    check(heapGrowth < 8, "1M soak: heap trend flat (growth=" + heapGrowth.toFixed(2) + " MiB)");
    sink.dispose();

    // (b) create/dispose conservation via lite-leak.
    //
    // lite-leak's contract (verified against Leak.js): track(target, cleanup, tag)
    // registers `target` in a FinalizationRegistry; `untrack(handle)` is the CLEAN
    // release (size--, no report); a finalizer that fires while STILL registered --
    // i.e. the target was collected without an untrack -- is a confirmed leak and
    // invokes `onLeak` (Leak.js:495-499). Auto-untrack only happens for tracks made
    // inside lite-leak's OWN nested lite-signal owner tree; lite-gl's driver runs on
    // the top-level lite-signal instance, so here untrack is explicit.
    //
    // Therefore the dispose contract is: on a PROPER teardown we untrack; a FORGOTTEN
    // teardown is exactly "tracked, then lost without untrack". The gate's power to
    // catch a leak is proven by the two negative controls below, NOT by the positive
    // path's size (which the reviewer rightly noted is tautological on its own).
    //
    // Kernels: the orphan classifiers are near-inert for lite-gl's HEADLESS surface,
    // and two are actively harmful, so we register only the three that are safe and
    // non-noisy. The load-bearing retention observer here is tracker.size()/onLeak.
    //   - listener-orphan is OMITTED: it strong-references every canvas context-loss
    //     listener the sink registers, pinning the sink so it never collects --
    //     verified to defeat the size/finalizer gate.
    //   - timer-orphan is OMITTED: lite-gl (manual driver) sets no timers, and the
    //     kernel would flag the harness's OWN finalizer-settle setTimeout as a
    //     spurious `timer-orphan:no-owner-set`.
    const leaks = [];
    const warns = [];
    const tracker = createLeakTracker({
        name: "gl-conservation",
        onLeak: (r) => leaks.push(r.kind + ":" + String(r.tag)),
        onWarning: (wn) => warns.push(wn.kind + ":" + wn.reason),
    });
    tracker.registerKernel(createOwnerCascadeOrphanKernel());
    tracker.registerKernel(createObserverOrphanKernel());
    tracker.registerKernel(createAsyncRetentionKernel());

    const { reactiveField: rf } = createDriver({ effect: sEffect, onCleanup: sOnCleanup, dispose: sDispose });
    const NOOP = () => {};              // held-value contract: does NOT close over the target.
    const baseline = tracker.size();
    const leaksAt = () => leaks.length;

    // Robustly drain the FinalizationRegistry: several GC + macrotask passes. A
    // single tick is not enough -- V8 delivers finalizers on a later task.
    const settleFinalizers = async (passes) => {
        for (let i = 0; i < passes; i++) {
            globalThis.gc();
            await new Promise((r) => setTimeout(r, 10));
        }
    };
    // Evict the last-created object from a lingering register/stack slot so exact
    // collection is reachable (V8 can keep the most recent value pinned).
    const flushRegisters = () => { let j = null; for (let i = 0; i < 4000; i++) j = { x: i }; return j; };

    // POSITIVE: 200 full create -> dispose -> untrack cycles. Proper teardown must
    // leave nothing registered and raise no leak. Runs in its own function so the
    // last iteration's refs are gone before we settle.
    const churnProper = (cycles) => {
        for (let c = 0; c < cycles; c++) {
            const s2 = createPointSink(silentGL(), { capacity: 1024 });
            const fld = createField({ capacity: 1024, stride: LAYOUT.POINT });
            fld.setCount(16);
            const scopeDispose = createScope((d) => {
                rf(fld, { manual: true, sink: s2, project: (ff) => { ff.touch(0); } });
                return d;
            });
            const handle = tracker.track(s2, NOOP, "sink", { audit: true });
            scopeDispose();          // dispose the reactive driver (unsubscribes restore, stops effect)
            s2.dispose();            // release GL resources + shared programs
            tracker.untrack(handle); // the dispose contract: proper teardown = untrack
        }
    };
    churnProper(200);
    flushRegisters();
    await settleFinalizers(10);
    const live = tracker.size();
    const findings = tracker.audit();
    const properLeaks = leaksAt() - 0;
    check(live === baseline, "conservation: size back to baseline after 200 proper create/dispose (" + live + " vs " + baseline + ")");
    check(findings.length === 0, "conservation: no orphan findings (" + findings.length + ")");
    check(properLeaks === 0, "conservation: proper teardown raises no leak (" + properLeaks + ")");

    // NEGATIVE CONTROL 1 -- retained-without-untrack (a leaked resource kept alive).
    // The conservation check MUST fail: size stays elevated by exactly N. If it does
    // not, the size gate is blind and T7 fails.
    const RETAIN = 40;
    const retained = [];
    for (let c = 0; c < RETAIN; c++) {
        const s2 = createPointSink(silentGL(), { capacity: 256 });
        const h = tracker.track(s2, NOOP, "leaked-retained", { audit: true });
        retained.push({ s2, h });          // strong ref: cannot collect, never untracked
    }
    flushRegisters();
    await settleFinalizers(6);
    const leakedLive = tracker.size();
    check(leakedLive >= baseline + RETAIN, "negative control 1: retaining " + RETAIN + " sinks keeps size elevated (" + leakedLive + " >= " + (baseline + RETAIN) + ")");
    // untrack + drop to restore the baseline so control 2 starts clean.
    for (const r of retained) tracker.untrack(r.h);
    retained.length = 0;
    flushRegisters();
    await settleFinalizers(6);
    const recovered = tracker.size();
    check(recovered === baseline, "negative control 1: untrack restores baseline (" + recovered + " vs " + baseline + ")");

    // NEGATIVE CONTROL 2 -- forgotten-teardown: tracked, then dropped WITHOUT untrack
    // and WITHOUT dispose. The finalizer fires while still registered, so onLeak must
    // report it. If no leak is raised, the finalizer gate is blind and T7 fails.
    const leaksBefore = leaksAt();
    const churnForgotten = (n) => {
        for (let c = 0; c < n; c++) {
            const s2 = createPointSink(silentGL(), { capacity: 256 });
            tracker.track(s2, NOOP, "leaked-forgotten", { audit: true });
            // no dispose, no untrack, ref dropped at loop end -> collected while registered
        }
    };
    churnForgotten(40);
    flushRegisters();
    await settleFinalizers(12);
    const forgottenLeaks = leaksAt() - leaksBefore;
    check(forgottenLeaks > 0, "negative control 2: forgotten teardown raises a leak via onLeak (" + forgottenLeaks + " > 0)");

    const detail = "1M soak major=" + s.gc.major + " maxMs=" + s.gc.maxMs.toFixed(2) +
        "; proper: size=" + live + "/" + baseline + " findings=" + findings.length + " leaks=" + properLeaks +
        "; negctrl1 retained=" + leakedLive + "(>=" + (baseline + RETAIN) + ") recovered=" + recovered +
        "; negctrl2 forgottenLeaks=" + forgottenLeaks +
        (warns.length ? " warnings=[" + warns.join(",") + "]" : "");
    record("T7 soak + create/dispose conservation (+ 2 negative controls)", errs.length === 0, errs.length ? errs.join("; ") : detail);
    return {
        live,
        baseline,
        findings: findings.length,
        warnings: warns.length,
        major: s.gc.major,
        minor: s.gc.minor,
        maxMs: s.gc.maxMs,
    };
}

// ===========================================================================
// Tier T9 -- controls. The gate MUST be able to fail.
//   (a) inject one {} per frame into a copy of the hot path -> must trip the gate.
//   (b) run with instrumentation disabled (source 'none') -> must report FAIL.
// ===========================================================================
async function tierT9() {
    const errs = [];
    const check = (c, m) => { if (!c) errs.push(m); };

    // (a) a POINT hot frame with one object allocated per frame. The object is
    // stored into a module-level ring and summed AFTER the run, so it provably
    // escapes -- V8 cannot scalar-replace it away and the control cannot silently
    // stop allocating.
    const gl = silentGL();
    const sink = createPointSink(gl, { capacity: 4096 });
    const f = createField({ capacity: 4096, stride: LAYOUT.POINT });
    f.setCount(2000);
    const write = layouts.POINT.write;
    const dirtyFrame = (i) => {
        _proj[0] = i; _proj[1] = i * 0.5;
        _t9ring[i & (_t9ring.length - 1)] = { x: i };   // the injected allocation, escapes
        f.set(i & 1023, write);
        f.flush(sink);
    };
    const rDirty = await bytesPerOp(300000, dirtyFrame);
    for (let k = 0; k < _t9ring.length; k++) { const o = _t9ring[k]; if (o) _t9sum += o.x; }
    const escaped = _t9sum !== 0;   // the allocation genuinely escaped
    check(escaped && !framePasses(rDirty), "injected {}/frame trips the gate (perOp=" + rDirty.perOp.toFixed(2) + "B/op, major=" + rDirty.major + ", escaped=" + escaped + ")");
    sink.dispose();

    // (b) instrumentation disabled: the precise channel is off (source 'none').
    const rNone = await bytesPerOp(50000, (i) => { _proj[0] = i; }, "none");
    check(!framePasses(rNone), "instrumentation disabled reports FAIL, not silent PASS (source=" + rNone.source + ")");

    const detail = "injected-{}/frame perOp=" + rDirty.perOp.toFixed(2) + "B/op -> tripped; " +
        "instrumentation-off source=" + rNone.source + " -> rejected";
    record("T9 controls (the gate can fail)", errs.length === 0, errs.length ? errs.join("; ") : detail);
}

// ===========================================================================
// Run.
// ===========================================================================
tierT0();
tierT1();
tierT2();
tierT3();
tierT4();
tierT5();
const worstFrame = await tierT6();
const t7 = await tierT7();
await tierT9();

let failed = 0;
for (const r of results) {
    console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.detail ? " -- " + r.detail : ""));
    if (!r.ok) failed++;
}

console.log(
    "GATE leak=size " + t7.live + "/" + t7.baseline +
    " findings=" + t7.findings + " warnings=" + t7.warnings +
    " | gc major=" + t7.major + " minor=" + t7.minor + " maxMs=" + t7.maxMs.toFixed(2) +
    " | alloc=" + worstFrame.toFixed(3) + " B/op | " + (failed === 0 ? "ok" : "FAIL")
);

if (failed !== 0) process.exit(1);
