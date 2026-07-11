# Changelog

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
