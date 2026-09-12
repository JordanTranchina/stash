// Popup script
document.addEventListener('DOMContentLoaded', async () => {
  const authView = document.getElementById('auth-view');
  const mainView = document.getElementById('main-view');
  const authForm = document.getElementById('auth-form');
  const authError = document.getElementById('auth-error');
  const signinBtn = document.getElementById('signin-btn');
  const signupBtn = document.getElementById('signup-btn');
  const googleSigninBtn = document.getElementById('google-signin-btn');
  const signoutBtn = document.getElementById('signout-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const savesList = document.getElementById('saves-list');
  const openAppLink = document.getElementById('open-app-link');
  const saveBtn = document.getElementById('save-btn');
  const saveStatus = document.getElementById('save-status');

  const session = await chrome.runtime.sendMessage({ action: 'getUser' });
  if (session && session.user) {
    showMainView();
    loadRecentSaves();
  } else {
    showAuthView();
  }

  function showAuthView() {
    authView.classList.remove('hidden');
    mainView.classList.add('hidden');
  }

  function showMainView() {
    authView.classList.add('hidden');
    mainView.classList.remove('hidden');
  }

  // Sign in
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    signinBtn.disabled = true;
    signinBtn.textContent = 'Signing in...';
    authError.textContent = '';

    const response = await chrome.runtime.sendMessage({
      action: 'signIn',
      email,
      password,
    });

    if (response.success) {
      // The background worker has already dropped the popup from the action,
      // so get out of the way: the next icon click is the save.
      window.close();
      return;
    }

    authError.textContent = response.error;
    signinBtn.disabled = false;
    signinBtn.textContent = 'Sign In';
  });

  // Sign in with Google
  googleSigninBtn.addEventListener('click', async () => {
    googleSigninBtn.disabled = true;
    authError.textContent = '';
    const originalContent = googleSigninBtn.innerHTML;
    googleSigninBtn.textContent = 'Signing in...';

    try {
      const response = await chrome.runtime.sendMessage({ action: 'signInWithGoogle' });

      if (response && response.success) {
        // Same handoff as the password sign-in: get out of the way so the next
        // toolbar click saves instead of reopening this popup.
        window.close();
        return;
      }

      authError.textContent = response?.error || 'Google sign-in failed';
    } catch (err) {
      authError.textContent = err.message || 'Google sign-in failed';
    } finally {
      googleSigninBtn.innerHTML = originalContent;
      googleSigninBtn.disabled = false;
    }
  });

  // Sign up
  signupBtn.addEventListener('click', async () => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    if (!email || !password) {
      authError.textContent = 'Please enter email and password';
      return;
    }

    signupBtn.disabled = true;
    signupBtn.textContent = 'Signing up...';
    authError.textContent = '';

    // Password sign-up happens in the web app: it's invite-only (the address
    // has to be in allowed_emails), and there's no room in this popup for a
    // full sign-up form. Google sign-in above doesn't need this — it goes
    // through the same invite check as part of the OAuth flow.
    chrome.tabs.create({ url: CONFIG.WEB_APP_URL });

    signupBtn.disabled = false;
    signupBtn.textContent = 'Sign Up';
  });

  // Save the active tab. The background worker does the extraction/insert and
  // shows its own toast on the page; this button just triggers it and reports
  // failures the popup is actually open to see (a closed popup would miss them).
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    saveStatus.textContent = '';
    saveStatus.classList.add('hidden');

    const response = await chrome.runtime.sendMessage({ action: 'savePage' });

    if (response && response.success) {
      saveBtn.textContent = response.duplicate ? 'Already saved' : 'Saved!';
      loadRecentSaves();
      setTimeout(() => window.close(), 700);
      return;
    }

    if (response && response.needsAuth) {
      showAuthView();
      return;
    }

    saveStatus.textContent = (response && response.error) || 'Failed to save';
    saveStatus.classList.remove('hidden');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Article';
  });

  // Sign out
  signoutBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'signOut' });
    showAuthView();
  });

  // Load recent saves
  async function loadRecentSaves() {
    const response = await chrome.runtime.sendMessage({ action: 'getRecentSaves' });

    if (response.needsAuth) {
      showAuthView();
      return;
    }

    if (!response.success || !response.saves?.length) {
      savesList.innerHTML = '<p class="empty">No saves yet. Click the Stash icon to save a page!</p>';
      return;
    }

    savesList.innerHTML = response.saves.map(save => {
      const isHighlight = !!save.highlight;
      const title = save.title || save.highlight?.substring(0, 50) || 'Untitled';
      const date = new Date(save.created_at).toLocaleDateString();

      return `
        <div class="save-item" data-url="${save.url}">
          <div class="icon ${isHighlight ? 'highlight' : ''}">
            ${isHighlight ? '✨' : '📄'}
          </div>
          <div class="content">
            <div class="title">${escapeHtml(title)}</div>
            <div class="meta">${save.site_name || ''} · ${date}</div>
          </div>
        </div>
      `;
    }).join('');

    // Add click handlers
    savesList.querySelectorAll('.save-item').forEach(item => {
      item.addEventListener('click', () => {
        const url = item.dataset.url;
        if (url) chrome.tabs.create({ url });
      });
    });
  }

  // Open web app
  openAppLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: CONFIG.WEB_APP_URL });
  });

  // Settings — the web app owns every setting (theme, default font size,
  // podcast hosts, import, sign-out), so the cog deep-links straight to its
  // Settings view via the #settings hash.
  settingsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: `${CONFIG.WEB_APP_URL}/#settings` });
  });

  // Helper
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

});
