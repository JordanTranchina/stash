// Background service worker
// Handles context menus and saving

importScripts('config.js', 'supabase.js');

let supabase = null;

// Initialize on startup
chrome.runtime.onInstalled.addListener(() => {
  initSupabase();
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  initSupabase();
});

async function initSupabase() {
  supabase = new SupabaseClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  // In Single User Mode, we must ensure we are NOT using a stale session from a different user
  // We rely on the 'Allow specific user saves' RLS policy utilizing the Anon Key
  if (CONFIG.USER_ID) {
    await supabase.signOut();
  } else {
    await supabase.init();
  }
}

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
  });
}

// ... context menu setup ...

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!supabase) await initSupabase();

  if (info.menuItemId === 'save-highlight') {
    await saveHighlight(tab, info.selectionText);
  } else if (info.menuItemId === 'save-page') {
    await savePage(tab);
  }
});

// Save highlighted text
async function saveHighlight(tab, selectionText) {
  try {
    const result = await supabase.insert('saves', {
      user_id: CONFIG.USER_ID,
      url: tab.url,
      title: tab.title,
      highlight: selectionText,
      site_name: new URL(tab.url).hostname.replace('www.', ''),
      source: 'extension',
    });

    chrome.tabs.sendMessage(tab.id, {
      action: 'showToast',
      message: 'Highlight saved!',
    });
    return { success: true };
  } catch (err) {
    console.error('Save highlight failed:', err);
    chrome.tabs.sendMessage(tab.id, {
      action: 'showToast',
      message: 'Failed to save: ' + err.message,
      isError: true,
    });
    return { success: false, error: err.message };
  }
}

// Save full page
async function savePage(tab) {
  if (!supabase) await initSupabase();
  try {
    console.log('savePage called for:', tab.url);
    
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

    console.log('Inserting into Supabase...', { user_id: CONFIG.USER_ID });
    
    const result = await supabase.insert('saves', {
      user_id: CONFIG.USER_ID,
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

    chrome.tabs.sendMessage(tab.id, {
      action: 'showToast',
      message: 'Page saved!',
    });
    
    return { success: true };
  } catch (err) {
    console.error('Save page failed:', err);
    chrome.tabs.sendMessage(tab.id, {
      action: 'showToast',
      message: 'Failed to save: ' + err.message,
      isError: true,
    });
    return { success: false, error: err.message };
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
      if (!supabase) await initSupabase();
      const user = await supabase.getUser();
      sendResponse({ user });
    })();
    return true;
  }

  if (request.action === 'signIn') {
    (async () => {
      if (!supabase) await initSupabase();
      try {
        await supabase.signIn(request.email, request.password);
        const user = await supabase.getUser();
        sendResponse({ success: true, user });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'signOut') {
    (async () => {
      if (!supabase) await initSupabase();
      await supabase.signOut();
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === 'getRecentSaves') {
    (async () => {
      if (!supabase) await initSupabase();
      try {
        const saves = await supabase.select('saves', {
          order: 'created_at.desc',
          limit: 10,
        });
        sendResponse({ success: true, saves });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
