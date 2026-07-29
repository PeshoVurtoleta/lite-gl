# Changelog

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
