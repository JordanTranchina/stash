// Stub for linkedom's optional `canvas` dependency.
//
// linkedom lazily references the native `canvas` package to back
// <canvas> elements. We import linkedom with `?external=canvas` so the edge
// bundler doesn't try to build canvas's native .node binary (which fails), and
// then map the resulting bare `canvas` specifier here. We never render a
// <canvas>, so these throw only if something actually tries to use one.
const notSupported = () => {
  throw new Error("canvas is not supported in the save-page edge function");
};

export const createCanvas = notSupported;
export const loadImage = notSupported;
export class Canvas {}
export class Image {}

export default { createCanvas, loadImage, Canvas, Image };
