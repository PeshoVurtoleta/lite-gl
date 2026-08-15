import type { Sink } from "./GL.js";
import type { Counters } from "./GLBackend.js";

/**
 * WebGPU backend types (v2.0.0). Declared STRUCTURALLY -- this package pulls in
 * no `@webgpu/types` (zero dev-type deps). We name only the handful of WebGPU shapes
 * the public surface touches; everything else is an opaque `unknown`-friendly object.
 */

/** The minimal WebGPU device surface createGPUTarget needs (structural, no lib.dom.d.ts). */
export interface GPUDeviceLike {
    readonly queue: unknown;
    createShaderModule(descriptor: object): unknown;
    createRenderPipeline(descriptor: object): unknown;
    createBuffer(descriptor: object): unknown;
    createBindGroup(descriptor: object): unknown;
    createCommandEncoder(descriptor?: object): unknown;
    createTexture(descriptor: object): unknown;
    readonly lost?: Promise<unknown>;
    destroy?(): void;
}

/** A canvas exposing getContext("webgpu"). */
export interface GPUCanvasLike {
    getContext(type: "webgpu"): unknown;
    width?: number;
    height?: number;
}

/** Options for createGPUTarget. Pass `device` to INJECT one (the test/mock seam). */
export interface GPUTargetOptions {
    /** Inject a device instead of requesting one from navigator.gpu. */
    device?: GPUDeviceLike;
    /** Canvas format; defaults to navigator.gpu.getPreferredCanvasFormat() or "bgra8unorm". */
    format?: string;
    /** Context alpha mode; defaults to "premultiplied". */
    alphaMode?: string;
    /** Re-acquire a fresh device on restore() (real device-loss recovery). */
    reacquire?: () => Promise<GPUDeviceLike>;
}

/** The acquired WebGPU target: a configured context + device that sinks draw through. */
export interface GPUTarget {
    readonly device: GPUDeviceLike;
    readonly context: unknown;
    readonly format: string;
    resize(w: number, h: number): void;
    isContextLost(): boolean;
    onContextRestored(cb: () => void): () => void;
    /** Re-seed after device loss (rebuilds sink resources, then fires restore callbacks). */
    restore(newDevice?: GPUDeviceLike): Promise<void>;
    dispose(): void;
}

/**
 * Acquire a WebGPU device and configure a canvas context. FAILS CLOSED: an absent
 * navigator.gpu, a null adapter, or a rejected device all throw (never a null sink).
 */
export function createGPUTarget(canvas: GPUCanvasLike, opts?: GPUTargetOptions): Promise<GPUTarget>;

/**
 * Frozen WebGPU sink capability descriptor. Same key set/order as the WebGL2 caps, but
 * `api:"webgpu"`, `baseVertex:true`, and `pickMode:"deferred"` (pick() may return PICK_PENDING).
 */
export interface GPUCaps {
    readonly api: "webgpu";
    readonly instancing: boolean;
    readonly baseVertex: boolean;
    readonly maxInstances: number;
    readonly precisionHi: boolean;
    readonly pickMode: "deferred";
    readonly version: number;
}

/** Sink construction options (mirrors the WebGL2 SinkOptions). */
export interface GPUSinkOptions {
    /** Max instances (sizes the instance buffer once). */
    capacity: number;
    /** Optional lite-profiler-style draw/upload counters handle. */
    counters?: Counters | null;
    /**
     * Blend mode, baked into the DRAW pipeline at construction (WebGPU owns blend in the
     * pipeline; the WebGL2 sink leaves it to the GL context). Defaults to "opaque". The
     * PICK pipeline is always opaque regardless. An unknown value throws (fail closed).
     */
    blend?: "opaque" | "additive" | "alpha";
}

/** Shared by every WebGPU sink. */
export interface GPUSink extends Sink {
    readonly target: GPUTarget;
    readonly capacity: number;
    readonly caps: GPUCaps;
    /** The normalized blend mode baked into the DRAW pipeline ("opaque" by default). */
    readonly blend: "opaque" | "additive" | "alpha";
    resize(w: number, h: number): void;
    setScissor(x: number, y: number, w: number, h: number): void;
    clearScissor(): void;
    setClearColor(r: number, g: number, b: number, a: number): void;
    setCounters(handle: Counters | null): void;
    onContextRestored(cb: () => void): () => void;
    isContextLost(): boolean;
    /**
     * DEFERRED pick. Returns an instance index (>= 0), -1 for a confirmed miss, or
     * PICK_PENDING (-2) when the async GPU readback has not resolved yet. Poll again on a
     * later frame with the same (x, y, count) to collect the resolved index. Throws a
     * RangeError when count - 1 would exceed PICK_MAX_ID.
     */
    pick(x: number, y: number, count?: number): number;
    dispose(): void;
}

/** A WebGPU point sink (LAYOUT.POINT). Points are instanced unit-quads (no gl_PointSize). */
export interface GPUPointSink extends GPUSink {}
export function createGPUPointSink(target: GPUTarget, opts: GPUSinkOptions): GPUPointSink;

/** A WebGPU quad sink (LAYOUT.QUAD). */
export interface GPUQuadSink extends GPUSink {}
export function createGPUQuadSink(target: GPUTarget, opts: GPUSinkOptions): GPUQuadSink;

/** A WebGPU thick-line sink (LAYOUT.LINE). */
export interface GPULineSink extends GPUSink {}
export function createGPULineSink(target: GPUTarget, opts: GPUSinkOptions): GPULineSink;

/** A WebGPU world-space point sink (LAYOUT.POINT_HI) with the camera on the GPU. */
export interface GPUPointHiSink extends GPUSink {
    setCamera(x: number, y: number, sx?: number, sy?: number, px?: number, py?: number): void;
    getCamera(): {
        x: number; y: number;
        hiX: number; hiY: number; loX: number; loY: number;
        scaleX: number; scaleY: number;
        originX: number; originY: number;
    };
}
export function createGPUPointHiSink(target: GPUTarget, opts: GPUSinkOptions): GPUPointHiSink;

/**
 * Largest pickable instance index -- re-exported from the core so it reads bit-identically
 * to GL.js and GLBackend.js.
 */
export const PICK_MAX_ID: number;

/** Deferred-pick sentinel: pick() returns this (-2) while the async readback is unresolved. */
export const PICK_PENDING: number;

/** Pooled deferred-pick readback ring depth (2 in-flight requests max). */
export const PICK_RING_K: number;
