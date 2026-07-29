import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, effect, stats, createScope } from "@zakkster/lite-signal";
import { createField, reactiveField, createDriver, LAYOUT, f32Ulp, needsHiPrecision, hiOf, loOf, writePointHi } from "../GL.js";

function withRoot(fn) {
    let ret;
    const disposer = createScope((d) => { ret = fn(); return d; });
    return { value: ret, dispose: disposer };
}

// A mock GPU sink: records uploads and draws, allocates nothing per call.
function mockSink() {
    return {
        uploads: 0, lastFloatOffset: -1, lastFloatCount: -1, lastInstanceOffset: -1,
        draws: 0, lastCount: -1,
        upload(_data, floatOffset, floatCount, instanceOffset) {
            this.uploads++; this.lastFloatOffset = floatOffset;
            this.lastFloatCount = floatCount; this.lastInstanceOffset = instanceOffset;
        },
        draw(count) { this.draws++; this.lastCount = count; },
    };
}

const wPoint = (x, y, s, r, g, b, a) => (data, base) => {
    data[base] = x; data[base + 1] = y; data[base + 2] = s;
    data[base + 3] = r; data[base + 4] = g; data[base + 5] = b; data[base + 6] = a;
};

test("push writes instances, grows by powers of two, and tracks count", () => {
    const f = createField({ capacity: 2, stride: LAYOUT.POINT });
    assert.equal(f.capacity, 2);
    f.push(wPoint(1, 2, 3, 1, 1, 1, 1));
    f.push(wPoint(4, 5, 6, 1, 1, 1, 1));
    f.push(wPoint(7, 8, 9, 1, 1, 1, 1));   // triggers growth 2 -> 4
    assert.equal(f.count, 3);
    assert.equal(f.capacity, 4);
    assert.equal(f.data[0], 1);
    assert.equal(f.data[2 * LAYOUT.POINT], 7, "third instance survived growth");
});

test("dirty range covers exactly the touched instances", () => {
    const f = createField({ capacity: 16, stride: LAYOUT.POINT });
    for (let i = 0; i < 10; i++) f.push(wPoint(i, i, 1, 1, 1, 1, 1));
    f.clearDirty();
    assert.equal(f.dirtyLo(), -1, "clean after clearDirty");
    f.set(3, wPoint(99, 99, 2, 1, 1, 1, 1));
    f.set(7, wPoint(88, 88, 2, 1, 1, 1, 1));
    assert.equal(f.dirtyLo(), 3);
    assert.equal(f.dirtyHi(), 7, "range spans the two edits");
});

test("flush uploads only the dirty range, then draws and clears", () => {
    const f = createField({ capacity: 16, stride: LAYOUT.POINT });
    for (let i = 0; i < 10; i++) f.push(wPoint(i, i, 1, 1, 1, 1, 1));
    f.clearDirty();
    const sink = mockSink();
    f.set(4, wPoint(0, 0, 0, 0, 0, 0, 0));
    f.set(6, wPoint(0, 0, 0, 0, 0, 0, 0));
    f.flush(sink);
    assert.equal(sink.uploads, 1);
    assert.equal(sink.lastInstanceOffset, 4, "upload starts at the first dirty instance");
    assert.equal(sink.lastFloatOffset, 4 * LAYOUT.POINT);
    assert.equal(sink.lastFloatCount, 3 * LAYOUT.POINT, "covers instances 4..6");
    assert.equal(sink.draws, 1);
    assert.equal(sink.lastCount, 10);
    assert.equal(f.dirtyLo(), -1, "dirty cleared after flush");
    f.flush(sink);
    assert.equal(sink.uploads, 1, "clean flush uploads nothing");
    assert.equal(sink.draws, 2, "but still draws");
});

test("swapRemove moves the last instance into the hole", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT });
    f.push(wPoint(10, 0, 1, 1, 1, 1, 1));   // 0
    f.push(wPoint(20, 0, 1, 1, 1, 1, 1));   // 1
    f.push(wPoint(30, 0, 1, 1, 1, 1, 1));   // 2
    f.swapRemove(0);
    assert.equal(f.count, 2);
    assert.equal(f.data[0], 30, "last (30) moved into slot 0");
});

test("reactive driver re-projects on signal change and flushes once per frame (dirty-gated)", () => {
    const camera = signal({ x: 0, scale: 1 });
    const xs = new Float32Array([0, 100, 200, 300]);   // 4 data points
    const sink = mockSink();

    const r = withRoot(() => {
        const f = createField({ capacity: 4, stride: LAYOUT.POINT });
        f.setCount(4);
        const project = (field) => {
            const cam = camera();                       // tracked
            for (let i = 0; i < 4; i++) {
                const sx = (xs[i] - cam.x) * cam.scale;
                field.set(i, wPoint(sx, 0, 2, 1, 1, 1, 1));
            }
        };
        const h = reactiveField(f, { project, sink, manual: true });
        return { f, h };
    });
    const { f, h } = r.value;

    // initial projection ran (effect), field is dirty
    assert.ok(f.dirtyLo() >= 0, "projected on creation");
    h.frame();
    assert.equal(sink.draws, 1);
    assert.equal(f.data[0], 0, "point 0 at x=0 (cam.x=0)");

    h.frame();
    assert.equal(sink.draws, 1, "no redraw when nothing changed (dirty-gated)");

    camera.set({ x: 50, scale: 2 });                    // pan + zoom -> re-project
    assert.ok(f.dirtyLo() >= 0, "camera change marked dirty");
    h.frame();
    assert.equal(sink.draws, 2);
    assert.equal(f.data[0], (0 - 50) * 2, "point 0 reprojected through the new camera");
    r.dispose();
});

test("1M-instance re-projection is zero-GC: the backing buffer is never reallocated", () => {
    const N = 1_000_000;
    const f = createField({ capacity: N, stride: LAYOUT.POINT });
    f.setCount(N);
    const bufRef = f.data;                               // capture the backing store
    const sink = mockSink();
    // warm
    for (let i = 0; i < N; i++) f.data[i * LAYOUT.POINT] = i;
    f.touchAll(); f.flush(sink);
    sink.draws = 0;                                      // discount the warm-up draw

    const base = stats();
    for (let frame = 0; frame < 60; frame++) {           // 60 frames of full re-projection
        const k = frame * 0.01;
        for (let i = 0; i < N; i++) {
            const base2 = i * LAYOUT.POINT;
            f.data[base2] = i + k;                        // re-project x in place
            f.data[base2 + 1] = i - k;
        }
        f.touchAll();
        f.flush(sink);
    }
    const after = stats();
    assert.equal(f.data, bufRef, "same Float32Array reference after 60 frames -> no reallocation");
    assert.equal(after.poolGrowths - base.poolGrowths, 0, "no engine pool growth");
    assert.equal(after.totalAllocations - base.totalAllocations, 0, "no engine allocations");
    assert.equal(sink.draws, 60, "drew every frame");
});

test("createDriver binds to an explicit registry", async () => {
    const mod = await import("@zakkster/lite-signal");
    const { reactiveField: rf } = createDriver(mod);
    const sig = signal(1);
    const sink = mockSink();
    const r = withRoot(() => {
        const f = createField({ capacity: 4, stride: LAYOUT.POINT });
        f.setCount(2);
        const h = rf(f, { manual: true, sink, project: (field) => { const v = sig(); field.set(0, wPoint(v, 0, 1, 1, 1, 1, 1)); } });
        return { f, h };
    });
    r.value.h.frame();
    assert.equal(sink.draws, 1);
    sig.set(42);
    r.value.h.frame();
    assert.equal(r.value.f.data[0], 42);
    r.dispose();
});

test("reactiveField re-seeds the whole active range when the sink's GL context is restored", () => {
    const f = createField({ capacity: 256, stride: LAYOUT.POINT });
    // A restorable mock sink: it captures the restore callback exactly as the WebGL2
    // backend's onContextRestored does, so we can fire it deterministically here.
    let fireRestore = null;
    const sink = {
        uploads: 0, lastFloatOffset: -1, lastFloatCount: -1, draws: 0, lastCount: -1,
        upload(_d, fo, fc) { this.uploads++; this.lastFloatOffset = fo; this.lastFloatCount = fc; },
        draw(c) { this.draws++; this.lastCount = c; },
        onContextRestored(cb) { fireRestore = cb; return () => { fireRestore = null; }; },
    };
    const N = signal(40);
    const r = withRoot(() => reactiveField(f, {
        manual: true, sink,
        project: (fld) => { const n = N(); for (let i = 0; i < n; i++) fld.set(i, wPoint(i, i, 2, 1, 1, 1, 1)); fld.setCount(n); },
    }));
    r.value.flush();                                  // initial upload + draw
    sink.uploads = 0; sink.lastFloatOffset = -1; sink.lastFloatCount = -1;

    assert.equal(typeof fireRestore, "function", "driver registered a restore handler on the sink");
    fireRestore();                                    // simulate webglcontextrestored (buffer rebuilt empty)

    assert.equal(sink.uploads, 1, "restore triggered exactly one re-upload");
    assert.equal(sink.lastFloatOffset, 0, "re-upload starts at instance 0");
    assert.equal(sink.lastFloatCount, 40 * f.stride, "re-upload covers the entire active range, not just a dirty window");
    r.dispose();
});

// ===========================================================================
//  v1.4.0 -- deep-zoom precision
// ===========================================================================

const f32 = Math.fround;

/**
 * Exactly what POINT_HI_VS computes, evaluated in float32 at every step.
 * If this is right, the shader is right -- the arithmetic is identical.
 */
function shaderRel(posHi, posLo, camHi, camLo) {
    return f32(f32(posHi - camHi) + f32(posLo - camLo));
}
/** What a plain float32 world coordinate would give (i.e. LAYOUT.POINT holding world coords). */
function naiveRel(world, cam) {
    return f32(f32(world) - f32(cam));
}

test("LAYOUT.POINT_HI is stride 10", () => {
    assert.equal(LAYOUT.POINT_HI, 10);
});

test("f32Ulp reports the float32 quantization step", () => {
    assert.equal(f32Ulp(1), Math.pow(2, -23));
    assert.equal(f32Ulp(16777216), 2);          // 2^24: integers stop being exact here
    assert.equal(f32Ulp(0), 0);
    assert.equal(f32Ulp(-1e6), f32Ulp(1e6));    // sign-independent
    assert.equal(f32Ulp(NaN), 0);
});

test("f32Ulp at epoch-ms is ~2.2 minutes -- the whole reason this layout exists", () => {
    const ulp = f32Ulp(1.78e12);
    assert.equal(ulp, 131072);
    assert.ok(ulp / 60000 > 2, "over two minutes between representable values");
});

test("needsHiPrecision flags time-series and clears ordinary ranges", () => {
    assert.equal(needsHiPrecision(1.78e12, 1000), true);   // 1s ticks in epoch-ms
    assert.equal(needsHiPrecision(1.78e9, 1), true);       // 1s ticks in epoch-seconds
    assert.equal(needsHiPrecision(1e6, 0.5), false);       // ordinary chart coords
    assert.equal(needsHiPrecision(1e4, 0.01), false);
});

test("hiOf + loOf reconstruct a float64 exactly", () => {
    for (const v of [1.78e12, -1.78e12, 1e-7, 0, 123456.789, Date.now() + 0.5]) {
        assert.equal(hiOf(v) + loOf(v), v, "round-trip " + v);
    }
});

test("hiOf and loOf are both genuine float32 values", () => {
    const v = 1.78e12 + 0.25;
    assert.equal(f32(hiOf(v)), hiOf(v));
    assert.equal(f32(loOf(v)), loOf(v));
});

test("a plain float32 world coord collapses a minute of 1s ticks to ~1 value", () => {
    const t0 = 1.78e12;
    const seen = new Set();
    for (let i = 0; i < 60; i++) seen.add(f32(t0 + i * 1000));
    // The ULP here is 131072 ms, wider than the whole 60 s span. Depending on where t0
    // sits on the rounding grid you land on one value, or straddle a boundary and get two.
    assert.ok(seen.size <= 2, "60 ticks -> " + seen.size + " float32 values; this is the bug POINT_HI fixes");
});

test("the hi/lo split keeps every one of those ticks distinct", () => {
    const t0 = 1.78e12;
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
        const v = t0 + i * 1000;
        seen.add(shaderRel(hiOf(v), loOf(v), hiOf(t0), loOf(t0)));
    }
    assert.equal(seen.size, 60);
});

test("relative-to-eye is BIT-EXACT for anything within a day of the camera", () => {
    const cam = 1.78e12;
    const camHi = hiOf(cam), camLo = loOf(cam);
    for (const d of [0, 1, 1000, 60000, 3.6e6, 8.64e7, -8.64e7]) {
        const world = cam + d;
        const rel = shaderRel(hiOf(world), loOf(world), camHi, camLo);
        assert.equal(rel - d, 0, "exact at " + d + " ms from the eye");
    }
});

test("error scales with distance from the EYE, not with absolute magnitude", () => {
    // This is the property that makes the scheme work, and it is worth stating as a test:
    // a naive float32 world coord is ruined by how big the numbers are. This one only
    // cares how far the point is from where you are looking.
    const near = 1e3, far = 1e6, huge = 1e12;
    for (const cam of [near, far, huge]) {
        const rel = shaderRel(hiOf(cam + 1000), loOf(cam + 1000), hiOf(cam), loOf(cam));
        assert.equal(rel, 1000, "1000 units from the eye is exact even at magnitude " + cam);
    }
});

test("sub-pixel error stays under 1e-3 px at ANY zoom, at ANY magnitude", () => {
    // The real guarantee. You only see distant points when zoomed OUT -- and the pixel
    // grows at the same rate the error does, so the error in PIXELS stays bounded.
    const cam = 1.78e12;
    const camHi = hiOf(cam), camLo = loOf(cam);
    for (const scale of [1e-2, 1e-3, 1e-6, 1e-9, 1e-11]) {   // px per world unit (ms)
        const halfW = 1000 / scale;                          // world half-width of a 2000px viewport
        let worstPx = 0;
        for (let i = 0; i <= 400; i++) {
            const d = -halfW + (2 * halfW * i) / 400;
            const world = cam + d;
            const rel = shaderRel(hiOf(world), loOf(world), camHi, camLo);
            worstPx = Math.max(worstPx, Math.abs(rel - d) * scale);
        }
        assert.ok(worstPx < 1e-3, "scale " + scale + " -> worst " + worstPx + " px");
    }
});

test("the naive float32 path breaks down at the SAME zoom levels", () => {
    const cam = 1.78e12;
    const scale = 1e-3;
    const halfW = 1000 / scale;
    let worstPx = 0;
    for (let i = 0; i <= 400; i++) {
        const d = -halfW + (2 * halfW * i) / 400;
        worstPx = Math.max(worstPx, Math.abs(naiveRel(cam + d, cam) - d) * scale);
    }
    assert.ok(worstPx > 10, "naive is off by >10 px where hi/lo is sub-milli-pixel, got " + worstPx);
});

test("the naive single-float32 path is off by tens of seconds where hi/lo is exact", () => {
    const cam = 1.78e12;
    let naiveWorst = 0, hiWorst = 0;
    for (let i = 0; i < 120; i++) {
        const world = cam + i * 1000;
        naiveWorst = Math.max(naiveWorst, Math.abs(naiveRel(world, cam) - (world - cam)));
        hiWorst = Math.max(hiWorst, Math.abs(shaderRel(hiOf(world), loOf(world), hiOf(cam), loOf(cam)) - (world - cam)));
    }
    assert.ok(naiveWorst > 30000, "naive float32 is off by >30s, got " + naiveWorst);
    assert.equal(hiWorst, 0);
});

test("the high parts cancel exactly (Sterbenz) -- that is what carries the scheme", () => {
    const cam = 1.78e12;
    for (let i = 0; i < 200; i++) {
        const world = cam + i * 997;
        const diff = f32(hiOf(world) - hiOf(cam));
        // Both operands are float32s within a factor of 2 of one another, so the
        // subtraction is exact: no rounding occurs.
        assert.equal(diff, hiOf(world) - hiOf(cam), "exact at i=" + i);
    }
});

test("writePointHi packs 10 floats and splits the coordinate", () => {
    const data = new Float32Array(LAYOUT.POINT_HI * 2);
    const x = 1.78e12 + 0.5, y = -9.99e11 + 0.25;
    writePointHi(data, 0, x, y, 3, 0.1, 0.2, 0.3, 0.4);
    assert.equal(data[0], hiOf(x));
    assert.equal(data[1], hiOf(y));
    assert.equal(data[2], loOf(x));
    assert.equal(data[3], loOf(y));
    assert.equal(data[4], 3);
    assert.equal(data[5], f32(0.1));
    assert.equal(data[8], f32(0.4));
    assert.equal(data[9], 0);
    // The pad and the next instance are untouched.
    assert.equal(data[10], 0);
});

test("writePointHi round-trips through the shader math to sub-millisecond accuracy", () => {
    const f = createField({ capacity: 64, stride: LAYOUT.POINT_HI });
    const cam = 1.78e12;
    const times = [];
    for (let i = 0; i < 50; i++) {
        const t = cam + i * 1000 + 0.5;           // half-millisecond offsets
        times.push(t);
        f.push((d, b) => writePointHi(d, b, t, 0, 2, 1, 1, 1, 1));
    }
    const d = f.data;
    for (let i = 0; i < 50; i++) {
        const b = i * LAYOUT.POINT_HI;
        const rel = shaderRel(d[b], d[b + 2], hiOf(cam), loOf(cam));
        assert.ok(Math.abs(rel - (times[i] - cam)) < 1e-3, "instance " + i + " within 1us");
    }
});

test("writePointHi allocates nothing and works with createField's dirty range", () => {
    const f = createField({ capacity: 8, stride: LAYOUT.POINT_HI });
    f.push((d, b) => writePointHi(d, b, 1.78e12, 5, 2, 1, 0, 0, 1));
    f.push((d, b) => writePointHi(d, b, 1.78e12 + 1000, 6, 2, 0, 1, 0, 1));
    assert.equal(f.count, 2);
    assert.equal(f.dirtyLo(), 0);
    assert.equal(f.dirtyHi(), 1);
    const sink = { ups: [], upload(_d, o, c) { this.ups.push([o, c]); }, draw() {} };
    f.flush(sink);
    assert.deepEqual(sink.ups, [[0, 20]]);   // 2 instances x stride 10
    assert.equal(f.dirtyLo(), -1);
});
