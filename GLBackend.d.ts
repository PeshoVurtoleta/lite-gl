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
     * Instance index under (x, y) -- device pixels, top-left origin -- or -1 for a miss.
     *
     * Renders one ID pass into an offscreen RGBA8 target (each instance flat-shaded with
     * its index) and reads back a single pixel. The CPU does no hit-testing, so this is
     * O(1) on the CPU even at 1M instances; the GPU cost is one extra draw. Call it on
     * demand (a throttled `pointermove`), never every frame.
     *
     * Defaults to the instance count last passed to `draw()`. Honours `setScissor`, so a
     * hover cannot hit a neighbouring pane. Leaves the bound framebuffer, clear colour
     * and blend state exactly as it found them.
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
 * Largest pickable instance index (v1.3). IDs are encoded in 24 bits of RGB and
 * 0xFFFFFF is reserved as the "miss" value, so 0 .. 0xFFFFFE are pickable.
 */
export const PICK_MAX_ID: number;
