// Extension "Report a bug" page. Opened by background.js after it has stashed
// the screenshot + logs + environment under chrome.storage.local key
// `stash_pending_bug`. This page prefills from that, lets the user add detail
// and files, then hands a plain payload back to background.js to POST to the
// `report-bug` Edge Function (attachments travel as data: URLs so they survive
// runtime messaging).

const $ = (id) => document.getElementById(id);
const MAX_ATTACHMENTS = 4;

let context = { screenshot: null, logs: [], lastError: null, env: {} };
let screenshotDataUrl = null;
const attachments = []; // { name, type, dataUrl, previewUrl }

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function setStatus(message, kind) {
  const el = $('status');
  el.textContent = message;
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.classList.toggle('hidden', !message);
}

function renderAttachments() {
  const list = $('attachments');
  list.innerHTML = '';
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    if (a.previewUrl) {
      const img = document.createElement('img');
      img.src = a.previewUrl;
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
      attachments.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(rm);
    list.appendChild(chip);
  });
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      attachments.push({
        name: file.name,
        type: file.type,
        dataUrl,
        previewUrl: file.type.startsWith('image/') ? dataUrl : null,
      });
    } catch (e) {
      /* skip unreadable file */
    }
  }
  $('files').value = '';
  renderAttachments();
}

function collectPayload(email) {
  const payload = {
    description: $('description').value.trim(),
    steps: $('steps').value.trim(),
    expected: $('expected').value.trim(),
    observed: $('observed').value.trim(),
    email: email || '',
    env: context.env || {},
    logs: context.logs || [],
    lastError: context.lastError || null,
    attachments: [],
  };
  if (screenshotDataUrl && $('shot-include').checked) {
    payload.attachments.push({ name: 'screenshot.png', type: 'image/png', dataUrl: screenshotDataUrl });
  }
  attachments.forEach((a) => payload.attachments.push({ name: a.name, type: a.type, dataUrl: a.dataUrl }));
  return payload;
}

function getUserEmail() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'getUser' }, (res) => {
        void chrome.runtime.lastError;
        resolve((res && res.user && res.user.email) || '');
      });
    } catch (e) {
      resolve('');
    }
  });
}

async function submit() {
  const btn = $('submit-btn');
  const payload = collectPayload(await getUserEmail());
  if (!payload.description) {
    setStatus('Please describe what went wrong.', 'error');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  setStatus('');

  chrome.runtime.sendMessage({ action: 'submitBugReport', payload }, (res) => {
    void chrome.runtime.lastError;
    if (res && res.success) {
      setStatus('Thanks — your report was filed.' + (res.url ? '' : ''), 'ok');
      btn.textContent = 'Submitted';
      if (res.url) {
        const link = document.createElement('a');
        link.href = res.url;
        link.target = '_blank';
        link.textContent = ' View issue';
        $('status').appendChild(link);
      }
      setTimeout(() => window.close(), 2500);
    } else {
      btn.disabled = false;
      btn.textContent = 'Submit';
      setStatus(
        (res && res.error ? res.error + ' — ' : '') +
          'Could not submit. Check your connection and try again.',
        'error',
      );
    }
  });
}

async function init() {
  try {
    const stored = await chrome.storage.local.get('stash_pending_bug');
    if (stored && stored.stash_pending_bug) context = stored.stash_pending_bug;
  } catch (e) {
    /* nothing stashed — the form still works, just without a screenshot/logs */
  }

  if (context.screenshot) {
    screenshotDataUrl = context.screenshot;
    $('shot-img').src = screenshotDataUrl;
    $('shot-wrap').classList.remove('hidden');
  }
  if (context.lastError && context.lastError.message) {
    $('observed').value = 'Error: ' + context.lastError.message;
    $('detail').open = true;
  }

  $('files').addEventListener('change', (e) => addFiles(e.target.files));
  $('submit-btn').addEventListener('click', submit);
  $('cancel-btn').addEventListener('click', () => window.close());
  $('description').focus();
}

init();
