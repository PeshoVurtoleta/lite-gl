import type { Sink } from "./GL.js";

/** A WebGL2 point-instance sink (browser-only). Renders LAYOUT.POINT fields as GL_POINTS. */
export interface PointSink extends Sink {
    gl: WebGL2RenderingContext;
    resize(w: number, h: number): void;
    dispose(): void;
}

export function createPointSink(gl: WebGL2RenderingContext, opts: { capacity: number }): PointSink;

/** A WebGL2 instanced-quad sink (v1.1, browser-only).
 * Renders LAYOUT.QUAD fields (x,y,w,h,rot,rgba) using instanced TRIANGLE_STRIP + vertexAttribDivisor.
 * Unlocks bars, rotated scatter markers, heatmap cells etc.
 */
export interface QuadSink extends Sink {
    gl: WebGL2RenderingContext;
    resize(w: number, h: number): void;
    dispose(): void;
}

export function createQuadSink(gl: WebGL2RenderingContext, opts: { capacity: number }): QuadSink;

/** A WebGL2 instanced thick-line sink (v1.2, browser-only).
 * Renders LAYOUT.LINE fields (x0,y0,x1,y1,width,rgba) as butt-capped screen-space
 * segment quads expanded in the vertex shader from p0/p1 + width. One instanced
 * TRIANGLE_STRIP draw call. Unlocks high-performance line charts, multi-series
 * lines, step lines, and area outlines.
 */
export interface LineSink extends Sink {
    gl: WebGL2RenderingContext;
    resize(w: number, h: number): void;
    dispose(): void;
}

export function createLineSink(gl: WebGL2RenderingContext, opts: { capacity: number }): LineSink;
