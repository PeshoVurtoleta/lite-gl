/**
 * @zakkster/lite-gl v1.5.0 -- signal-native instanced primitive renderer.
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
} from "@zakkster/lite-signal";
import { frameDelta } from "@zakkster/lite-raf";

/** Package version. Kept in sync with package.json and llms.txt (packaging law). */
export const VERSION = "2.0.0-alpha.0";

/** Hard cap on a field's instance capacity: 2^30. Above this the power-of-two
 *  sizing (`p <<= 1`, a 32-bit shift) would wrap negative and `nextPow2` could
 *  never terminate. createField rejects a capacity above this before it is reached. */
const FIELD_MAX_CAPACITY = 1 << 30;

function nextPow2(n) {
    let p = 1;
    // Bounded by FIELD_MAX_CAPACITY so a bad `n` that ever slips past validation
    // (Infinity, > 2^30, NaN) can NEVER infinite-loop: the shift stops at 2^30
    // instead of wrapping to a negative Int32 and looping forever. Belt and braces.
    while (p < n && p < FIELD_MAX_CAPACITY) p <<= 1;
    return p;
}

// The only config keys createField accepts. An unknown key is a typo, not an
// option to silently ignore (fail closed) -- we throw with a did-you-mean hint.
const FIELD_KEYS = ["stride", "capacity"];

// Cheap edit distance for the did-you-mean hint. Cold path (construction only).
function editDistance(a, b) {
    const m = a.length, n = b.length;
    const row = new Array(n + 1);
    for (let j = 0; j <= n; j++) row[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = row[j];
            row[j] = Math.min(
                row[j] + 1,
                row[j - 1] + 1,
                prev + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1)
            );
            prev = tmp;
        }
    }
    return row[n];
}
function didYouMean(key, candidates = FIELD_KEYS) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const d = editDistance(key, candidates[i]);
        if (d < bestD) { bestD = d; best = candidates[i]; }
    }
    return bestD <= 3 ? best : null;
}

/**
 * A packed instanced-attribute buffer with dirty-range batching.
 * @param {{ capacity?: number, stride: number }} cfg  stride = floats per instance.
 * @returns {object} field
 */
export function createField(cfg) {
    // --- construction-only validation (cold path). Fail closed here, ONCE, before
    // the first `new Float32Array`, so the hot bodies (push/set/swapRemove/flush/
    // writePointHi) gain zero new branches. A bad stride would otherwise write to
    // `data[NaN]` in silence and drop the point; an unknown key is a typo, not an
    // option to ignore. null is not zero. ---
    if (cfg === null || typeof cfg !== "object") {
        throw new TypeError("lite-gl createField: a config object is required, e.g. { stride: LAYOUT.POINT }.");
    }
    for (const k in cfg) {
        if (k !== "stride" && k !== "capacity") {
            const hint = didYouMean(k);
            throw new Error(
                "lite-gl createField: unknown option '" + k + "'"
                + (hint ? " -- did you mean '" + hint + "'?" : "")
                + " Valid keys: stride, capacity."
            );
        }
    }
    const stride = cfg.stride;
    if (typeof stride !== "number" || !Number.isInteger(stride) || stride <= 0) {
        throw new Error(
            "lite-gl createField: `stride` must be a positive integer (floats per instance) -- "
            + "use a LAYOUT value: POINT=8, QUAD=9, LINE=9, POINT_HI=10. Got " + String(stride) + "."
        );
    }
    // `capacity` must be a FINITE positive integer. The finiteness check is load-
    // bearing: `Infinity > 0` is true, so a bare `> 0` test would let Infinity (and
    // any value past 2^30) reach nextPow2 and hang -- a fail-OPEN worse than the
    // data[NaN] this validation exists to stop. `capacity: 0` was previously an
    // implicit "use the default 1024" (0 || 1024); that ambiguous degenerate input
    // is now rejected too (null is not zero).
    if (cfg.capacity !== undefined) {
        const cap = cfg.capacity;
        if (typeof cap !== "number" || !Number.isInteger(cap) || cap <= 0) {
            throw new Error(
                "lite-gl createField: `capacity` must be a finite positive integer when present. Got "
                + String(cap) + "."
            );
        }
        if (cap > FIELD_MAX_CAPACITY) {
            throw new RangeError(
                "lite-gl createField: `capacity` " + cap + " exceeds the hard cap "
                + FIELD_MAX_CAPACITY + " (2^30 instances). A larger buffer would overflow the "
                + "power-of-two sizing; split the field or lower the capacity."
            );
        }
    }
    let capacity = nextPow2(cfg.capacity || 1024);
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
                // Clamp a post-shrink stale range to the active count (N-3): a
                // swapRemove/setCount that lowered `count` can leave dHi >= count,
                // which would upload floats past the live range. No allocation.
                const hi = Math.min(dHi, count - 1);
                if (hi >= dLo) {
                    const floatOffset = dLo * stride;
                    const floatCount = (hi - dLo + 1) * stride;
                    sink.upload(data, floatOffset, floatCount, dLo, stride);
                }
                dLo = -1; dHi = -1;
            }
            sink.draw(count);
        },
        reset() { count = 0; dLo = -1; dHi = -1; },
    };
    return field;
}

/**
 * Bind-time (ONCE) capability check -- the v2.0.0 caps seam. Cold path: this runs when a
 * field is bound in reactiveField, never per frame, and the per-frame `frame` closure
 * gains NO `sink.caps.*` read. Fails closed on every unverified state (null is not zero):
 *   - a sink with no caps descriptor -> throw (refuse to bind an un-advertised sink);
 *   - a POINT_HI-stride field on a sink that does not advertise precisionHi -> throw;
 *   - a field whose capacity exceeds caps.maxInstances -> throw with a size hint.
 * Everything read here is validated and discarded; nothing caps-derived leaks into the hot path.
 */
function assertCaps(sink, field) {
    const caps = sink && sink.caps;
    if (caps === null || typeof caps !== "object") {
        throw new Error(
            "lite-gl reactiveField: sink.caps is missing -- a sink must advertise a frozen "
            + "caps descriptor (v2.0.0). Refusing to bind (null is not zero)."
        );
    }
    // Fail closed on a malformed descriptor BEFORE the comparisons below: a caps that
    // omits maxInstances would make `field.capacity > undefined` fail OPEN (=== false),
    // silently binding an over-capacity field. A non-boolean precisionHi is equally an
    // un-advertised capability. Built-in sinks always satisfy this; it hardens the
    // custom-caps path the v2 seam invites.
    if (typeof caps.precisionHi !== "boolean") {
        throw new Error(
            "lite-gl reactiveField: sink.caps.precisionHi must be a boolean -- got "
            + String(caps.precisionHi) + ". Refusing to bind (unverified capability)."
        );
    }
    if (typeof caps.maxInstances !== "number" || !Number.isFinite(caps.maxInstances)) {
        throw new Error(
            "lite-gl reactiveField: sink.caps.maxInstances must be a finite number -- got "
            + String(caps.maxInstances) + ". Refusing to bind (null is not zero)."
        );
    }
    if (field.stride === LAYOUT.POINT_HI && !caps.precisionHi) {
        throw new Error(
            "lite-gl reactiveField: field stride is LAYOUT.POINT_HI (" + LAYOUT.POINT_HI + ") but this "
            + "sink does not advertise precisionHi -- bind a POINT_HI field to a createPointHiSink."
        );
    }
    if (field.capacity > caps.maxInstances) {
        throw new RangeError(
            "lite-gl reactiveField: field capacity " + field.capacity + " exceeds sink caps.maxInstances "
            + caps.maxInstances + " -- lower the field capacity or split the field across sinks."
        );
    }
}

/**
 * Bind a field to reactive inputs: `project(field)` (which reads signals and writes
 * the field) re-runs when a tracked signal changes, and the dirty range is flushed
 * to `sink` once per frame on lite-raf. { manual: true } -> drive via frame()/flush().
 *
 * @param {{effect:Function, onCleanup:Function}} reg
 */
export function createDriver(reg) {
    const effect = reg.effect;
    const onCleanup = reg.onCleanup;

    function reactiveField(field, opts) {
        const project = opts.project;
        const sink = opts.sink;
        const manual = !!opts.manual;

        // v2.0.0 caps seam: read sink.caps EXACTLY ONCE, here at bind, and fail closed.
        // Nothing below reads caps -- the per-frame `frame` closure stays caps-free.
        assertCaps(sink, field);

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
            /** Force an upload + draw now, regardless of dirty state. No-op once disposed. */
            flush: () => { if (disposed) return; field.flush(sink); },
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

const _default = createDriver({ effect: _effect, onCleanup: _onCleanup });

export const reactiveField = _default.reactiveField;

// Stride presets for the built-in primitive layouts.
//
// POINT / QUAD / LINE hold **screen pixels**. That is the contract: `project()` runs in
// JS (float64) and writes post-camera pixel coordinates, so the float32 field only ever
// sees small numbers. Precision is a non-issue -- but every camera change re-projects
// every instance on the CPU and re-uploads the dirty range.
//
// POINT_HI (v1.4.0) holds **world coordinates**, split hi/lo, and moves the camera onto
// the GPU. Upload once; pan and zoom become a uniform update. See below.
export const LAYOUT = {
    POINT: 8,      // x, y, size, r, g, b, a, _pad                 -- screen px
    QUAD: 9,       // x, y, w, h, rot, r, g, b, a                  -- screen px
    LINE: 9,       // x0, y0, x1, y1, width, r, g, b, a            -- screen px
    POINT_HI: 10,  // xHi, yHi, xLo, yLo, size, r, g, b, a, _pad   -- WORLD, double-emulated
};

// === v1.4.0: DEEP-ZOOM PRECISION ===========================================
//
// THE PROBLEM. float32 carries a 24-bit significand: integers are exact only up to
// 2^24 = 16,777,216. A Unix epoch millisecond is ~1.78e12, which lands the ULP at
// 131,072 ms -- about 2.2 minutes. Store epoch-ms in a float32 and a full minute of
// one-second ticks collapses onto a SINGLE representable value. Epoch-seconds is no
// escape either (~1.78e9, ULP ~128 s). Any time-series that holds raw timestamps in
// world space is already past the cliff.
//
// THE FIX. Relative-to-eye, done properly: split each float64 coordinate into two
// float32s (a high part and the residual), split the camera the same way, and let the
// GPU compute
//
//     rel = (posHi - camHi) + (posLo - camLo)
//
// The high parts are float32s of near-identical magnitude, so `posHi - camHi` cancels
// EXACTLY (Sterbenz). The residuals then carry the detail.
//
// THE GUARANTEE, precisely. Error scales with distance FROM THE EYE, not with absolute
// magnitude. A point within a day of the camera round-trips bit-exactly from an epoch-ms
// timestamp; a point a year away is good to ~800 ms. That sounds like a caveat and is
// actually the whole point: you only see far-away points when you are zoomed OUT, and the
// pixel gets bigger at exactly the rate the error does. Worst-case error across a 2000px
// viewport is ~1e-4 px -- at ANY zoom level, at ANY absolute magnitude. The naive path
// degrades with absolute magnitude, which nothing can save you from.
//
// WHY BOTHER, when project() could just keep doing this on the CPU? Because it already
// does, and that is exactly what caps the 1M-point pan. Re-projecting 1M points costs
// ~5 ms/frame of pure JS and dirties the whole field -- a 31 MB re-upload, every frame,
// for a camera that moved one pixel. With POINT_HI the world coordinates upload ONCE and
// a pan is four floats of uniform. Zero CPU, zero upload.
//
// Use POINT for anything that fits comfortably in float32 after projection (which is
// almost everything). Reach for POINT_HI when the *world* coordinates are large --
// timestamps, geodetic coords, deep-zoom fractals.

/** The gap between representable float32 values at magnitude `v`. */
export function f32Ulp(v) {
    const a = Math.abs(Math.fround(v));
    if (a === 0 || !Number.isFinite(a)) return 0;
    return Math.pow(2, Math.floor(Math.log2(a)) - 23);
}

/**
 * Does this coordinate range need POINT_HI?
 *
 * @param {number} maxAbsCoord  Largest absolute world coordinate you will hold.
 * @param {number} resolution   Smallest difference you need to stay distinguishable
 *                              (e.g. 1000 for one-second ticks in epoch-ms).
 * @returns {boolean} true when float32 would quantize `resolution` away.
 *
 * @example needsHiPrecision(Date.now(), 1000)  // true -- epoch-ms ULP is ~131072
 * @example needsHiPrecision(1e6, 0.5)          // false -- ULP is 0.0625
 */
export function needsHiPrecision(maxAbsCoord, resolution) {
    return f32Ulp(maxAbsCoord) >= resolution;
}

/** High part of a float64: the nearest float32. */
export const hiOf = (v) => Math.fround(v);

/**
 * Low part: the residual after the high part, itself a float32. `v - fround(v)` is
 * <= ulp(v)/2 in magnitude; fround'ing it back to float32 is lossless only within
 * float32's 23-bit significand -- exact for the near-eye split this layout is built
 * for, and the dominant residual error term otherwise.
 */
export const loOf = (v) => Math.fround(v - Math.fround(v));

/**
 * Write one LAYOUT.POINT_HI instance. `x`/`y` are float64 WORLD coordinates -- pass the
 * raw timestamp, not a projected pixel. The camera lives on the GPU (sink.setCamera).
 *
 * Zero allocation; writes 10 floats at `base`.
 */
export function writePointHi(data, base, x, y, size, r, g, b, a) {
    const xh = Math.fround(x);
    const yh = Math.fround(y);
    data[base] = xh;
    data[base + 1] = yh;
    data[base + 2] = Math.fround(x - xh);   // residual, lossless only within float32's 23-bit significand
    data[base + 3] = Math.fround(y - yh);
    data[base + 4] = size;
    data[base + 5] = r;
    data[base + 6] = g;
    data[base + 7] = b;
    data[base + 8] = a;
    data[base + 9] = 0;
}
