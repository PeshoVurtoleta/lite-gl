/**
 * @zakkster/lite-gl -- signal-native instanced primitive renderer.
 * Core (this file) is renderer-agnostic and tested; the WebGL2 sink is GLBackend.js.
 */

/** floats-per-instance presets (x, y, then per-primitive attributes). */
export declare const LAYOUT: {
    readonly POINT: 8;
    readonly QUAD: 9;
    readonly LINE: 9;
};

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
