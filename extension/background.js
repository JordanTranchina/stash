// Background service worker (Chrome) / event page (Firefox)
// Handles context menus and saving

// Chrome MV3 runs this as a service worker, where config.js/supabase.js must
// be pulled in via importScripts. Firefox's MV3 background is a regular
// (non-worker) page that loads background.scripts as separate <script> tags
// sharing one global scope, so config.js/supabase.js are already defined by
// the time this file runs and importScripts doesn't exist.
if (typeof importScripts === 'function') {
  importScripts('config.js', 'supabase.js', 'sentry-lite.js', 'analytics.js');
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
function showToast(tabId, message, isError) {
  chrome.tabs.sendMessage(tabId, { action: 'showToast', message, isError }, () => {
    void chrome.runtime.lastError;
  });
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
  }
});

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
    showToast(tab.id, needsAuth ? SIGN_IN_MESSAGE : 'Failed to save: ' + err.message, true);
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
      // Content script not loaded, inject it first
      console.log('Content script not loaded, injecting...');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['Readability.js', 'content.js']
      });
      // Wait a moment for script to initialize
      await new Promise(r => setTimeout(r, 100));
      article = await chrome.tabs.sendMessage(tab.id, { action: 'extractArticle' });
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
    if (!needsAuth && typeof SentryLite !== 'undefined') {
      SentryLite.captureException(err, { tags: { action: 'savePage' } });
    }
    showToast(tab.id, needsAuth ? SIGN_IN_MESSAGE : 'Failed to save: ' + err.message, true);
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
