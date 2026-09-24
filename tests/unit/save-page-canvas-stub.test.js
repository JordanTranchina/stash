/**
 * Unit tests for supabase/functions/save-page/canvas_stub.js.
 *
 * linkedom's HTMLCanvasElement calls createCanvas(300, 150) in its constructor,
 * so every <canvas> tag in a fetched page reaches the stub during parseHTML().
 * The stub used to throw there, which failed the whole save for any page with a
 * chart, ad or game canvas (issue #168). These tests pin the stub to the same
 * inert behaviour as linkedom's own fallback shim.
 *
 * The stub is an ES module and Jest runs without a transform, so (as with the
 * other browser/Deno files) it is loaded through `vm` with its `export`
 * keywords stripped.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STUB_PATH = path.join(__dirname, '../../supabase/functions/save-page/canvas_stub.js');

function loadStub() {
  const source = fs.readFileSync(STUB_PATH, 'utf8')
    .replace(/^export default .*$/m, '')
    .replace(/^export /gm, '');
  const context = vm.createContext({ Promise, Error });
  vm.runInContext(`${source}\nthis.stub = { createCanvas, loadImage, Canvas, Image };`, context);
  return context.stub;
}

describe('save-page canvas stub', () => {
  const stub = loadStub();

  test('createCanvas does not throw, so a <canvas> tag can be parsed', () => {
    expect(() => stub.createCanvas(300, 150)).not.toThrow();
  });

  test('createCanvas returns an inert canvas with the requested size', () => {
    const canvas = stub.createCanvas(300, 150);
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(150);
    expect(canvas.getContext('2d')).toBeNull();
    expect(canvas.toDataURL()).toBe('');
  });

  test('loadImage rejects instead of returning a fake image', async () => {
    await expect(stub.loadImage('https://example.com/a.png')).rejects.toThrow(/not supported/);
  });

  test('deno.json still maps the bare canvas specifier to the stub', () => {
    const denoJson = JSON.parse(fs.readFileSync(path.join(path.dirname(STUB_PATH), 'deno.json'), 'utf8'));
    expect(denoJson.imports.canvas).toBe('./canvas_stub.js');
  });
});
