/**
 * @zakkster/lite-gl -- signal-native instanced primitive renderer.
 * Core (this file) is renderer-agnostic and tested; the WebGL2 sink is GLBackend.js.
 */

/** Package version. Kept in sync with package.json and llms.txt. */
export const VERSION: "1.5.0";

/** Fills `stride` floats of `data` starting at `base`. Must not allocate (hot path). */
export type WriteFn = (data: Float32Array, base: number) => void;

/** A packed instanced-attribute buffer with dirty-range batching. */
export interface Field {
    readonly stride: number;
    readonly data: Float32Array;
    readonly count: number;
    readonly capacity: number;
    dirtyLo(): number;
    dirtyHi(): number;
    push(write: WriteFn): number;
    set(i: number, write: WriteFn): void;
    swapRemove(i: number): void;
    setCount(n: number): void;
    touch(i: number): void;
    touchAll(): void;
    clearDirty(): void;
    flush(sink: Sink): void;
    reset(): void;
}

export function createField(cfg: { capacity?: number; stride: number }): Field;

/** The GPU boundary. GLBackend.js implements this for WebGL2; tests use a mock. */
export interface Sink {
    upload(data: Float32Array, floatOffset: number, floatCount: number, instanceOffset: number, stride: number): void;
    draw(count: number): void;
}

export interface ReactiveFieldOptions {
    /** Reads signals and writes the field; re-runs when a tracked signal changes. */
    project: (field: Field) => void;
    sink: Sink;
    /** Drive via frame()/flush() instead of lite-raf. Default false. */
    manual?: boolean;
}

export interface FieldDriver {
    /** Flush this frame if dirty (per-frame tick). */
    frame(): void;
    /** Force upload + draw now. */
    flush(): void;
    stop(): void;
    dispose(): void;
}

export function reactiveField(field: Field, opts: ReactiveFieldOptions): FieldDriver;

export interface SignalRegistry {
    effect: (...args: any[]) => any;
    onCleanup: (...args: any[]) => any;
    dispose: (...args: any[]) => any;
}

export interface Driver {
    reactiveField: typeof reactiveField;
}

export function createDriver(reg: SignalRegistry): Driver;

// === v1.4.0: deep-zoom precision ===========================================

/**
 * Stride presets.
 *
 * POINT / QUAD / LINE hold **screen pixels** -- `project()` bakes the camera in on the
 * CPU (in float64), so the float32 field only ever sees small numbers. That is the
 * relative-to-eye contract, and it is why precision has never been an issue. The cost:
 * every camera change re-projects every instance and re-uploads the dirty range.
 *
 * POINT_HI holds **world coordinates**, double-emulated as a hi/lo float32 pair, and
 * moves the camera into the vertex shader. Upload once; a pan becomes a uniform update.
 */
export const LAYOUT: {
    readonly POINT: 8;
    readonly QUAD: 9;
    readonly LINE: 9;
    readonly POINT_HI: 10;
};

/** The gap between representable float32 values at magnitude `v`. */
export function f32Ulp(v: number): number;

/**
 * Does this coordinate range need LAYOUT.POINT_HI?
 *
 * @param maxAbsCoord Largest absolute world coordinate you will hold.
 * @param resolution  Smallest difference that must stay distinguishable.
 * @example needsHiPrecision(Date.now(), 1000) // true -- epoch-ms ULP is ~131 s
 */
export function needsHiPrecision(maxAbsCoord: number, resolution: number): boolean;

/** High part of a float64: the nearest float32. */
export function hiOf(v: number): number;

/** Low part: the residual after the high part. Exact -- `hiOf(v) + loOf(v) === v`. */
export function loOf(v: number): number;

/**
 * Write one LAYOUT.POINT_HI instance. `x`/`y` are float64 WORLD coordinates -- pass the
 * raw timestamp, not a projected pixel. Zero allocation; writes 10 floats at `base`.
 */
export function writePointHi(
    data: Float32Array,
    base: number,
    x: number,
    y: number,
    size: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void;
