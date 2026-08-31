// Background service worker (Chrome) / event page (Firefox)
// Handles context menus and saving

// Chrome MV3 runs this as a service worker, where config.js/supabase.js must
// be pulled in via importScripts. Firefox's MV3 background is a regular
// (non-worker) page that loads background.scripts as separate <script> tags
// sharing one global scope, so config.js/supabase.js are already defined by
// the time this file runs and importScripts doesn't exist.
if (typeof importScripts === 'function') {
  importScripts('logbuffer.js', 'config.js', 'supabase.js', 'sentry-lite.js', 'analytics.js');
}

if (typeof SentryLite !== 'undefined') {
  SentryLite.init(CONFIG.SENTRY_DSN);
  self.addEventListener('error', (e) => SentryLite.captureException(e.error || e.message));
  self.addEventListener('unhandledrejection', (e) => SentryLite.captureException(e.reason));
}

if (typeof StashAnalytics !== 'undefined') {
  StashAnalytics.init(CONFIG.POSTHOG_API_KEY, CONFIG.POSTHOG_HOST, CONFIG.USER_ID);
}

let supabase = null;

// Shown whenever there is no usable session. The popup's sign-in form is the
// way out of this state.
const SIGN_IN_MESSAGE = 'Sign in to Stash to save';

// Shown when the page can't be read client-side: chrome:// / about: pages, the
// Web Store, the PDF viewer, or a tab where the content script can't be reached
// (no scripting API on this browser, injection blocked). Expected, not a bug —
// like SIGN_IN_MESSAGE it's kept out of Sentry.
const UNREADABLE_PAGE_MESSAGE = "Can't save this page — open the article in a tab and try again";

// Clicking the toolbar icon saves immediately, so the badge is the only
// feedback the user is guaranteed to see. Keep the text to 1-2 characters,
// which is all that fits.
const BADGE_CLEAR_MS = 2000;

// Initialize on startup
chrome.runtime.onInstalled.addListener(async () => {
  await initSupabase();
  setupContextMenu();
  await updateActionForSession();
});

chrome.runtime.onStartup.addListener(async () => {
  await initSupabase();
  await updateActionForSession();
});

// MV3 tears the service worker down when idle and revives it on the next
// event (including the toolbar click itself). onInstalled/onStartup don't fire
// on a bare wake, so reconcile the toolbar action here too: if the stored
// session has gone away since the last check, this flips the icon back to
// opening the sign-in popup instead of firing an unauthenticated save.
updateActionForSession().catch(() => {});

async function initSupabase() {
  supabase = new SupabaseClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  // Load whatever session the popup's sign-in stored. Every save runs as the
  // signed-in user; there is no anon-key fallback.
  await supabase.init();
  return supabase;
}

async function getClient() {
  if (!supabase) await initSupabase();
  return supabase;
}

// Resolves to the signed-in user's id, refreshing an expired token first.
// Throws with SIGN_IN_MESSAGE when there is no session to work with, so
// callers surface a clear state instead of a silent failure.
async function requireUserId() {
  const client = await getClient();
  const token = await client.getAccessToken();
  if (!token || !client.userId) {
    throw new Error(SIGN_IN_MESSAGE);
  }
  return client.userId;
}

// The popup is now only the sign-in form. With a session we clear it so a
// toolbar click fires onClicked and saves in one action; without one we put it
// back so the click opens the sign-in form instead of failing.
async function updateActionForSession() {
  const client = await getClient();
  const token = await client.getAccessToken();
  const signedIn = Boolean(token && client.userId);
  await chrome.action.setPopup({ popup: signedIn ? '' : 'popup.html' });
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadgeSoon() {
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), BADGE_CLEAR_MS);
}

// The content script can't run on chrome:// pages, the Web Store, or the PDF
// viewer, so this call fails there. Use the callback form and read
// runtime.lastError so the rejection can't escape and mask the save result.
function showToast(tabId, message, isError, withReport) {
  chrome.tabs.sendMessage(
    tabId,
    { action: 'showToast', message, isError, withReport: !!withReport },
    () => { void chrome.runtime.lastError; },
  );
}

// One-click save from the toolbar icon
chrome.action.onClicked.addListener(async (tab) => {
  const result = await savePage(tab);
  // The session can expire between the last check and this click; put the
  // sign-in popup back so the next click has somewhere to go.
  if (result && result.needsAuth) {
    await updateActionForSession();
  }
});

// Context menu for "Save highlight to Stash"
function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-highlight',
      title: 'Save highlight to Stash',
      contexts: ['selection'],
    });

    chrome.contextMenus.create({
      id: 'save-page',
      title: 'Save page to Stash',
      contexts: ['page'],
    });

    // Right-clicking the toolbar icon is the only route to these now that a
    // left click saves instead of opening the popup.
    chrome.contextMenus.create({
      id: 'open-stash',
      title: 'Open Stash',
      contexts: ['action'],
    });

    chrome.contextMenus.create({
      id: 'sign-out',
      title: 'Sign out',
      contexts: ['action'],
    });

    chrome.contextMenus.create({
      id: 'report-bug',
      title: 'Report a bug to Stash',
      contexts: ['action', 'page'],
    });
  });
}

// ... context menu setup ...

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await getClient();

  if (info.menuItemId === 'save-highlight') {
    await saveHighlight(tab, info.selectionText);
  } else if (info.menuItemId === 'save-page') {
    await savePage(tab);
  } else if (info.menuItemId === 'open-stash') {
    chrome.tabs.create({ url: CONFIG.WEB_APP_URL });
  } else if (info.menuItemId === 'sign-out') {
    await supabase.signOut();
    await updateActionForSession();
  } else if (info.menuItemId === 'report-bug') {
    await startBugReport(tab);
  }
});

// Gather everything a bug report needs (a screenshot of the current tab, the
// recent log buffer, the environment) into chrome.storage.local, then open the
// report page. The page reads `stash_pending_bug` on load and prefills.
async function startBugReport(tab) {
  let screenshot = null;
  try {
    const windowId = tab && tab.windowId;
    screenshot = await chrome.tabs.captureVisibleTab(
      windowId != null ? windowId : chrome.windows.WINDOW_ID_CURRENT,
      { format: 'png' },
    );
  } catch (e) {
    // chrome:// pages, the Web Store, PDF viewer, or no <all_urls> grant.
    console.warn('Bug report screenshot unavailable:', e && e.message);
  }

  let snap = { logs: [], lastError: null };
  try {
    if (typeof StashLog !== 'undefined') snap = await StashLog.snapshot();
  } catch (e) { /* keep the empty snapshot */ }

  const context = {
    screenshot,
    logs: snap.logs,
    lastError: snap.lastError,
    env: {
      version: { build: 'extension', commit: chrome.runtime.getManifest().version },
      url: (tab && tab.url) || '',
      pageTitle: (tab && tab.title) || '',
      userAgent: navigator.userAgent,
      view: 'extension',
      online: navigator.onLine,
      language: navigator.language,
    },
    createdAt: new Date().toISOString(),
  };

  await chrome.storage.local.set({ stash_pending_bug: context });
  await chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
}

// Rebuild a Blob from a `data:` URL (report.js sends attachments this way so
// they survive runtime messaging).
function dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function submitBugReport(payload) {
  const client = await getClient();
  const fd = new FormData();
  fd.append('description', payload.description || '');
  fd.append('steps', payload.steps || '');
  fd.append('expected', payload.expected || '');
  fd.append('observed', payload.observed || '');
  fd.append('source', 'extension');
  fd.append('email', payload.email || '');
  fd.append('env', JSON.stringify(payload.env || {}));
  fd.append('logs', JSON.stringify(payload.logs || []));
  fd.append('lastError', JSON.stringify(payload.lastError || null));
  for (const att of payload.attachments || []) {
    try {
      fd.append('attachments', dataUrlToBlob(att.dataUrl), att.name || 'attachment');
    } catch (e) { /* skip an unreadable attachment rather than fail the report */ }
  }

  const result = await client.callFunction('report-bug', fd);
  if (typeof StashAnalytics !== 'undefined') {
    StashAnalytics.capture('bug_report_submitted', { source: 'extension', queued: false });
  }
  await chrome.storage.local.remove('stash_pending_bug');
  return result;
}

// Save highlighted text
async function saveHighlight(tab, selectionText) {
  try {
    const userId = await requireUserId();

    const result = await supabase.insert('saves', {
      user_id: userId,
      url: tab.url,
      title: tab.title,
      highlight: selectionText,
      site_name: new URL(tab.url).hostname.replace('www.', ''),
      source: 'extension',
    });

    showToast(tab.id, 'Highlight saved!');
    if (typeof StashAnalytics !== 'undefined') {
      // save_id lets the save→open→read funnel join on a per-article key
      // (article_opened / article_read_progress both carry it). insert()
      // returns the representation array, so the row id is result[0].id.
      StashAnalytics.capture('save_created', {
        source: 'extension',
        type: 'highlight',
        save_id: Array.isArray(result) ? result[0]?.id : result?.id,
      });
    }
    return { success: true };
  } catch (err) {
    console.error('Save highlight failed:', err);
    const needsAuth = err.message === SIGN_IN_MESSAGE;
    // Being signed out is an expected state, not a bug; only real failures are
    // worth a Sentry event.
    if (!needsAuth && typeof SentryLite !== 'undefined') {
      SentryLite.captureException(err, { tags: { action: 'saveHighlight' } });
    }
    showToast(tab.id, needsAuth ? SIGN_IN_MESSAGE : 'Failed to save: ' + err.message, true, !needsAuth);
    // The session went away — restore the sign-in popup so the next toolbar
    // click has somewhere to go instead of erroring again.
    if (needsAuth) await updateActionForSession();
    return { success: false, error: err.message, needsAuth };
  }
}

// Save full page
async function savePage(tab) {
  await getClient();
  setBadge('\u2026', '#6b7280');
  try {
    console.log('savePage called for:', tab.url);

    // Fail before extraction if we can't attribute the save to anyone.
    const userId = await requireUserId();

    // ... extraction logic ...
    // (We keep the existing extraction logic, just ensuring error handling bubbles up)

    let article;
    // Extract from current page - inject content script first if needed
    console.log('Extracting article...');

    try {
      article = await chrome.tabs.sendMessage(tab.id, { action: 'extractArticle' });
    } catch (e) {
      // Content script not loaded, inject it first. This whole path fails on
      // pages that can't run a content script (chrome://, Web Store, PDF
      // viewer) or on a browser with no scripting API — surface that as an
      // expected "can't read this page" rather than a crash.
      console.log('Content script not loaded, injecting...');
      if (!chrome.scripting?.executeScript) {
        throw new Error(UNREADABLE_PAGE_MESSAGE);
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['Readability.js', 'content.js']
        });
        // Wait a moment for script to initialize
        await new Promise(r => setTimeout(r, 100));
        article = await chrome.tabs.sendMessage(tab.id, { action: 'extractArticle' });
      } catch (injectErr) {
        console.log('Could not read page:', injectErr);
        throw new Error(UNREADABLE_PAGE_MESSAGE);
      }
    }

    if (!article) {
      throw new Error('Failed to extract article content');
    }

    console.log('Inserting into Supabase...', { user_id: userId });

    const result = await supabase.insert('saves', {
      user_id: userId,
      url: tab.url,
      title: article.title,
      content: article.content,
      excerpt: article.excerpt,
      site_name: article.siteName,
      author: article.author,
      published_at: article.publishedTime,
      image_url: article.imageUrl,
      source: 'extension',
    });
    console.log('Insert result:', result);

    // A duplicate save returns no row: the database's dedup trigger
    // (supabase/migrations/20260824_saves_url_dedup.sql) recognised the URL as
    // one that's already stashed and bumped that save's date instead of
    // inserting a second copy. Report it as a save either way — the article is
    // in the library and back at the top of the list.
    const isDuplicate = Array.isArray(result) && result.length === 0;

    showToast(tab.id, isDuplicate ? 'Already saved — moved to top' : 'Page saved!');
    setBadge('\u2713', '#16a34a');
    clearBadgeSoon();
    if (typeof StashAnalytics !== 'undefined') {
      // save_id is absent on a duplicate (no row inserted) — that's fine, the
      // funnel only needs it for saves that actually created an article.
      StashAnalytics.capture('save_created', {
        source: 'extension',
        type: 'page',
        duplicate: isDuplicate,
        save_id: Array.isArray(result) ? result[0]?.id : undefined,
      });
    }

    return { success: true, duplicate: isDuplicate };
  } catch (err) {
    console.error('Save page failed:', err);
    const needsAuth = err.message === SIGN_IN_MESSAGE;
    // Signed-out and can't-read-this-page are both expected states, not bugs;
    // only real failures are worth a Sentry event.
    const expected = needsAuth || err.message === UNREADABLE_PAGE_MESSAGE;
    if (!expected && typeof SentryLite !== 'undefined') {
      SentryLite.captureException(err, { tags: { action: 'savePage' } });
    }
    showToast(tab.id, expected ? err.message : 'Failed to save: ' + err.message, true, !expected);
    setBadge('!', '#dc2626');
    clearBadgeSoon();
    // The session went away — restore the sign-in popup so the next toolbar
    // click opens the form instead of firing another failing save.
    if (needsAuth) await updateActionForSession();
    return { success: false, error: err.message, needsAuth };
  }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'savePage') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        const result = await savePage(tabs[0]);
        sendResponse(result);
      } else {
        sendResponse({ success: false, error: 'No active tab' });
      }
    });
    return true;
  }

  if (request.action === 'getUser') {
    (async () => {
      const client = await getClient();
      const user = await client.getUser();
      sendResponse({ user });
    })();
    return true;
  }

  if (request.action === 'signIn') {
    (async () => {
      const client = await getClient();
      try {
        await client.signIn(request.email, request.password);
        const user = await client.getUser();
        await updateActionForSession();
        sendResponse({ success: true, user });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'signOut') {
    (async () => {
      const client = await getClient();
      await client.signOut();
      await updateActionForSession();
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === 'reportBug') {
    (async () => {
      let tab = sender && sender.tab;
      if (!tab) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = tabs[0];
      }
      await startBugReport(tab);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (request.action === 'submitBugReport') {
    (async () => {
      try {
        const result = await submitBugReport(request.payload || {});
        sendResponse({ success: true, url: result && result.url });
      } catch (err) {
        console.error('Bug report submit failed:', err);
        if (typeof SentryLite !== 'undefined') {
          SentryLite.captureException(err, { tags: { action: 'submitBugReport' } });
        }
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'getRecentSaves') {
    (async () => {
      const client = await getClient();
      try {
        await requireUserId();
        const saves = await client.select('saves', {
          order: 'created_at.desc',
          limit: 10,
        });
        sendResponse({ success: true, saves });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message,
          needsAuth: err.message === SIGN_IN_MESSAGE,
        });
      }
    })();
    return true;
  }
});
