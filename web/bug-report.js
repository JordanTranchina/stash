// In-app "Report a bug" reporter for the web app.
//
// Entry points (see app.js bindEvents / global error handlers):
//   - Settings → "Report a Bug"
//   - the "Report" action on a failure toast  → open({ prefillError: true })
//   - ?report-bug=1 in the URL (also the podcast show-notes deep link)
//
// A report is a short description (+ optional repro / expected / observed), an
// auto-captured screenshot, any files the user attaches, and the recent console
// logs + last uncaught error + environment gathered by logbuffer.js. It POSTs a
// multipart form to the `report-bug` Edge Function, which files a GitHub issue.
// If that POST fails (offline, GitHub down) the report is queued in IndexedDB
// and retried on the next app open / "online" event / Background Sync.
class BugReporter {
  constructor(app) {
    this.app = app;
    this.attachments = []; // { blob, name, type, isVideo, previewUrl }
    this.screenshotBlob = null;
    this.submitting = false;
    this._html2canvas = null;
    this.MAX_ATTACHMENTS = 4;
    this.SCREENSHOT_TIMEOUT_MS = 3000;
    this._shotToken = 0; // bumped on every open()/reset() so a capture that's
    // still running when the modal closes (or reopens) can tell its result is
    // stale and must not overwrite the next report's state.
  }

  bindEvents() {
    if (this._bound) return; // guard against double-binding if init() ever re-runs
    this._bound = true;

    const modal = document.getElementById('bug-report-modal');
    if (!modal) return;

    document.getElementById('bug-report-settings-btn')?.addEventListener('click', () => this.open());
    modal.querySelector('.modal-overlay').addEventListener('click', () => this.close());
    modal.querySelector('.modal-close-btn').addEventListener('click', () => this.close());
    document.getElementById('bug-report-cancel-btn').addEventListener('click', () => this.close());
    document.getElementById('bug-report-submit-btn').addEventListener('click', () => this.submit());
    document.getElementById('bug-report-files').addEventListener('change', (e) => this.addFiles(e.target.files));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden') && !this.submitting) this.close();
    });

    // Retry any queued reports when connectivity returns.
    window.addEventListener('online', () => this.flushQueue());
  }

  // The modal opens immediately — never wait on the screenshot to show it or
  // to let the user start typing. captureScreenshot() (viewport-only, capped
  // at SCREENSHOT_TIMEOUT_MS) runs in the background and fills in the "shot"
  // area — starting with a "Capturing screenshot…" placeholder — once it's
  // ready, same as any other async widget on the page.
  async open({ prefillError = false, autoShot = true } = {}) {
    const modal = document.getElementById('bug-report-modal');
    if (!modal) return;
    this.reset();

    if (prefillError) {
      const le = window.StashLog?.getLastError?.();
      if (le && le.message) {
        document.getElementById('bug-report-observed').value = 'Error: ' + le.message;
        document.getElementById('bug-report-detail').open = true;
      }
    }

    modal.classList.remove('hidden');
    document.getElementById('bug-report-text').focus();

    if (autoShot) this.captureScreenshot();
  }

  close() {
    if (this.submitting) return;
    document.getElementById('bug-report-modal').classList.add('hidden');
    this.reset();
  }

  reset() {
    this._shotToken++;
    this.attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    this.attachments = [];
    if (this.screenshotBlob) this.screenshotBlob = null;
    this.submitting = false;

    ['text', 'steps', 'expected', 'observed'].forEach((k) => {
      const el = document.getElementById('bug-report-' + k);
      if (el) el.value = '';
    });
    const detail = document.getElementById('bug-report-detail');
    if (detail) detail.open = false;

    const status = document.getElementById('bug-report-status');
    if (status) { status.classList.add('hidden'); status.textContent = ''; }

    const filesInput = document.getElementById('bug-report-files');
    if (filesInput) filesInput.value = '';

    const shot = document.getElementById('bug-report-shot');
    if (shot) { shot.classList.add('hidden'); shot.innerHTML = ''; }

    this.renderAttachments();
    const btn = document.getElementById('bug-report-submit-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
  }

  // Lazily pull in html2canvas from the CDN (same delivery model as the other
  // web-app libraries). Screenshot capture is best-effort — if this fails
  // (offline, blocked) the user can still attach one manually.
  loadHtml2canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (this._html2canvas) return this._html2canvas;
    this._html2canvas = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => reject(new Error('screenshot library failed to load'));
      document.head.appendChild(s);
    });
    return this._html2canvas;
  }

  // Captures just the visible viewport, not the whole scrollable page — a
  // long saves list made a full-document capture (and the getComputedStyle
  // walk html2canvas does per node) take seconds. This runs before the modal
  // is shown (see open()), so there's no dialog to hide from the shot and no
  // need to fight z-index/visibility around it.
  async captureScreenshot() {
    const shot = document.getElementById('bug-report-shot');
    if (!shot) return;
    const token = this._shotToken;
    shot.classList.remove('hidden');
    shot.innerHTML = '<span class="bug-report-shot-note">Capturing screenshot…</span>';
    let blob = null;
    try {
      blob = await this._captureWithTimeout();
    } catch (e) {
      blob = null;
    }

    // The modal was closed (or reopened) while the capture was running —
    // this result belongs to a report that no longer exists, so drop it.
    if (token !== this._shotToken) return;

    this.screenshotBlob = blob;
    if (blob) {
      shot.innerHTML = '';
      const img = document.createElement('img');
      img.alt = 'Screenshot preview';
      img.src = URL.createObjectURL(blob);
      const label = document.createElement('label');
      label.className = 'bug-report-shot-toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.id = 'bug-report-shot-include';
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' Attach this screenshot'));
      shot.appendChild(img);
      shot.appendChild(label);
    } else {
      shot.innerHTML = '<span class="bug-report-shot-note">Couldn’t auto-capture a screenshot — attach one below if it helps.</span>';
    }
  }

  // Viewport-only capture, with a hard time limit on the WHOLE pipeline —
  // loading html2canvas from the CDN AND running it. A slow/blocked/flaky
  // network fetch of the library is just as capable of leaving "Capturing
  // screenshot…" on screen indefinitely as a hung capture is, so both must
  // share one budget rather than only the capture call being bounded.
  _captureWithTimeout() {
    const attempt = (async () => {
      const html2canvas = await this.loadHtml2canvas();
      const canvas = await html2canvas(document.body, {
        logging: false,
        useCORS: true,
        scale: 1,
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
      });
      return new Promise((r) => canvas.toBlob(r, 'image/png'));
    })();
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('screenshot timed out')), this.SCREENSHOT_TIMEOUT_MS);
    });
    return Promise.race([attempt, timeout]);
  }

  addFiles(fileList) {
    for (const file of fileList) {
      if (this.attachments.length >= this.MAX_ATTACHMENTS) break;
      const isVideo = file.type.startsWith('video/');
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      this.attachments.push({ blob: file, name: file.name, type: file.type, isVideo, previewUrl });
    }
    document.getElementById('bug-report-files').value = '';
    this.renderAttachments();
  }

  renderAttachments() {
    const list = document.getElementById('bug-report-attachments');
    if (!list) return;
    list.innerHTML = '';
    this.attachments.forEach((a, i) => {
      const chip = document.createElement('div');
      chip.className = 'bug-report-chip';
      if (a.previewUrl) {
        const img = document.createElement('img');
        img.src = a.previewUrl;
        img.alt = '';
        chip.appendChild(img);
      }
      const name = document.createElement('span');
      name.textContent = a.name;
      chip.appendChild(name);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.setAttribute('aria-label', 'Remove ' + a.name);
      rm.addEventListener('click', () => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        this.attachments.splice(i, 1);
        this.renderAttachments();
      });
      chip.appendChild(rm);
      list.appendChild(chip);
    });
  }

  collectFields() {
    const view = this.app && this.app.currentView;
    return {
      description: document.getElementById('bug-report-text').value.trim(),
      steps: document.getElementById('bug-report-steps').value.trim(),
      expected: document.getElementById('bug-report-expected').value.trim(),
      observed: document.getElementById('bug-report-observed').value.trim(),
      source: 'web',
      email: (this.app && this.app.user && this.app.user.email) || '',
      env: JSON.stringify((window.StashLog && window.StashLog.getEnv(view)) || {}),
      logs: JSON.stringify((window.StashLog && window.StashLog.getLogs()) || []),
      lastError: JSON.stringify((window.StashLog && window.StashLog.getLastError()) || null),
    };
  }

  gatherFiles() {
    const files = [];
    const includeShot = document.getElementById('bug-report-shot-include');
    if (this.screenshotBlob && (!includeShot || includeShot.checked)) {
      files.push({ blob: this.screenshotBlob, name: 'screenshot.png' });
    }
    this.attachments.forEach((a) => files.push({ blob: a.blob, name: a.name }));
    return files;
  }

  buildFormData(fields, files) {
    const fd = new FormData();
    Object.keys(fields).forEach((k) => fd.append(k, fields[k]));
    files.forEach((f) => fd.append('attachments', f.blob, f.name));
    return fd;
  }

  endpoint() {
    return `${CONFIG.SUPABASE_URL}/functions/v1/report-bug`;
  }

  async postReport(token, fields, files) {
    return fetch(this.endpoint(), {
      method: 'POST',
      headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      body: this.buildFormData(fields, files),
    });
  }

  async submit() {
    if (this.submitting) return;
    const status = document.getElementById('bug-report-status');
    const btn = document.getElementById('bug-report-submit-btn');
    const fields = this.collectFields();

    if (!fields.description) {
      status.textContent = 'Please describe what went wrong.';
      status.className = 'digest-status error';
      status.classList.remove('hidden');
      return;
    }

    this.submitting = true;
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    status.classList.add('hidden');

    const files = this.gatherFiles();
    try {
      const token = await this.app.getAccessToken();
      if (!token) throw new Error('no-session');
      const res = await this.postReport(token, fields, files);
      if (!res.ok) throw new Error('submit-failed:' + res.status);
      const body = await res.json().catch(() => ({}));

      this.submitting = false;
      this.close();
      window.StashAnalytics?.capture('bug_report_submitted', { source: 'web', queued: false });
      this.app.showToast(
        'Bug reported — thank you!',
        body.url
          ? { label: 'View', onClick: () => window.open(body.url, '_blank', 'noopener') }
          : null,
      );
    } catch (e) {
      // Couldn't send now — persist and retry later rather than lose it.
      try {
        await window.StashDB.saveBugReport({
          fields,
          files: files.map((f) => ({ blob: f.blob, name: f.name, type: f.blob.type })),
        });
        this.submitting = false;
        this.close();
        window.StashAnalytics?.capture('bug_report_submitted', { source: 'web', queued: true });
        this.app.showToast('Saved — we’ll send this when you’re back online');
        this.registerSync();
      } catch (queueErr) {
        this.submitting = false;
        btn.disabled = false;
        btn.textContent = 'Submit';
        status.textContent = 'Could not submit or save the report. Please try again.';
        status.className = 'digest-status error';
        status.classList.remove('hidden');
      }
    }
  }

  async registerSync() {
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('sync-bug-reports');
    } catch (e) {
      /* flushQueue on next online/open is the fallback */
    }
  }

  async flushQueue() {
    if (!window.StashDB || !window.StashDB.getBugReports) return;
    let queued;
    try {
      queued = await window.StashDB.getBugReports();
    } catch (e) {
      return;
    }
    if (!queued || !queued.length) return;

    const token = await this.app.getAccessToken();
    if (!token) return;

    for (const { key, data } of queued) {
      try {
        const files = (data.files || []).map((f) => ({ blob: f.blob, name: f.name }));
        const res = await this.postReport(token, data.fields, files);
        if (res.ok) await window.StashDB.deleteBugReport(key);
      } catch (e) {
        /* still failing — leave it queued for next time */
      }
    }
  }
}

if (typeof window !== 'undefined') window.BugReporter = BugReporter;
