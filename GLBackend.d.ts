import type { Sink } from "./GL.js";

/** Shared by every WebGL2 sink (v1.3). */
export interface GLSink extends Sink {
    gl: WebGL2RenderingContext;
    capacity: number;
    /** Match the viewport (call on canvas resize). The pick target follows the size. */
    resize(w: number, h: number): void;
    /**
     * Clip draws AND picks to a rect -- one pane of a multi-pane chart.
     * `x, y` are TOP-LEFT origin in device pixels, like every other coordinate in
     * this library; GL's own bottom-left scissor origin is handled internally.
     */
    setScissor(x: number, y: number, w: number, h: number): void;
    /** Draw to the whole viewport again. */
    clearScissor(): void;
    /**
     * Set the clear colour, owning the write so `pick()` restores it from a JS mirror
     * instead of an allocating `getParameter` (v1.4.1). Applies it immediately; route your
     * app's clear colour through this if you want a pick to leave it untouched. The default
     * mirror is (0,0,0,0), the GL default.
     */
    setClearColor(r: number, g: number, b: number, a: number): void;
    /**
     * Instance index under (x, y) -- device pixels, top-left origin -- or -1 for a miss.
     *
     * Renders one ID pass into an offscreen RGBA8 target (each instance flat-shaded with
     * its index) and reads back a single pixel. The CPU does no hit-testing, so this is
     * O(1) on the CPU even at 1M instances; the GPU cost is one extra draw. Call it on
     * demand (a throttled `pointermove`), never every frame.
     *
     * Defaults to the instance count last passed to `draw()`. Honours `setScissor`, so a
     * hover cannot hit a neighbouring pane. ZERO ALLOCATION (v1.4.1): restores the clear
     * colour, blend and the default draw framebuffer with no allocating getter. Throws a
     * RangeError when the top index (`count - 1`) would exceed `PICK_MAX_ID` -- i.e. a
     * `count` above `PICK_MAX_ID + 1`, the largest the 24-bit ID buffer can address.
     */
    pick(x: number, y: number, count?: number): number;
    onContextRestored(cb: () => void): () => void;
    isContextLost(): boolean;
    dispose(): void;
}

/** A WebGL2 point-instance sink (browser-only). Renders LAYOUT.POINT fields as GL_POINTS. */
export interface PointSink extends GLSink {}

export function createPointSink(gl: WebGL2RenderingContext, opts: { capacity: number }): PointSink;

/** A WebGL2 instanced-quad sink (v1.1, browser-only).
 * Renders LAYOUT.QUAD fields (x,y,w,h,rot,rgba) using instanced TRIANGLE_STRIP + vertexAttribDivisor.
 * Unlocks bars, rotated scatter markers, heatmap cells etc.
 */
export interface QuadSink extends GLSink {}

export function createQuadSink(gl: WebGL2RenderingContext, opts: { capacity: number }): QuadSink;

/** A WebGL2 instanced thick-line sink (v1.2, browser-only).
 * Renders LAYOUT.LINE fields (x0,y0,x1,y1,width,rgba) as butt-capped screen-space
 * segment quads expanded in the vertex shader from p0/p1 + width. One instanced
 * TRIANGLE_STRIP draw call. Unlocks line charts, multi-series lines, step lines.
 */
export interface LineSink extends GLSink {}

export function createLineSink(gl: WebGL2RenderingContext, opts: { capacity: number }): LineSink;

/**
 * A WebGL2 world-space point sink with the camera on the GPU (v1.4, browser-only).
 *
 * Renders LAYOUT.POINT_HI fields: coordinates are WORLD values, double-emulated as a
 * hi/lo float32 pair. The vertex shader computes `(posHi - camHi) + (posLo - camLo)`,
 * where the high parts cancel exactly, so an epoch-millisecond timestamp survives what
 * would otherwise be ~131-second float32 quantization.
 *
 * The point is not just precision -- it is that the world coordinates upload ONCE.
 * With the screen-space sinks a pan re-projects every instance on the CPU and re-uploads
 * the dirty range (~5 ms and 31 MB per frame at 1M points). Here, a pan is `setCamera()`.
 */
export interface PointHiSink extends GLSink {
    /**
     * Move the camera. Zero allocation, zero upload.
     *
     * @param x  world x at the eye (float64 -- a raw epoch-ms timestamp is fine)
     * @param y  world y at the eye
     * @param sx world x units -> pixels. Default 1.
     * @param sy world y units -> pixels. Defaults to `sx`.
     * @param px pixel x of the eye. Defaults to the canvas centre, and tracks resize.
     * @param py pixel y of the eye. Defaults to the canvas centre.
     */
    setCamera(x: number, y: number, sx?: number, sy?: number, px?: number, py?: number): void;

    /** Current camera, for tests and debugging. Allocates -- not for the frame loop. */
    getCamera(): {
        x: number; y: number;
        hiX: number; hiY: number; loX: number; loY: number;
        scaleX: number; scaleY: number;
        originX: number; originY: number;
    };
}

export function createPointHiSink(gl: WebGL2RenderingContext, opts: { capacity: number }): PointHiSink;

/**
 * Largest pickable instance index (v1.3). IDs are encoded in 24 bits of RGB and
 * 0xFFFFFF is reserved as the "miss" value, so 0 .. 0xFFFFFE are pickable.
 */
export const PICK_MAX_ID: number;
