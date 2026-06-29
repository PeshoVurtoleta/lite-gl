# Changelog

All notable changes to `@zakkster/lite-gl` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] -- 2026-06-28

Initial public release. A signal-native instanced primitive renderer for large
point sets -- a zero-GC instance engine plus a WebGL2 backend. Built for reactive
charts at ~1M points, not as a general scene graph.

### Added -- core (`@zakkster/lite-gl`, renderer-agnostic, tested)

- **`createField({ capacity?, stride })`** -- a packed interleaved Float32Array of
  per-instance attributes with dirty-RANGE tracking. `push`, `set(i, write)`,
  `swapRemove(i)`, `setCount(n)`, `touch(i)`, `touchAll()`, `clearDirty()`,
  `dirtyLo()` / `dirtyHi()`, `flush(sink)`, `reset()`. The backing buffer grows by
  powers of two and is **never reallocated while you stay within capacity**, so a
  frame of re-projection allocates nothing.
- **`reactiveField(field, { project, sink, manual? })`** -- `project(field)` reads
  signals and writes the field; it re-runs when a tracked signal changes (marking
  the field dirty). The per-frame `frame()` flushes the dirty range to the sink and
  **only redraws when something changed**. Auto-driven on `lite-raf` unless manual.
  When the sink can lose its GL context, the driver re-seeds the whole active range
  on restore (`field.touchAll()` + flush) so the picture returns on its own.
- **`createDriver(registry)`** -- bind the driver to an explicit registry.
- **`LAYOUT`** = `{ POINT: 8, QUAD: 9, LINE: 9 }` floats per instance.
- The GPU lives behind a `Sink` interface (`upload(data, floatOffset, floatCount,
  instanceOffset, stride)`, `draw(count)`), so the renderer never touches the
  reactive graph and the backend is swappable.

### Added -- WebGL2 backend (`@zakkster/lite-gl/backend`, browser-only)

- **`createPointSink(gl, { capacity })`** -- renders a `LAYOUT.POINT` field as
  `GL_POINTS` in a single `drawArrays` call. `upload` does `bufferSubData` of only
  the dirty float window; `resize(w, h)` matches the viewport. Positions are in
  screen pixels (do world->screen in `project`). The VBO is allocated once. The sink
  exposes its fixed `capacity`, and an `upload` beyond it throws a `RangeError`
  rather than letting the VBO and the field's array silently desync into a GPU fault.
- **Context-loss recovery.** A long-running overlay will eventually lose its GL
  context (GPU reset, driver update, the tab backgrounded on mobile). The sink owns
  the GL resources, so it owns recovery: it listens for `webglcontextlost` /
  `webglcontextrestored` on the canvas, calls `preventDefault()` to opt into
  restore, **no-ops `draw`/`upload` while lost** (so the render loop does not throw
  or spew GL errors), and rebuilds program + VBO + VAO on restore. Because the
  restored buffer is empty, `onContextRestored(cb)` lets you re-upload -- and
  `reactiveField` wires `field.touchAll()` + flush automatically when the sink
  exposes the hook, so the picture returns on its own. Also exposes
  `isContextLost()`.
- **Coverage.** The WebGL2 API has no headless context, so this file is covered by
  a **browser smoke test** instead of `node:test`: `test/smoke.html` renders known
  points and reads pixels back (asserting non-blank output, correct position
  mapping, dirty-window upload, and context-loss recovery), runnable by hand in any
  browser; `test/smoke.spec.mjs` runs the same page under Playwright in headless
  Chromium (real WebGL2 via SwiftShader) for CI. The re-seed-on-restore wiring in
  the core is additionally covered by a `node:test` with a mock sink.

### Dependencies

- Peers `@zakkster/lite-signal` `>=1.5.0-alpha` (the reactive driver) and
  `@zakkster/lite-raf` `^1.0.0` (the loop). No other dependencies.

### Scope / boundaries (honest non-claims)

- The **core** (buffer, dirty batching, reactive projection, 1M zero-GC) is tested.
  The **rendering** (shader compile, instanced draw, 60fps at 1M) is
  **browser-validated** by a smoke test (`test/smoke.html` by hand + `test/smoke.spec.mjs`
  under Playwright in CI); the `node:test` suite makes no rendering claim.
- **v1 ships the POINT pipeline.** Quads/lines use the same core with an instanced
  base geometry + `vertexAttribDivisor`; deferred (sketched in `GLBackend.js`).
- Re-projection is O(N): a camera/data change re-projects all instances -- cheap on
  CPU, and allocation-free, which is what protects the frame budget.
- Not a scene graph, sprite batcher, text renderer, or filter stack.

### Zero-GC, verified

- A frame re-projects in place and uploads only the dirty float window -- no
  allocation. 60 frames of full 1M-point re-projection leave the backing
  Float32Array reference unchanged and the engine pool counters
  (`poolGrowths` / `totalAllocations`) flat.

### Tested

- 8 tests under `node --test`: push + power-of-two growth; dirty range covering
  exactly the touched instances; flush uploading only the dirty range then drawing +
  clearing (and a clean flush uploading nothing); `swapRemove`; the reactive driver
  re-projecting on signal change and flushing once per frame (dirty-gated);
  **1M-instance re-projection zero-GC (buffer reference stable, 60 frames)**; registry
  binding; **re-seed on GL context restore (a mock sink fires the restore hook and the
  field re-uploads its whole active range)**. Mock sink stands in for the GPU.
- ESM only; `node:test`; `sideEffects: false`; ASCII source; `GL.d.ts` /
  `GLBackend.d.ts` validated under `tsc --strict`.
