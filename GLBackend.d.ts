import type { Sink } from "./GL.js";

/** A WebGL2 point-instance sink (browser-only). Renders LAYOUT.POINT fields as GL_POINTS. */
export interface PointSink extends Sink {
    gl: WebGL2RenderingContext;
    resize(w: number, h: number): void;
    dispose(): void;
}

export function createPointSink(gl: WebGL2RenderingContext, opts: { capacity: number }): PointSink;
