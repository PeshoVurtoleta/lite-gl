# Changelog

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
