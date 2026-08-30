// Stash Bookmarklet - Save Page
// Minified version will be used as the actual bookmarklet
//
// The bookmarklet runs on an arbitrary page, where there is no Supabase
// session to sign the request with — and save-page now rejects anything
// without an Authorization header. So instead of saving directly, it hands
// the URL (and any selected text) to the Stash web app's quick-save page,
// which is already signed in and does the authenticated save.

(function() {
  const CONFIG = {
    // Replace with your deployed web app URL
    WEB_APP_URL: 'https://YOUR_STASH_APP.vercel.app',
  };

  // Get selected text (if any) to save as a highlight
  const selection = window.getSelection().toString().trim();

  const params = new URLSearchParams({ url: window.location.href });

  const title = document.querySelector('h1')?.innerText?.trim() || document.title;
  if (title) params.set('title', title);
  if (selection) params.set('text', selection);

  const saveUrl = `${CONFIG.WEB_APP_URL}/save.html?${params.toString()}`;

  // A small popup rather than a new tab: the save page closes itself when
  // it's done, so the page you were reading stays put.
  const popup = window.open(saveUrl, 'stash-save', 'width=420,height=560');

  // Popup blocked (some sites, and most mobile browsers) - fall back to
  // navigating a new tab.
  if (!popup) {
    window.open(saveUrl, '_blank');
  }
})();
