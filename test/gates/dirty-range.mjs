// test/gates/dirty-range.mjs -- node test/gates/dirty-range.mjs
//
// GL7: the zero-tolerance dirty-range build gate. Headless, GPU-free (mock sink
// only). A deterministic op stream (append N, scatter-edit K single instances each
// flushed, swap-remove M) runs against a mock sink that SUMS the uploaded float
// count. The exact total is a COMMITTED baseline constant below. The gate fails
// (non-zero exit) if the measured total differs from the baseline by even ONE float
// -- which is exactly what happens if `flush` regresses to re-upload the whole
// buffer on a single-instance edit.
//
// A self-control (T9-style) simulates that full-buffer-upload regression and
// confirms the gate goes RED, so the gate is proven able to fail. It is NOT left
// tripped: the real scenario uses the shipped dirty-range flush.
//
// TO UPDATE THE BASELINE (a DELIBERATE dirty-range contract change only): run this
// file, read the printed measured total, and set BASELINE to it in the SAME commit
// as the contract change. An accidental change fails here instead of shipping.
//
// MIT (c) 2026 Zahary Shinikchiev

import { createField, LAYOUT } from "../../GL.js";

// ---------------------------------------------------------------------------
// The committed baseline: the EXACT total floats the dirty-range flush uploads
// for the scenario below. Append 1000 (one flush: 1000*8), then 64 single-instance
// edits each flushed (64*8), then 32 swap-removes each flushed (32*8):
//   8000 + 512 + 256 = 8768 floats.
// Zero tolerance: any deviation is a regression (a one-instance edit that
// re-uploads the whole buffer would blow this up by orders of magnitude).
// ---------------------------------------------------------------------------
const BASELINE = 8768;

const STRIDE = LAYOUT.POINT;            // 8 floats / instance
const CAPACITY = 4096;
const APPEND_N = 1000;
const SCATTER_K = 64;
const REMOVE_M = 32;

// A mock sink that only sums the uploaded float count. Zero GPU, zero allocation
// per call beyond the counter. `draw` is a no-op sink for the count.
function sumSink() {
    return {
        floatsUploaded: 0,
        draws: 0,
        upload(data, floatOffset, floatCount) { this.floatsUploaded += floatCount; },
        draw(count) { this.draws++; },
    };
}

// A deterministic instance writer (values do not affect the float COUNT, only the
// data; the gate measures counts, so any fill is fine -- keep it deterministic).
function writeInstance(data, base, v) {
    for (let k = 0; k < STRIDE; k++) data[base + k] = (v * 7 + k) & 0xffff;
}

// Deterministic scatter indices in [0, APPEND_N): a fixed stride walk, all distinct
// enough to exercise scattered single-instance edits far apart in the buffer.
function scatterIndex(i) { return (i * 61 + 7) % APPEND_N; }

// Run the fixed scenario, flushing through `flushFn(field, sink)`. Returns the
// total floats the sink saw. `flushFn` is the ONLY variable -- the real gate passes
// the shipped dirty-range flush; the control passes a broken full-buffer flush.
function runScenario(flushFn) {
    const f = createField({ capacity: CAPACITY, stride: STRIDE });
    const sink = sumSink();

    // Phase A: append N, then ONE flush -> dirty [0, N-1].
    for (let i = 0; i < APPEND_N; i++) f.push((d, b) => writeInstance(d, b, i));
    flushFn(f, sink);

    // Phase B: scatter-edit K specific instances, each flushed on its own -> each is
    // a single-instance dirty window. This is the load-bearing catch: a regression
    // that re-uploads the whole buffer on a one-instance edit explodes here.
    for (let i = 0; i < SCATTER_K; i++) {
        const idx = scatterIndex(i);
        f.set(idx, (d, b) => writeInstance(d, b, 1000 + i));
        flushFn(f, sink);
    }

    // Phase C: swap-remove M times (always index 0 while count > 1, so the moved
    // last instance lands in slot 0 -> a single-instance dirty window), each flushed.
    for (let i = 0; i < REMOVE_M; i++) {
        if (f.count > 1) f.swapRemove(0);
        flushFn(f, sink);
    }

    return sink.floatsUploaded;
}

// The shipped dirty-range flush.
const realFlush = (f, sink) => f.flush(sink);

// The simulated regression: re-upload the WHOLE active range on every flush,
// ignoring the dirty window. This is precisely the bug the gate exists to catch.
function regressedFlush(f, sink) {
    if (f.count > 0) sink.upload(f.data, 0, f.count * STRIDE, 0, STRIDE);
    f.clearDirty();
    sink.draw(f.count);
}

// --- run the real scenario against the committed baseline (zero tolerance) ---
const measured = runScenario(realFlush);
const realOk = measured === BASELINE;

// --- self-control: the regression MUST diverge from the baseline (gate can fail) ---
const regressed = runScenario(regressedFlush);
const controlOk = regressed !== BASELINE && regressed > BASELINE;

console.log(
    "dirty-range gate: measured=" + measured + " baseline=" + BASELINE
    + " (" + (realOk ? "MATCH" : "MISMATCH") + ")"
);
console.log(
    "  control (simulated full-buffer regression): total=" + regressed
    + " -> " + (controlOk ? "diverges from baseline (gate CAN fail)" : "DID NOT diverge -- gate is blind!")
);

if (realOk && controlOk) {
    console.log("PASS dirty-range zero-tolerance gate");
    process.exit(0);
} else {
    if (!realOk) {
        console.error(
            "FAIL: uploaded float total " + measured + " != baseline " + BASELINE
            + ". A single-instance edit is re-uploading more than its dirty window "
            + "(likely the whole buffer), or the dirty-range contract changed. If the "
            + "change is DELIBERATE, update BASELINE to " + measured + " in the same commit."
        );
    }
    if (!controlOk) {
        console.error("FAIL: the self-control did not diverge -- the gate cannot detect a regression.");
    }
    console.log("FAIL dirty-range zero-tolerance gate");
    process.exit(1);
}
