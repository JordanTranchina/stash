// Stub for linkedom's optional `canvas` dependency.
//
// linkedom lazily references the native `canvas` package to back
// <canvas> elements. We import linkedom with `?external=canvas` so the edge
// bundler doesn't try to build canvas's native .node binary (which fails), and
// then map the resulting bare `canvas` specifier here.
//
// linkedom's HTMLCanvasElement calls createCanvas(300, 150) in its constructor,
// so every <canvas> tag in a fetched page reaches this file while the page is
// parsed. createCanvas must therefore return an inert object rather than throw,
// or a single <canvas> (charts, ads, games) fails the whole save (issue #168).
// This mirrors linkedom's own fallback shim (commonjs/canvas-shim.cjs): we never
// draw, so getContext() is null and toDataURL() is empty.
export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return null;
  }

  toDataURL() {
    return "";
  }
}

export class Image {}

export const createCanvas = (width, height) => new Canvas(width, height);

// Loading pixel data is real rendering work we can't do here; reject so a
// caller's own error handling runs instead of receiving a fake image.
export const loadImage = () =>
  Promise.reject(new Error("canvas is not supported in the save-page edge function"));

export default { createCanvas, loadImage, Canvas, Image };
