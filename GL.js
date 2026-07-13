/**
 * @zakkster/lite-gl v1.3.0 -- signal-native instanced primitive renderer.
 * -----------------------------------------------------------------------------
 * NOT a Pixi/Three competitor. A narrow, zero-GC engine for ONE thing: project a
 * large set of instanced primitives (points / quads / lines) from reactive inputs
 * and draw them in a single instanced call. The killer app is a reactive chart
 * holding ~1M points at 60fps with no per-frame allocation.
 *
 * This file is the GL-AGNOSTIC, fully testable core:
 *   - createField: a packed interleaved Float32Array of per-instance attributes,
 *     mutated in place, with dirty-RANGE tracking so only changed instances upload.
 *     The backing buffer is never reallocated while you stay within capacity, so a
 *     frame of re-projection allocates nothing.
 *   - reactiveField: re-projects the field when a tracked signal changes (camera,
 *     data, transform) and flushes the dirty range to a `sink` once per frame.
 *
 * The GPU lives behind the `sink` interface { upload(data, floatOffset, floatCount,
 * instanceOffset, stride), draw(count) }. The real WebGL2 sink is GLBackend.js
 * (browser-only); tests use a mock sink. Swap the sink for WebGPU/canvas without
 * touching this core.
 *
 * MIT (c) 2026 Zahary Shinikchiev
 */

import {
    effect as _effect,
    onCleanup as _onCleanup,
    dispose as _dispose,
} from "@zakkster/lite-signal";
import { frameDelta } from "@zakkster/lite-raf";

function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

/**
 * A packed instanced-attribute buffer with dirty-range batching.
 * @param {{ capacity?: number, stride: number }} cfg  stride = floats per instance.
 * @returns {object} field
 */
export function createField(cfg) {
    const stride = cfg.stride;
    let capacity = nextPow2((cfg && cfg.capacity) || 1024);
    let data = new Float32Array(capacity * stride);
    let count = 0;
    let dLo = -1;     // dirty range, instance indices; -1 = clean
    let dHi = -1;

    const markDirty = (i) => {
        if (dLo < 0 || i < dLo) dLo = i;
        if (i > dHi) dHi = i;
    };

    const grow = (need) => {
        const newCap = nextPow2(need);
        const next = new Float32Array(newCap * stride);
        next.set(data);           // one-time copy on growth (NOT a hot-path allocation)
        data = next;
        capacity = newCap;
    };

    const field = {
        stride,
        get data() { return data; },
        get count() { return count; },
        get capacity() { return capacity; },
        /** Dirty range in instance indices, or -1 if clean. */
        dirtyLo: () => dLo,
        dirtyHi: () => dHi,

        /** Append one instance; `write(data, base)` fills `stride` floats at `base`. Returns its index. */
        push(write) {
            if (count >= capacity) grow(count + 1);
            const i = count;
            write(data, i * stride);
            count = i + 1;
            markDirty(i);
            return i;
        },
        /** Rewrite instance i; `write(data, base)` fills its floats. Marks i dirty. */
        set(i, write) {
            write(data, i * stride);
            markDirty(i);
        },
        /** Swap-remove instance i (moves the last instance into its slot). Marks i dirty. */
        swapRemove(i) {
            const last = count - 1;
            if (i !== last) {
                const di = i * stride, dl = last * stride;
                for (let k = 0; k < stride; k++) data[di + k] = data[dl + k];
                markDirty(i);
            }
            count = last;
        },
        /** Set the active instance count directly (e.g. after a bulk fill). Marks the range dirty. */
        setCount(n) {
            if (n > capacity) grow(n);
            if (n > 0) { markDirty(0); markDirty(n - 1); }
            count = n;
        },
        /** Mark instance i dirty (after writing data[] directly). */
        touch: (i) => markDirty(i),
        /** Mark all active instances dirty. */
        touchAll() { if (count > 0) { dLo = 0; dHi = count - 1; } },
        clearDirty() { dLo = -1; dHi = -1; },

        /**
         * Upload the dirty range (if any) and draw. `sink.upload` receives the float
         * window; `sink.draw` the instance count. Clears the dirty range.
         */
        flush(sink) {
            if (dLo >= 0) {
                const floatOffset = dLo * stride;
                const floatCount = (dHi - dLo + 1) * stride;
                sink.upload(data, floatOffset, floatCount, dLo, stride);
                dLo = -1; dHi = -1;
            }
            sink.draw(count);
        },
        reset() { count = 0; dLo = -1; dHi = -1; },
    };
    return field;
}

/**
 * Bind a field to reactive inputs: `project(field)` (which reads signals and writes
 * the field) re-runs when a tracked signal changes, and the dirty range is flushed
 * to `sink` once per frame on lite-raf. { manual: true } -> drive via frame()/flush().
 *
 * @param {{effect:Function, onCleanup:Function, dispose:Function}} reg
 */
export function createDriver(reg) {
    const effect = reg.effect;
    const onCleanup = reg.onCleanup;
    const dispose = reg.dispose;

    function reactiveField(field, opts) {
        const project = opts.project;
        const sink = opts.sink;
        const manual = !!opts.manual;

        let unsubFrame = null;
        let disposed = false;

        // Re-project when a tracked signal changes; this marks the field dirty.
        const stopProject = effect(() => { project(field); });

        const frame = () => {
            if (disposed) return;
            if (field.dirtyLo() >= 0) field.flush(sink);   // only redraw when something changed
        };

        if (!manual) unsubFrame = frameDelta.subscribe(frame);

        // If the sink can lose its GL context (the WebGL2 backend can), re-seed the
        // whole active range on restore -- the GPU buffer is recreated empty, but the
        // field's backing data survived in JS memory, so one full upload brings it back.
        let unsubRestore = null;
        if (sink && typeof sink.onContextRestored === "function") {
            unsubRestore = sink.onContextRestored(() => {
                field.touchAll();
                field.flush(sink);
            });
        }

        const handle = {
            /** Flush this frame if dirty (the per-frame tick). */
            frame,
            /** Force an upload + draw now, regardless of dirty state. */
            flush: () => field.flush(sink),
            stop: () => { if (unsubFrame) { unsubFrame(); unsubFrame = null; } },
            dispose: () => {
                if (disposed) return;
                disposed = true;
                if (unsubFrame) { unsubFrame(); unsubFrame = null; }
                if (unsubRestore) { unsubRestore(); unsubRestore = null; }
                stopProject();
            },
        };
        try { onCleanup(handle.dispose); } catch (_e) { /* no owner */ }
        return handle;
    }

    return { reactiveField };
}

const _default = createDriver({ effect: _effect, onCleanup: _onCleanup, dispose: _dispose });

export const reactiveField = _default.reactiveField;

// Stride presets for the built-in primitive layouts (x, y, then per-primitive attrs).
export const LAYOUT = {
    POINT: 8,   // x, y, size, r, g, b, a, _pad
    QUAD: 9,    // x, y, w, h, rot, r, g, b, a
    LINE: 9,    // x0, y0, x1, y1, width, r, g, b, a
};
