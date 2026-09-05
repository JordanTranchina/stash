/**
 * @jest-environment jsdom
 *
 * Unit tests for web/bug-report.js — the "Report a Bug" modal.
 *
 * The reporter used to auto-capture a screenshot with html2canvas on every
 * open, which walked the whole page's DOM/CSSOM on the main thread and used
 * to freeze typing (see git history for that fix). Auto-capture has since
 * been removed entirely — a report now carries only what the user types and
 * whatever files they attach manually — so these tests cover open() opening
 * immediately and focusing the textarea, reset() clearing attachment state,
 * and gatherFiles()/submit() working from manual attachments only.
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

  test('open() reveals the modal and focuses the textarea immediately', async () => {
    const reporter = new BugReporter(fakeApp());
    const modal = document.getElementById('bug-report-modal');
    const textarea = document.getElementById('bug-report-text');
    const focusSpy = jest.spyOn(textarea, 'focus');

    await reporter.open();

    expect(modal.classList.contains('hidden')).toBe(false);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  test('open({ prefillError: true }) prefills the observed field from the last error', async () => {
    window.StashLog = { getLastError: () => ({ message: 'boom' }) };
    const reporter = new BugReporter(fakeApp());

    await reporter.open({ prefillError: true });

    expect(document.getElementById('bug-report-observed').value).toBe('Error: boom');
    expect(document.getElementById('bug-report-detail').open).toBe(true);

    delete window.StashLog;
  });

  test('reset() clears attachments and revokes their preview URLs', () => {
    const reporter = new BugReporter(fakeApp());
    global.URL.revokeObjectURL = jest.fn();
    reporter.attachments = [
      { blob: new Blob(['x']), name: 'a.png', type: 'image/png', previewUrl: 'blob:a' },
    ];

    reporter.reset();

    expect(reporter.attachments).toEqual([]);
    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:a');
  });

  test('addFiles() caps attachments at MAX_ATTACHMENTS', () => {
    const reporter = new BugReporter(fakeApp());
    global.URL.createObjectURL = jest.fn(() => 'blob:fake');
    const files = Array.from({ length: 6 }, (_, i) =>
      new File(['x'], `f${i}.png`, { type: 'image/png' }));

    reporter.addFiles(files);

    expect(reporter.attachments).toHaveLength(reporter.MAX_ATTACHMENTS);
  });

  test('gatherFiles() returns exactly the manually attached files', () => {
    const reporter = new BugReporter(fakeApp());
    const blob = new Blob(['x'], { type: 'image/png' });
    reporter.attachments = [{ blob, name: 'shot.png', type: 'image/png' }];

    expect(reporter.gatherFiles()).toEqual([{ blob, name: 'shot.png' }]);
  });

  test('gatherFiles() returns nothing when the user attached nothing', () => {
    const reporter = new BugReporter(fakeApp());
    expect(reporter.gatherFiles()).toEqual([]);
  });

  test('submit() posts only the description and manual attachments, with no screenshot', async () => {
    const reporter = new BugReporter(fakeApp());
    document.getElementById('bug-report-text').value = 'Something broke';
    const blob = new Blob(['x'], { type: 'image/png' });
    reporter.attachments = [{ blob, name: 'shot.png', type: 'image/png' }];

    let posted;
    reporter.postReport = jest.fn(async (token, fields, files) => {
      posted = { fields, files };
      return { ok: true, json: async () => ({}) };
    });

    await reporter.submit();

    expect(posted.files).toEqual([{ blob, name: 'shot.png' }]);
    expect(posted.fields.description).toBe('Something broke');
  });
});
