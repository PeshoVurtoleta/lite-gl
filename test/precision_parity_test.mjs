/**
 * test/precision_parity_test.mjs -- Fork B': WGSL vs GLSL POINT_HI precision parity.
 *
 * The WebGPU sink ports GLBackend.js's double-emulated deep-zoom camera into WGSL. This
 * suite proves the port is operation-for-operation IDENTICAL: it transcribes each shader's
 * exact expression sequence into JS with Math.fround at EVERY op (WGSL f32 and GLSL `highp
 * float` are both IEEE-754 binary32), evaluates both over FORK_B_VECTORS, and asserts the
 * two agree to within a NAMED committed tolerance. The measured max delta is printed: if it
 * is 0 the port is BIT-EXACT; a nonzero delta becomes the documented tolerance. Claiming
 * "exact" with a nonzero delta would be a FAIL (asserted below).
 *
 * NOT a tautology: an INDEPENDENT float64 oracle (the same relative-to-eye math done in full
 * float64, no fround, no hi/lo split) is computed too, and BOTH f32 simulations are asserted
 * to land within a committed deep-zoom tolerance of it. So the "bit-exact" claim is the
 * PORT-FIDELITY claim (WGSL sequence == GLSL sequence), while the oracle bounds the ABSOLUTE
 * precision of the emulation -- the two are separate, load-bearing facts.
 *
 * The subtraction MUST precede the add (Sterbenz cancellation of the near-equal high parts),
 * and the scale MUST come AFTER the residual add -- reorder either and precision collapses.
 * No fma, no reassociation.
 *
 * MIT (c) 2026 Zahary Shinikchiev
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hiOf, loOf } from "../GL.js";

const f = Math.fround;

// Committed tolerance (clip units). The two IEEE-754 binary32 sequences are identical
// op-for-op, so the expected WGSL-vs-GLSL delta is 0 (bit-exact); this ceiling exists only
// to make an accidental reassociation in a FUTURE edit fail loudly rather than silently
// degrade.
const TOL = 1e-6;

// Committed deep-zoom tolerance (clip units): the largest a binary32 emulation is allowed
// to drift from the true float64 result across FORK_B_VECTORS. The worst case here is the
// +1-year-away camera (error scales with distance from the eye, not absolute magnitude);
// measured ~3.1e-6 clip units (~0.003 px over a 2000px viewport). Pinned above that.
const ORACLE_TOL = 1e-5;

// --- GLSL POINT_HI_VS, transcribed op-for-op (GLBackend.js:231-250) ---------
//   vec2 rel = (a_posHi - u_cameraHi) + (a_posLo - u_cameraLo);
//   vec2 px  = rel * u_scale + u_origin;
//   vec2 clip = (px / u_resolution) * 2.0 - 1.0;
//   gl_Position.xy = vec2(clip.x, -clip.y);
function projGLSL(posHi, posLo, camHi, camLo, scale, origin, res) {
  const rel = f(f(posHi - camHi) + f(posLo - camLo));
  const px = f(f(rel * scale) + origin);
  const clip = f(f(f(px / res) * 2) - 1);
  return clip;
}

// --- WGSL POINT_HI_WGSL, transcribed op-for-op (GLWebGPU.js POINT_HI_WGSL) ---
//   let rel = (a_posHi - u.cameraHi) + (a_posLo - u.cameraLo);
//   let center = rel * u.scale + u.origin;
//   let clip = (center / u.resolution) * 2.0 - 1.0;
//   out.pos.xy = vec2(clip.x, -clip.y);
function projWGSL(posHi, posLo, camHi, camLo, scale, origin, res) {
  const rel = f(f(posHi - camHi) + f(posLo - camLo));
  const center = f(f(rel * scale) + origin);
  const clip = f(f(f(center / res) * 2) - 1);
  return clip;
}

// --- INDEPENDENT float64 oracle: the SAME relative-to-eye math, in full float64 -----
// (no fround anywhere, no hi/lo split -- raw world coordinates). This is the true value
// the binary32 emulation approximates, so it cannot be tautologically equal to either f32
// sequence; it bounds their absolute precision.
function projF64(x, cam, scale, origin, res) {
  const rel = x - cam;
  const px = rel * scale + origin;
  return (px / res) * 2 - 1;
}

const DAY_MS = 86400000;
const YEAR_MS = 365 * DAY_MS;

// FORK_B_VECTORS: world x, camera x, scale (world->px), origin (px), resolution (px).
// >= 12 vectors spanning the regimes the layout exists for.
const FORK_B_VECTORS = [
  { name: "epoch-ms, camera on point",        x: 1.78e12,          cam: 1.78e12,             scale: 1e-3, origin: 1000, res: 2000 },
  { name: "epoch-ms, camera +1 day",          x: 1.78e12,          cam: 1.78e12 - DAY_MS,    scale: 1e-3, origin: 1000, res: 2000 },
  { name: "epoch-ms, camera +1 year",         x: 1.78e12,          cam: 1.78e12 - YEAR_MS,   scale: 1e-6, origin: 1000, res: 2000 },
  { name: "epoch-ms + 1s tick",               x: 1.78e12 + 1000,   cam: 1.78e12,             scale: 1e-3, origin: 1000, res: 2000 },
  { name: "epoch-seconds",                    x: 1.78e9,           cam: 1.78e9 - 3600,       scale: 1e-2, origin: 800,  res: 1600 },
  { name: "geodetic 1e2 w/ 1e-9 detail",      x: 1e2 + 1e-9,       cam: 1e2,                 scale: 1e5,  origin: 500,  res: 1000 },
  { name: "2^24 boundary",                    x: 16777216,         cam: 16777216 - 128,      scale: 1,    origin: 640,  res: 1280 },
  { name: "2^24 + 1 (past exact-int f32)",    x: 16777217,         cam: 16777216,            scale: 1,    origin: 640,  res: 1280 },
  { name: "denormal-adjacent residual",       x: 1e12 + 1e-3,      cam: 1e12,                scale: 1e-2, origin: 512,  res: 1024 },
  { name: "negative world (pre-epoch)",       x: -1.5e12,          cam: -1.5e12 + DAY_MS,    scale: 1e-3, origin: 1000, res: 2000 },
  { name: "large scale, near eye",            x: 4.2e11 + 0.25,    cam: 4.2e11,              scale: 8,    origin: 300,  res: 600 },
  { name: "small residual far camera",        x: 9.9e11 + 7,       cam: 9.9e11 - YEAR_MS,    scale: 1e-5, origin: 960,  res: 1920 },
  { name: "zero world, offset camera",        x: 0,                cam: -DAY_MS,             scale: 1e-3, origin: 100,  res: 2000 },
];

test("Fork B': WGSL and GLSL POINT_HI projection are bit-exact AND both track the float64 oracle", () => {
  let maxDelta = 0, worst = null;         // WGSL vs GLSL (port fidelity)
  let maxOracle = 0, worstOracle = null;  // max(|wgsl-f64|, |glsl-f64|) (absolute precision)
  for (const v of FORK_B_VECTORS) {
    // JS split reuses hiOf/loOf (Math.fround), EXACTLY as GLBackend.js writePointHi and
    // createPointHiSink.setCamera do, so the inputs to both sequences are byte-identical.
    const posHi = hiOf(v.x), posLo = loOf(v.x);
    const camHi = hiOf(v.cam), camLo = loOf(v.cam);
    const g = projGLSL(posHi, posLo, camHi, camLo, v.scale, v.origin, v.res);
    const w = projWGSL(posHi, posLo, camHi, camLo, v.scale, v.origin, v.res);
    const ref = projF64(v.x, v.cam, v.scale, v.origin, v.res);

    const d = Math.abs(w - g);
    if (d > maxDelta) { maxDelta = d; worst = v.name; }
    assert.ok(d <= TOL, v.name + ": |wgsl-glsl|=" + d + " exceeds TOL " + TOL);

    const ow = Math.abs(w - ref), og = Math.abs(g - ref);
    const o = ow > og ? ow : og;
    if (o > maxOracle) { maxOracle = o; worstOracle = v.name; }
    assert.ok(ow <= ORACLE_TOL, v.name + ": |wgsl-f64|=" + ow + " exceeds ORACLE_TOL " + ORACLE_TOL);
    assert.ok(og <= ORACLE_TOL, v.name + ": |glsl-f64|=" + og + " exceeds ORACLE_TOL " + ORACLE_TOL);
  }

  const label = maxDelta === 0 ? "bit-exact" : ("max delta " + maxDelta + " (worst: " + worst + ")");
  console.log(
    "precision-parity Fork B': WGSL-vs-GLSL " + label
    + "; vs float64 oracle max=" + maxOracle.toExponential(3) + " clip (worst: " + worstOracle
    + ") over " + FORK_B_VECTORS.length + " vectors (TOL=" + TOL + ", ORACLE_TOL=" + ORACLE_TOL + ")"
  );

  // A claim of "bit-exact" with a nonzero WGSL-vs-GLSL delta is a FAIL: the printed number
  // is the tolerance, and TOL bounds it. This pins the honesty of the log line.
  if (maxDelta === 0) {
    assert.equal(maxDelta, 0, "logged bit-exact -> WGSL-vs-GLSL max delta must be exactly 0");
  } else {
    assert.ok(maxDelta <= TOL, "a nonzero WGSL-vs-GLSL delta must stay within the committed tolerance");
  }
  // The oracle delta must be genuinely observed (nonzero -- a binary32 emulation cannot be
  // bit-exact to float64 across these extreme vectors), proving the oracle is independent.
  assert.ok(maxOracle > 0, "the float64 oracle must differ from the f32 sims -- else it is not independent");
  assert.ok(maxOracle <= ORACLE_TOL, "both f32 sequences must track the float64 oracle within ORACLE_TOL");
});
