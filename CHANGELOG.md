# Changelog

## [2.0.0-beta.0] - 2026-08-15

### Added
- **The WebGPU sink (`@zakkster/lite-gl/webgpu`, GLWebGPU.js).** A second GPU backend that
  mirrors the WebGL2 sink interface exactly and drives the unchanged GL.js core. Four sinks
  (`createGPUPointSink` / `createGPUPointHiSink` / `createGPUQuadSink` / `createGPULineSink`)
  plus `createGPUTarget(canvas, opts)`, which acquires a device (or takes an injected
  `{ device }`) and configures the context. The field byte layout is byte-identical to WebGL2;
  only the rendering mechanism differs (no `gl_PointSize` -> points are instanced unit-quads
  expanded by `a_size` in inline WGSL). This beta is MOCK-PROVEN headlessly; real-GPU
  Playwright validation is deferred to GL8c.
- **`PICK_PENDING` (-2) and `PICK_MAX_ID` promoted to the core (GL.js).** Both backends
  re-export `PICK_MAX_ID` verbatim so it reads bit-identically everywhere (asserted by
  `test/packaging_test.mjs`).
- **`test/gates/webgpu-frame-alloc.mjs`** -- a headless, GPU-free, zero-tolerance gate that
  accounts the WebGPU sink's per-frame device-boundary allocation via integer accounting
  (like `dirty-range.mjs`) and pins it to the committed **192 B/frame** (`WEBGPU_FRAME_BASELINE`
  = encoder + render pass + submit). Also asserts the core's own per-frame contribution is 0
  and that a self-control injecting one extra per-frame object trips the gate.
- **`test/GLWebGPU_test.mjs`** (fail-closed acquisition, device loss + restore, the deferred-
  pick state machine with K=2 back-pressure, `PICK_MAX_ID` RangeError, counters conformance,
  caps shape/freeze) and **`test/precision_parity_test.mjs`** (Fork B': WGSL vs GLSL POINT_HI
  projection is **bit-exact** over 13 vectors). Torture gains WebGPU tiers T6(gpu) / T7(gpu) /
  T8(gpu) / T8b(gpu). The single-source-of-truth mock lives in `test/mockWebGPU.mjs`.

### Changed (BREAKING -- two v2.0.0 breaks total)
- **Caps surface** (carried from the alpha): every sink advertises a frozen `caps` descriptor.
  The WebGPU sinks advertise `api:"webgpu"`, `baseVertex:true`, and `pickMode:"deferred"`.
- **Deferred pick.** On a `pickMode:"deferred"` sink (WebGPU) `pick()` may return `PICK_PENDING`
  (-2) while the async readback is unresolved -- poll again for the resolved index or -1 miss.
  A `pickMode:"sync"` sink (WebGL2) never returns `PICK_PENDING`, so existing WebGL2 code is
  unaffected.

  **Migration:** treat a WebGPU `pick()` result of `PICK_PENDING` as "ask again next frame".

### Internal
- GLBackend.js now imports `PICK_MAX_ID` from GL.js and re-exports it (an alias line; no hashed
  hot body -- `pickAt`/`upload`/`draw` -- changed, still fenced green by `test/hash_parity.mjs`).

## [2.0.0-alpha.0] - 2026-08-15

### Changed (BREAKING -- the sole intended break of v2.0.0)
- **The caps seam.** Every sink now advertises a frozen `caps` descriptor and `reactiveField`
  reads it EXACTLY ONCE, at bind, via `assertCaps` -- never per frame. The per-frame closure
  reads no caps, and the hot path (`upload`/`draw`/`pickAt` in GLBackend.js, `flush`/`push`/
  `set`/`swapRemove` in GL.js) is byte-unchanged from v1.5.0 (fenced by `test/hash_parity.mjs`).

  ```
  caps = { api:"webgl2", instancing:true, baseVertex:false, maxInstances:0xFFFFFF,
           precisionHi:<per-sink>, pickMode:"sync", version:1 }
  ```

  `precisionHi` is `true` only on `createPointHiSink`; the other three advertise `false`.
  `pickMode` is `"sync"` on all four WebGL2 sinks. `maxInstances` (`0xFFFFFF`) aligns with
  `PICK_MAX_ID + 1`.
- **`reactiveField` now fails closed on capability mismatch** (was: bound anything). A sink
  with no `caps` object throws; a `LAYOUT.POINT_HI` field bound to a non-`precisionHi` sink
  throws; a field whose `capacity` exceeds `caps.maxInstances` throws with a size hint.

  **Migration:** a custom sink must now expose a `caps` object (copy the shape above). A sink
  without one no longer binds.

### Added
- **`test/hash_parity.mjs`** -- committed SHA256 baselines of the hot-function source text; the
  build fails if any hot body drifts. Only `reactiveField` and `didYouMean` may change in GL8a.
- **Torture tier T8b** -- a `Proxy`-wrapped `caps` counts every `get` after bind and asserts it
  is zero across 1e6 frames, for all four layouts (POINT / POINT_HI / QUAD / LINE).

### Internal
- `didYouMean(key, candidates = FIELD_KEYS)` generalized (cold path; the createField call site
  is byte-behavior-unchanged via the default arg).

## [1.5.0] - 2026-08-11

### Added
- **Profiler counters seam (optional, zero-dep).** Every WebGL2 sink now takes an optional
  duck-typed `counters` handle -- `{ recordUpload(floatCount), recordDraw(drawCount) }`, the
  shape `@zakkster/lite-profiler` 1.2.0 exposes -- via a `counters` construction option or
  `sink.setCounters(handle)` / `sink.setCounters(null)` to detach. On each flushed frame it
  emits `recordUpload(floatCount)` (the dirty-window floats actually uploaded) and
  `recordDraw(1)` per non-empty draw. A `pick()` never counts as a draw or upload (its
  internal ID-buffer render is excluded); a context-loss re-seed, by contrast, *does* count
  -- it is a real full-range GPU upload + draw, so a profiler should see it. lite-profiler
  stays a **peer / optional** integration
  -- `dependencies` remains empty; when no handle is attached the hot path is byte-identical
  to v1.4.1 and allocates nothing (proven by torture T8, with and without counters).
- **`test/gates/dirty-range.mjs` -- a headless, GPU-free zero-tolerance gate.** A deterministic
  op stream (append / scatter-edit / swap-remove) is replayed against a mock sink and the exact
  uploaded-float total is asserted against a committed baseline; any drift (e.g. a one-instance
  edit re-uploading the whole buffer) fails the build by even one float. Wired into `npm test`
  and `npm run test:gates`. Update the baseline only on a deliberate dirty-range contract change.
- **Torture tier T8** -- counter-seam conformance (exact `floatsUploaded` / `drawCalls` over a
  known op stream, both attach paths, `setCounters(null)` detach, fail-closed on a malformed
  handle, and the pick-does-not-count invariant) plus a zero-alloc check with counters attached
  AND absent.

### Tests (not shipped)
- **Real-GPU QUAD and LINE coverage.** `test/smoke.html` gains instanced QUAD and LINE
  scenes with pixel readback (colour + coverage) and `pick()` decode assertions, plus a
  POINT_HI context-loss/restore scene -- closing the gap where QUAD/LINE were validated
  only against the mock GL. Drives through the existing `__SMOKE_RESULT__` harness, so
  `npx playwright test test/smoke.spec.mjs` asserts them with no spec change.
- **Core-branch backfill** in `test/GL_test.mjs`: `reset()`, the `setCount(n > capacity)`
  grow branch, and the `swapRemove(last)` no-op.

### Demo (not shipped)
- **Demo hot-path law applied** to `demo/index.html` and `demo/demo.html`: per-scene sink
  disposal on teardown (not just the deep scene), the deep-scene HUD routed through the
  `_v`-deduped 10Hz helpers, all frame-loop forced-reflow / per-frame-allocation sites
  removed, source ASCII-cleaned, and the dangling `verify/demo_logic.mjs` reference resolved.

### Browser-validation checklist
- POINT, POINT_HI, QUAD, LINE render + pick verified on real WebGL2 (SwiftShader, headless
  Chromium) via `test/smoke.spec.mjs`; POINT and POINT_HI context-loss recovery verified.

## [1.4.1] - 2026-08-10

### Fixed
- **`GL.d.ts` compiles under default `tsc`.** Removed a duplicate `LAYOUT` declaration
  (`TS2451`) that shipped in `files[]`; the surviving block is the complete one carrying
  `POINT_HI: 10`. TypeScript consumers can now import the types without `skipLibCheck`.
- **README headline install resolves.** The v1.4 deep-zoom example imported
  `@zakkster/lite-gl/GLBackend.js`, which the exports map blocks
  (`ERR_PACKAGE_PATH_NOT_EXPORTED`); it now imports the exported `@zakkster/lite-gl/backend`.
- **LAYOUT constants table** in the README now lists `POINT_HI: 10`, matching the runtime.

### Added
- **`export const VERSION = "1.4.1"`** in `GL.js` (packaging law: version in
  `package.json` + main file + `llms.txt`).
- **`test/torture.mjs`** -- the mandatory `node --expose-gc` gate, built on
  `@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`. Tiers T0 (dirty-range metamorphic
  laws), T1 (degenerate values + fail-closed construction), T2 (aliasing matrix vs a
  shadow buffer, incl. the N-3 clamp), T3 (grow across a pow2 boundary mid-dirty-range),
  T4 (post-dispose flush no-op, double-dispose, context-loss re-seed for POINT and
  POINT_HI, program-cache refcount -> 0), T5 (differential fuzz vs a naive full-upload
  oracle), T6 (zero-alloc gate over 1M frames of `project`+`flush`+`draw` **and** the
  now-real `pick()` sub-gate, POINT/POINT_HI/QUAD/LINE), T7 (1M soak + create/dispose
  conservation via lite-leak), and T9 (controls: the gate must be able to fail). Wired to
  `npm run test:torture`.
- **`sink.setClearColor(r, g, b, a)`** on every WebGL2 sink -- the sink now *owns* the
  clear-colour write, so a `pick()` can restore it from a JS mirror instead of an
  allocating `getParameter` (see GL-05 below). Pass your app's clear colour through it if
  you want a pick to leave it untouched; the default (0,0,0,0) matches the GL default.

### Hardened -- fail closed on every unverified state (was fail-open)
- **`createField` validates at construction (GL-04).** A missing/garbage `stride` used to
  write to `data[NaN]` in silence (the point vanished); an unknown key was silently
  ignored. Now, *before the first `Float32Array` is allocated*: a non-positive-integer
  `stride` throws naming the LAYOUT strides (POINT=8, QUAD=9, LINE=9, POINT_HI=10); an
  unknown key throws with a did-you-mean hint (`strid` -> `stride`); and `capacity`, when
  present, must be a **finite positive integer** at or below a hard cap of **2^30**. The
  finiteness + cap checks are load-bearing: `Infinity > 0` (and any value past 2^30) would
  otherwise slip through a bare `> 0` test into `nextPow2`, whose 32-bit shift wraps
  negative and **loops forever** -- a fail-*open* hang worse than the `data[NaN]` this
  validation exists to stop. `nextPow2` is also bounded so no input can loop it.
  **`capacity: 0` was previously an implicit "use the default 1024" (`0 || 1024`) and is
  now rejected** as a degenerate input (null is not zero). The hot bodies
  (`push`/`set`/`swapRemove`/`flush`/`writePointHi`) gain **zero** new branches --
  validation lives only on the construction path.
- **`reactiveField().flush()` after `dispose()` is a no-op (GL-09).** It mirrors the
  existing `frame()` guard; a disposed driver no longer uploads or draws.
- **`flush` clamps a post-shrink stale dirty range to the active count (N-3).** A
  `swapRemove`/`setCount` that lowered `count` could leave `dHi >= count`, uploading floats
  past the live range; the window is now `[dLo, min(dHi, count-1)]`. No allocation.
- **`pick()` enforces `PICK_MAX_ID` (GL-07).** A pick whose instances would exceed the
  24-bit ID space threw nothing and silently aliased instance `0xFFFFFF` (the reserved
  "miss"); it now throws a `RangeError`. Valid indices are `0..count-1`, so the cap is on
  the *top index*: a `count` of `PICK_MAX_ID + 1` (top index `PICK_MAX_ID` = `0xFFFFFE`, still
  distinct from the miss sentinel) is allowed; only a larger `count` throws. The guard is on
  the on-demand pick path, never in the per-frame draw hot body.

### Fixed -- `pick()` is zero-allocation (GL-05)
- `pickAt` no longer calls `gl.getParameter(gl.COLOR_CLEAR_VALUE)` (which returns a fresh
  `Float32Array(4)` **every call** -- ~60 heap allocs/sec while a pointer hovers). Clear
  colour is restored from the sink's JS mirror, blend from the non-allocating `isEnabled`
  boolean, and the draw target is the canvas. The picker's `ensure()` result object is now
  reused rather than re-allocated per pick. Measured: **0 B/op** over 100k isolated picks
  for every layout (torture T6 pick sub-gate; the old `KNOWN_FAIL_GL05` pending marker is
  gone). Pick correctness (decode / miss / out-of-bounds / state-restore) is unchanged.

### Removed (dead code / comment truth)
- Deleted the unused `reg.dispose` (`_dispose`) binding in `createDriver` and its now-dead
  `@zakkster/lite-signal` import (N-1).
- Softened the two `"Exact -- no rounding is lost"` comments on `loOf` / `writePointHi` to
  state the honest 23-bit float32 residual bound (N-2).

### Note
- **Hot-path change, intentional and gated.** `pickAt` was rewritten for GL-05 (SHA
  changed, expected); `flush` changed only by the N-3 clamp (SHA changed, expected). The
  executable logic of `project`, `push`, `set`, and `writePointHi` is unchanged from v1.4.0
  (only an inline comment inside `writePointHi` was softened per N-2). The zero-alloc gate
  (T6) is green at 0 B/op for every hot path including `pick`.

## [1.4.0] - 2026-07-14

### Added
- **`LAYOUT.POINT_HI` (stride 10) + `createPointHiSink`** — world coordinates, camera on the GPU.

  The existing sinks take **screen pixels**: `project()` bakes the camera in on the CPU, in
  float64, so the float32 field only ever sees small numbers. That is the relative-to-eye
  contract, and it is why precision has never been a problem. It is also what caps the 1M-point
  pan — moving the camera one pixel re-projects every instance (~5 ms of JS at 1M points) and
  dirties the whole field (a **31 MB re-upload, every frame**).

  `POINT_HI` holds raw world coordinates instead, uploaded **once**. A pan or zoom is
  `setCamera(x, y, sx, sy)` — four floats of uniform, no CPU work, no upload.

- **Double-emulated precision.** float32 has a 24-bit significand, so integers are exact only to
  2^24. A Unix epoch millisecond is ~1.78e12, where the ULP is **131,072 ms ≈ 2.2 minutes** — a
  full minute of one-second ticks collapses onto a *single* representable float32. Epoch-seconds
  is no escape either (ULP ~128 s). `POINT_HI` splits each coordinate into a hi/lo float32 pair
  and the shader computes `(posHi - camHi) + (posLo - camLo)`. The high parts are float32s of
  near-identical magnitude, so that subtraction cancels **exactly** (Sterbenz) and the residuals
  carry the detail.

  **The guarantee, precisely:** error scales with distance *from the eye*, not with absolute
  magnitude. Anything within a day of the camera round-trips bit-exactly from an epoch-ms
  timestamp. A point a year away is good to ~800 ms — which sounds like a caveat and is actually
  the whole point, because you only *see* distant points when zoomed out, and the pixel grows at
  the same rate the error does. Worst-case error across a 2000 px viewport is **~1e-4 px, at any
  zoom, at any absolute magnitude**. The naive path degrades with absolute magnitude, which
  nothing can save you from.

- **Precision helpers in the GL-agnostic core**: `writePointHi()` (does the split for you, zero
  allocation), `hiOf()` / `loOf()`, `f32Ulp(v)`, and `needsHiPrecision(maxAbsCoord, resolution)`
  — a guardrail that answers "do I need this layout?" before you find out the hard way.

- `PointHiSink` gets the full v1.3 surface: `setScissor` / `clearScissor` / `pick`, shared and
  refcounted program cache, context-loss recovery.

### Fixed
- **POINT_HI pick pass now links on real drivers.** As first written, `PICK_POINT_HI_VS`
  declared its ID varying as `flat out int v_id` and assigned `gl_VertexID` directly, while
  the shared `PICK_FS` reads `flat in uint v_id`. GLSL ES 3.00 treats `int` and `uint`
  varyings as distinct types, so a real driver rejected the program at link time — *"Types
  of varying 'v_id' differ between VERTEX and FRAGMENT shaders"* — the first time `pick()`
  ran on a `pointHi` sink. (The mock-GL tests never caught it: they record calls but do not
  compile GLSL.) It now matches the three other pick shaders — `flat out uint v_id`,
  `v_id = uint(gl_VertexID)` — and widens `gl_PointSize` to `max(a_size, 3.0)` like the
  POINT pick pass, for a slightly larger hit area.
- The ID pass now pushes the **same camera uniforms** as the visible pass. Without it, the pixel
  read back would belong to a different instance than the one under the cursor, and hover would
  silently lie. `createPicker` takes an extra-uniform list; `pickAt` takes an apply hook.
- `POINT_HI_VS` declares `precision highp float`. It is the ES 3.00 vertex default, but stating it
  makes the requirement explicit — at `mediump` the whole scheme collapses to *worse* than plain
  float32.

### Changed
- `LAYOUT` gains `POINT_HI`. The screen-pixel contract of `POINT` / `QUAD` / `LINE` is now
  documented rather than merely true.
- `pickAt` treats `pointHi` as a `POINTS` draw, not an instanced one.

### Demo
- New scene **06 · Deep Time**: 400k one-second epoch-ms ticks, two panes, one context, split by
  scissor. Left holds the timestamps as single float32 world coordinates and re-projects on the CPU
  every frame; right is `POINT_HI` with the camera in the shader. Zoom in and the left pane snaps
  onto a lattice the moment the float32 ULP exceeds a pixel, while its upload counter climbs into the
  thousands and the right one stays at **1**. Live readout of `f32Ulp(camera)` vs ms/px, plus
  `needsHiPrecision()` as the verdict. GPU picking on the right pane at any zoom.
- Every scene exposes `destroy()` (aborts its `AbortController`; the deep scene also disposes
  both GL sinks), and `pagehide` tears down all six. Tab-switching still uses `stop()` /
  `start()`, so re-entering a scene is unaffected; no-GL fallback objects carry a no-op
  `destroy()` so teardown never throws on a machine without WebGL2.
- Bars scene: `fld.setCount()` moved out of the per-frame `layout()` into the bar-count slider
  handler (seeded once at init). The instance count changes only with the slider; `touchAll()`
  stays per-frame because the geometry animates every frame.

### Not depended on
- **No camera dependency, peer or otherwise.** `setCamera()` takes six plain numbers.
  `@zakkster/lite-camera` is a game-follow camera for Canvas2D — deadzone, lookahead, trauma shake,
  clamped to a world rect, emits a `ctx` transform. It has no zoom, pins `x >= 0`, and its `apply()`
  does `ctx.translate(-(pos[0] | 0), …)`, a ToInt32 truncation that *wraps* at epoch-ms magnitudes.
  Correct for a platformer; wrong for a chart. `lite-camera-pro` adds five more deps on top.

### Tested
- 30 new checks (38 → **68**). The core tests simulate the vertex shader's arithmetic in exact
  float32 at every step, so the precision claims are proven, not asserted: bit-exactness within a
  day of the eye, sub-pixel error bounded across five orders of zoom, the Sterbenz cancellation
  holding, and the naive float32 path failing at the same zoom levels where hi/lo is
  sub-milli-pixel. Backend tests cover attribute layout, camera-uniform push, ID-pass camera
  parity, and **sixty frames of panning with zero re-uploads**. `test/smoke.html` (the
  real-browser Playwright test) gained a POINT_HI section that renders through the GPU camera
  and then calls `pick()` — the exact path that links the shader program, which mock-GL cannot
  cover.

## [1.3.0] - 2026-07-11

### Added
- **Shared program cache**: N sinks of the same primitive type share one linked program.
  The first sink of a type compiles + links; the rest reuse it.
  - Cached **per GL context** — a `WebGLProgram` belongs to the context that created it,
    and a page can hold several contexts (the demo has one per scene).
  - **Refcounted**: `dispose()`ing one sink can no longer delete a program another sink
    is still using. The program is deleted when the last ref is released.
  - A lost context drops the cache so programs relink on restore.
- **Scissor / viewport regions**: `setScissor(x, y, w, h)` + `clearScissor()` on every
  sink, for multi-pane charts in a single context with no extra framebuffers.
  `x, y` are top-left origin in device px (GL's bottom-left origin is flipped internally).
- **ID-buffer picking**: `pick(x, y, count?)` on every sink → instance index, or `-1`.
  - Renders one offscreen ID pass (each instance flat-shaded with its index, 24-bit
    little-endian RGB) and reads back a single pixel. No CPU hit-testing, so hover works
    at 1M instances.
  - Defaults to the count last passed to `draw()`. Honours the sink's scissor, so a hover
    cannot hit a neighbouring pane.
  - Saves and restores the bound framebuffer, clear colour and blend state — **blending is
    disabled during the ID pass** (ids are bit patterns; blending them corrupts the readback).
  - Costs one extra draw **per call** — throttle it to `pointermove`, never the frame loop.
  - `PICK_MAX_ID` (`0xFFFFFE`) exported: white is reserved as the miss value.
- Demo: new **Split Scope** scene — one canvas, one context, three fields, two scissor panes
  (Lorenz lines | attractor points), with live GPU hover picking and a highlight marker.

### Changed
- Backend exports `PICK_MAX_ID`; every sink gains `setScissor` / `clearScissor` / `pick`.
- `GLBackend.d.ts` now factors the common surface into a shared `GLSink` interface.
- README, `llms.txt`, and the top-level comment updated. No core changes.

### Fixed
- The pick fragment shader declares `precision highp int`. The default integer precision in
  a fragment shader is `mediump` (only guaranteed 16 bits), which would truncate any id
  above 65535.

### Tested
- 9 new backend tests: shared program cache (N sinks → 1 `linkProgram`), per-context
  isolation, refcounted dispose, scissor y-flip + no leaked state, pick decode, miss and
  out-of-bounds short-circuits, blend-off-and-restored during the ID pass, scissor-clipped
  picking, and program relink after context loss.
- Mock WebGL2 harness extended with textures, framebuffers, `readPixels`, `getParameter`,
  `isEnabled`/`enable`/`disable`, `scissor` and `clearColor` so the pick pass is verifiable
  headlessly.
- `npm test` now runs 8 core + 30 backend = 38 checks.

## [1.2.0] - 2026-07-11

### Added
- **LINE pipeline** (`createLineSink`): instanced screen-space thick segments,
  expanded in the vertex shader from `p0`/`p1` + width.
  - Layout: `x0, y0, x1, y1, width, r, g, b, a` (stride 9, matches `LAYOUT.LINE`).
  - Butt caps only (ends cut perpendicular at the endpoints); a polyline is N−1
    independent segments. Round joins deferred to 1.3 if seams show at chart widths.
  - `capacity` is the number of **segments**.
  - Same zero-GC dirty-window upload + context-loss recovery as POINT/QUAD; one
    `drawArraysInstanced(TRIANGLE_STRIP, 0, 4, count)` call for the whole set.
  - Unlocks high-performance line charts, multi-series lines, step lines, and area
    outlines in `lite-charts-gl`, past the Canvas2D ceiling.
- Demo: new **Lorenz Ribbon** scene — a Lorenz attractor traced as a glowing thick
  polyline through `createLineSink`, with the same reactive camera (drag / zoom /
  auto-rotate) and additive phosphor glow as the Attractor Field.

### Changed
- Backend now exports `createLineSink`.
- Type definitions (`GLBackend.d.ts`), README, `llms.txt`, and the top-level comment
  updated for the LINE pipeline. The core (`createField` / `reactiveField`) was
  already stride-generic — no core changes needed.

### Tested
- `createLineSink` GL wiring is unit-tested headlessly against the mock WebGL2 context
  (`test/GLBackend_test.mjs`): program link, static base VBO + dynamic instance VBO,
  the five attributes + `vertexAttribDivisor`, dirty-window `bufferSubData`, the
  `drawArraysInstanced(TRIANGLE_STRIP)` draw, the capacity guard, teardown, and an
  end-to-end pass driving the core through the line sink.
- `npm test` now runs 8 core + 21 backend = 29 checks.

## [1.1.0] - 2026-07-10

### Added
- **QUAD pipeline** (`createQuadSink`): Full instanced unit quad rendering with `vertexAttribDivisor`.
  - Layout: `x, y, w, h, rot, r, g, b, a` (stride 9)
  - Supports bars, rotated scatter markers, heatmap cells, etc.
  - Same zero-GC dirty-window upload + context loss recovery as POINT.
- Rebuilt interactive demo (`demo/index.html`): a three-scene oscilloscope showcase.
  - **Attractor Field** — up to 1M `GL_POINTS` from a de Jong attractor, driven by a
    camera `signal` through `reactiveField`: pan/zoom re-projects and redraws in one
    upload + one draw, and idle frames redraw nothing (dirty-gated).
  - **Quad Spectrum** — animated instanced bars + rotated caps via `createQuadSink`,
    one `drawArraysInstanced` call.
  - **Dirty Window** — a sweeping band that re-uploads only its contiguous float
    window, visualising `bufferSubData` shipping ~2% of the buffer per frame.
  - Zero-GC hot paths, cached DOM, per-scene `AbortController`, pointer events,
    additive phosphor blending, throttled telemetry, oklch-with-hex tokens.

### Changed
- Backend now exports `createQuadSink` alongside `createPointSink`.
- Type definitions updated (`GLBackend.d.ts`).
- `README.md` and `llms.txt` updated for the QUAD pipeline (API, scope, coverage).

### Tested
- `createQuadSink` GL wiring is now unit-tested headlessly against the mock WebGL2
  context (`test/GLBackend_test.mjs`): program link, static base VBO + dynamic
  instance VBO, the five attributes + `vertexAttribDivisor`, dirty-window
  `bufferSubData`, the `drawArraysInstanced(TRIANGLE_STRIP)` draw, the capacity
  guard, teardown, and an end-to-end pass driving the core through the quad sink.
- `npm test` now runs both the core and backend suites (8 + 15 = 23 checks).

### Notes
- Core (`createField`, `reactiveField`, dirty tracking) unchanged and fully compatible.
- LINE pipeline still deferred (same pattern ready to implement).

## [1.0.0] - Initial release
- POINT pipeline only.
