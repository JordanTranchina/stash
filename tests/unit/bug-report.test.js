/**
 * @jest-environment jsdom
 *
 * Unit tests for web/bug-report.js — the "Report a Bug" modal.
 *
 * Covers the fixes for the freeze reported when typing in the bug report
 * box: the screenshot capture (html2canvas walking the whole document) used
 * to run AFTER the modal opened and the text box was focused, so the user
 * could start typing into a main thread that was still busy rasterizing the
 * page. These tests pin down that capture now finishes before the modal (and
 * the text box) become interactive, that a hung capture can't block the
 * modal forever, and that re-binding events doesn't stack duplicate
 * listeners.
 *
 * Uses jsdom (via the docblock above) so BugReporter's real
 * document.getElementById calls resolve against actual DOM nodes, mirroring
 * the relevant slice of web/index.html's #bug-report-modal markup.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Minimal stand-in for the #bug-report-modal markup in web/index.html —
// every id/class BugReporter looks up, without the rest of the page.
const MODAL_HTML = `
  <button id="bug-report-settings-btn"></button>
  <div id="bug-report-modal" class="modal hidden">
    <div class="modal-overlay"></div>
    <div class="modal-content">
      <div class="modal-header">
        <button class="modal-close-btn"></button>
      </div>
      <div class="modal-body">
        <textarea id="bug-report-text"></textarea>
        <div id="bug-report-shot" class="bug-report-shot hidden"></div>
        <input type="file" id="bug-report-files" multiple>
        <div id="bug-report-attachments"></div>
        <details id="bug-report-detail">
          <textarea id="bug-report-steps"></textarea>
          <textarea id="bug-report-expected"></textarea>
          <textarea id="bug-report-observed"></textarea>
        </details>
        <div id="bug-report-status" class="hidden"></div>
      </div>
      <div class="modal-footer">
        <button id="bug-report-cancel-btn"></button>
        <button id="bug-report-submit-btn"></button>
      </div>
    </div>
  </div>
`;

function loadBugReporter() {
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', 'web', 'bug-report.js'),
    'utf8'
  );
  // bug-report.js is a plain script (no module wrapper) that assigns
  // `window.BugReporter` at the end — running it as a function body in this
  // jsdom test environment lets it see the real `document`/`window` globals,
  // same as a <script> tag would in the page.
  // eslint-disable-next-line no-new-func
  new Function(code)();
  return window.BugReporter;
}

function fakeApp() {
  return {
    currentView: 'all',
    user: { email: 'reader@example.com' },
    getAccessToken: async () => 'fake-token',
    showToast: () => {},
  };
}

describe('BugReporter', () => {
  let BugReporter;

  beforeEach(() => {
    document.body.innerHTML = MODAL_HTML;
    BugReporter = loadBugReporter();
  });

  test('bindEvents() called twice does not stack duplicate listeners', () => {
    const reporter = new BugReporter(fakeApp());
    const docSpy = jest.spyOn(document, 'addEventListener');
    const winSpy = jest.spyOn(window, 'addEventListener');

    reporter.bindEvents();
    reporter.bindEvents();

    expect(docSpy.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(1);
    expect(winSpy.mock.calls.filter((c) => c[0] === 'online')).toHaveLength(1);

    docSpy.mockRestore();
    winSpy.mockRestore();
  });

  test('open() does not reveal the modal or focus the textarea until the screenshot capture settles', async () => {
    const reporter = new BugReporter(fakeApp());
    let resolveCapture;
    reporter.captureScreenshot = jest.fn(
      () => new Promise((resolve) => { resolveCapture = resolve; })
    );

    const modal = document.getElementById('bug-report-modal');
    const textarea = document.getElementById('bug-report-text');
    const focusSpy = jest.spyOn(textarea, 'focus');

    const openPromise = reporter.open({ autoShot: true });

    // Capture is still pending: the user must not be able to type into a
    // modal that isn't shown, or have focus land while the page is busy.
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(focusSpy).not.toHaveBeenCalled();

    resolveCapture();
    await openPromise;

    expect(modal.classList.contains('hidden')).toBe(false);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  test('open({ autoShot: false }) skips the capture and opens immediately', async () => {
    const reporter = new BugReporter(fakeApp());
    reporter.captureScreenshot = jest.fn(() => Promise.resolve());

    await reporter.open({ autoShot: false });

    expect(reporter.captureScreenshot).not.toHaveBeenCalled();
    expect(document.getElementById('bug-report-modal').classList.contains('hidden')).toBe(false);
  });

  test('a hung html2canvas capture times out instead of blocking the form', async () => {
    const reporter = new BugReporter(fakeApp());
    reporter.SCREENSHOT_TIMEOUT_MS = 10;
    // Simulates html2canvas() never resolving (a huge/odd page).
    reporter.loadHtml2canvas = jest.fn(() => Promise.resolve(() => new Promise(() => {})));

    await reporter.captureScreenshot();

    expect(reporter.screenshotBlob).toBeNull();
    expect(document.getElementById('bug-report-shot').innerHTML).toMatch(/couldn.?t auto-capture/i);
  });

  test('captureScreenshot shoots only the viewport at scale 1, not the whole scrollable page', async () => {
    const reporter = new BugReporter(fakeApp());
    const fakeCanvas = { toBlob: (cb) => cb(new Blob(['x'], { type: 'image/png' })) };
    const html2canvasMock = jest.fn(() => Promise.resolve(fakeCanvas));
    reporter.loadHtml2canvas = jest.fn(() => Promise.resolve(html2canvasMock));
    global.URL.createObjectURL = jest.fn(() => 'blob:fake');

    await reporter.captureScreenshot();

    expect(html2canvasMock).toHaveBeenCalledWith(document.body, expect.objectContaining({
      scale: 1,
      width: window.innerWidth,
      height: window.innerHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
    }));
    expect(reporter.screenshotBlob).not.toBeNull();
  });
});
