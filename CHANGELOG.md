# Changelog

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
