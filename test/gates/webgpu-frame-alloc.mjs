// test/gates/webgpu-frame-alloc.mjs -- node test/gates/webgpu-frame-alloc.mjs
//
// Fork B build gate for the WebGPU sink. Headless, GPU-free, and -- unlike torture --
// NO --expose-gc: it measures per-frame allocation by DETERMINISTIC INTEGER ACCOUNTING,
// not heap sampling, exactly the way test/gates/dirty-range.mjs counts uploaded floats.
//
// The faithful mock (test/mockWebGPU.mjs) attributes a NOMINAL byte cost to each per-frame
// device object it fabricates (createCommandEncoder / beginRenderPass / queue.submit). A
// steady-state frame (f.set(...); f.flush(sink)) is run through it and device.__alloc is
// read back. The baseline is a property of the MOCK, not a real driver.
//
// Three assertions:
//   (1) measured bytes/frame === BASELINE_BYTES_PER_FRAME, ZERO TOLERANCE (baseline+1 fails).
//   (2) the CORE's own contribution nets < CORE_FLOOR through the NON-faithful mock
//       (device fabrication off): the WebGPU sink adds no per-frame allocation the mock
//       does not account for, so a recording frame accounts exactly 0.
//   (3) a self-control that injects ONE extra per-frame device object MUST exceed the
//       baseline -- proving the gate can fail.
//
// TO UPDATE THE BASELINE (a DELIBERATE change to the sink's per-frame device calls or to
// the mock's nominal costs only): run this file, read the printed measured value, and set
// BASELINE_BYTES_PER_FRAME to it in the SAME commit. An accidental extra encoder/pass/
// submit per frame fails here instead of shipping.
//
// MIT (c) 2026 Zahary Shinikchiev

import { createField, LAYOUT } from "../../GL.js";
import { createGPUTarget, createGPUPointSink } from "../../GLWebGPU.js";
import { mockWebGPU, WEBGPU_FRAME_BASELINE, GPU_COST_ENCODER } from "../mockWebGPU.mjs";

// The committed baseline: encoder + render pass + submit for one dirty frame = 192 bytes.
const BASELINE_BYTES_PER_FRAME = 192;
// Below this the core's own per-frame contribution is treated as zero. Integer accounting
// makes the recording-mode reading exactly 0, so this is a strict, non-hugged threshold.
const CORE_FLOOR = 1.0;

const CAP = 4096;
const N = 2000;
const STRIDE = LAYOUT.POINT;

function writeInstance(d, b) {
  d[b] = 10; d[b + 1] = 20; d[b + 2] = 3;
  d[b + 3] = 1; d[b + 4] = 1; d[b + 5] = 1; d[b + 6] = 1; d[b + 7] = 0;
}

// Build a seeded sink+field on the given mock, return { device, sink, field }.
async function seed(faithful) {
  const m = mockWebGPU({ faithful });
  const target = await createGPUTarget(m.canvas, { device: m.device });
  const sink = createGPUPointSink(target, { capacity: CAP });
  const f = createField({ capacity: CAP, stride: STRIDE });
  f.setCount(N);
  for (let i = 0; i < N; i++) f.set(i, writeInstance);
  f.flush(sink);          // seed upload+draw (outside the measured window)
  return { device: m.device, sink, field: f, target };
}

// --- (1) faithful: exact bytes for one steady-state frame ------------------
const faith = await seed(true);
faith.device.__resetAlloc();
faith.field.set(3, writeInstance);       // one-instance dirty window
faith.field.flush(faith.sink);           // upload the window + draw
const measured = faith.device.__alloc;
const baselineOk = measured === BASELINE_BYTES_PER_FRAME;

// --- (2) recording (non-faithful): the core adds nothing the mock misses ---
const rec = await seed(false);
rec.device.__resetAlloc();
rec.field.set(3, writeInstance);
rec.field.flush(rec.sink);
const coreBytes = rec.device.__alloc;
const coreOk = coreBytes < CORE_FLOOR;

// --- (3) self-control: one extra per-frame device object trips the gate ----
const ctrl = await seed(true);
ctrl.device.__resetAlloc();
ctrl.field.set(3, writeInstance);
ctrl.field.flush(ctrl.sink);
ctrl.device.createCommandEncoder();      // the regression: an extra encoder per frame (+GPU_COST_ENCODER)
const regressed = ctrl.device.__alloc;
const controlOk = regressed > BASELINE_BYTES_PER_FRAME && (regressed - measured) === GPU_COST_ENCODER;

console.log(
  "webgpu-frame-alloc gate: measured=" + measured + " baseline=" + BASELINE_BYTES_PER_FRAME
  + " (" + (baselineOk ? "MATCH" : "MISMATCH") + ")"
);
console.log(
  "  core contribution (recording mock): " + coreBytes + " B/frame < " + CORE_FLOOR
  + " -> " + (coreOk ? "core allocates nothing per frame" : "CORE REGRESSED")
);
console.log(
  "  control (one extra per-frame object): total=" + regressed
  + " -> " + (controlOk ? "exceeds baseline (gate CAN fail)" : "DID NOT trip -- gate is blind!")
);

if (baselineOk && coreOk && controlOk) {
  console.log("PASS webgpu-frame-alloc zero-tolerance gate");
  process.exit(0);
} else {
  if (!baselineOk) {
    console.error(
      "FAIL: bytes/frame " + measured + " != baseline " + BASELINE_BYTES_PER_FRAME
      + ". The sink's per-frame device calls (encoder/pass/submit) changed. If DELIBERATE, "
      + "update BASELINE_BYTES_PER_FRAME to " + measured + " in the same commit."
    );
  }
  if (!coreOk) console.error("FAIL: the core allocated " + coreBytes + " B/frame through the recording mock (expected 0).");
  if (!controlOk) console.error("FAIL: the self-control did not exceed the baseline -- the gate cannot detect a regression.");
  console.log("FAIL webgpu-frame-alloc zero-tolerance gate");
  process.exit(1);
}
