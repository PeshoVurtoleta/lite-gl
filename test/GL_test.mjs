import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, effect, stats, createScope } from "@zakkster/lite-signal";
import { createField, reactiveField, createDriver, LAYOUT } from "../GL.js";

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
