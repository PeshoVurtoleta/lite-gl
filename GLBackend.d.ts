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
