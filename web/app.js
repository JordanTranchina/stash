// Stash Web App (Single-user mode - no auth required)
class StashApp {
  constructor() {
    this.supabase = null;
    this.user = { id: CONFIG.USER_ID }; // Hardcoded single user
    this.currentView = 'all';
    this.currentSave = null;
    this.saves = [];

    // Audio player state
    this.audio = null;
    this.isPlaying = false;

    // Reading pane scroll-chrome state
    this.lastReadingScrollTop = 0;

    // Font size bounds (px) for article reading text
    this.FONT_SIZE_MIN = 14;
    this.FONT_SIZE_MAX = 24;
    this.FONT_SIZE_STEP = 1;
    this.FONT_SIZE_DEFAULT = 16;

    this.init();
  }

  async init() {
    // Initialize Supabase
    this.supabase = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );

    // Load theme preference
    this.loadTheme();

    // Load default font size preference
    this.loadFontSize();

    // Skip auth - go straight to main screen
    this.showMainScreen();
    this.loadData();
    this.syncPendingShares();

    this.bindEvents();
    this.setupRealtime();
  }

  // Theme Management
  loadTheme() {
    const savedTheme = localStorage.getItem('stash-theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    this.updateThemeToggle(savedTheme);
    this.updateThemeColorMeta(savedTheme);
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('stash-theme', newTheme);
    this.updateThemeToggle(newTheme);
    this.updateThemeColorMeta(newTheme);
  }

  updateThemeColorMeta(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#111827' : '#ffffff');
  }

  // Font Size Management (applies to article reading text app-wide)
  // 'stash-font-size-default' is the app-wide default set from Settings.
  // 'stash-font-size' is the currently active reading size, which can be
  // bumped up/down from the reading pane without changing the default.
  loadFontSize() {
    // Migrate from the old single-value scheme (pre-reset-button), where
    // 'stash-font-size' doubled as both the default and the current size.
    if (localStorage.getItem('stash-font-size-default') === null) {
      const legacy = parseInt(localStorage.getItem('stash-font-size'), 10);
      localStorage.setItem('stash-font-size-default', Number.isFinite(legacy) ? legacy : this.FONT_SIZE_DEFAULT);
    }

    const defaultSize = this.getDefaultFontSize();
    const valueEl = document.getElementById('settings-font-size-value');
    if (valueEl) valueEl.textContent = `${defaultSize}px`;

    this.applyCurrentFontSize(this.getCurrentFontSize());
  }

  clampFontSize(size) {
    return Math.min(this.FONT_SIZE_MAX, Math.max(this.FONT_SIZE_MIN, size));
  }

  getDefaultFontSize() {
    const saved = parseInt(localStorage.getItem('stash-font-size-default'), 10);
    return this.clampFontSize(Number.isFinite(saved) ? saved : this.FONT_SIZE_DEFAULT);
  }

  getCurrentFontSize() {
    const saved = parseInt(localStorage.getItem('stash-font-size'), 10);
    return this.clampFontSize(Number.isFinite(saved) ? saved : this.getDefaultFontSize());
  }

  // Applies the currently active reading size (footer +/- and reset act on this)
  applyCurrentFontSize(size) {
    const clamped = this.clampFontSize(size);
    document.documentElement.style.setProperty('--reading-font-size', `${clamped}px`);
    localStorage.setItem('stash-font-size', clamped);

    const resetBtn = document.getElementById('reading-font-reset-btn');
    if (resetBtn) resetBtn.disabled = clamped === this.getDefaultFontSize();
  }

  adjustFontSize(delta) {
    this.applyCurrentFontSize(this.getCurrentFontSize() + delta);
  }

  resetFontSize() {
    this.applyCurrentFontSize(this.getDefaultFontSize());
  }

  // Sets the app-wide default (Settings stepper); also applies immediately
  // as the current reading size so Settings changes take effect right away.
  setDefaultFontSize(size) {
    const clamped = this.clampFontSize(size);
    localStorage.setItem('stash-font-size-default', clamped);

    const valueEl = document.getElementById('settings-font-size-value');
    if (valueEl) valueEl.textContent = `${clamped}px`;

    this.applyCurrentFontSize(clamped);
  }

  adjustDefaultFontSize(delta) {
    this.setDefaultFontSize(this.getDefaultFontSize() + delta);
  }

  updateThemeToggle(theme) {
    const sunIcon = document.querySelector('.sun-icon');
    const moonIcon = document.querySelector('.moon-icon');
    const label = document.querySelector('.theme-label');

    if (theme === 'dark') {
      sunIcon?.classList.add('hidden');
      moonIcon?.classList.remove('hidden');
      if (label) label.textContent = 'Light Mode';
    } else {
      sunIcon?.classList.remove('hidden');
      moonIcon?.classList.add('hidden');
      if (label) label.textContent = 'Dark Mode';
    }
  }

  bindEvents() {
    // Auth form
    document.getElementById('auth-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.signIn();
    });

    document.getElementById('signup-btn').addEventListener('click', () => {
      this.signUp();
    });

    document.getElementById('signout-btn').addEventListener('click', () => {
      this.signOut();
    });

    // Bottom tab bar navigation
    document.querySelectorAll('.bottom-nav-item[data-view]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = item.dataset.view;
        this.setView(view);
      });
    });

    // Stats (opened from within Settings)
    document.getElementById('view-stats-btn').addEventListener('click', () => {
      this.showStats();
    });

    // Search
    let searchTimeout;
    document.getElementById('search-input').addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.search(e.target.value);
      }, 300);
    });

    // Sort
    document.getElementById('sort-select').addEventListener('change', (e) => {
      this.loadSaves();
    });

    // Reading pane
    document.getElementById('close-reading-btn').addEventListener('click', () => {
      this.closeReadingPane();
    });

    // Android back gesture / browser back button: close the reading pane
    // instead of letting it fall through and exit the app.
    window.addEventListener('popstate', () => {
      const pane = document.getElementById('reading-pane');
      if (pane && pane.classList.contains('open')) {
        this.closeReadingPane({ fromPopState: true });
      }
    });

    document.getElementById('archive-btn').addEventListener('click', () => {
      this.toggleArchive();
    });

    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', () => {
      this.toggleTheme();
    });

    // Font size controls (reading pane footer + Settings default)
    document.getElementById('reading-font-decrease-btn').addEventListener('click', () => {
      this.adjustFontSize(-this.FONT_SIZE_STEP);
    });
    document.getElementById('reading-font-increase-btn').addEventListener('click', () => {
      this.adjustFontSize(this.FONT_SIZE_STEP);
    });
    document.getElementById('reading-font-reset-btn').addEventListener('click', () => {
      this.resetFontSize();
    });
    document.getElementById('settings-font-decrease-btn').addEventListener('click', () => {
      this.adjustDefaultFontSize(-this.FONT_SIZE_STEP);
    });
    document.getElementById('settings-font-increase-btn').addEventListener('click', () => {
      this.adjustDefaultFontSize(this.FONT_SIZE_STEP);
    });

    // Reading progress bar + hide reader chrome while scrolling down
    const readingContent = document.getElementById('reading-content');
    if (readingContent) {
      readingContent.addEventListener('scroll', () => {
        this.updateReadingProgress();
        this.updateReadingChromeVisibility();
      });
    }

    // Audio player controls
    document.getElementById('audio-play-btn').addEventListener('click', () => {
      this.toggleAudioPlayback();
    });

    document.getElementById('audio-speed').addEventListener('change', (e) => {
      if (this.audio) {
        this.audio.playbackRate = parseFloat(e.target.value);
      }
    });

    document.getElementById('audio-progress-bar').addEventListener('click', (e) => {
      if (this.audio && this.audio.duration) {
        const rect = e.target.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        this.audio.currentTime = percent * this.audio.duration;
      }
    });

    // Podcast Settings Modal (host personalities)
    const podcastModal = document.getElementById('podcast-modal');

    document.getElementById('podcast-settings-btn').addEventListener('click', () => {
      this.showPodcastModal();
    });
    podcastModal.querySelector('.modal-overlay').addEventListener('click', () => {
      this.hidePodcastModal();
    });
    podcastModal.querySelector('.modal-close-btn').addEventListener('click', () => {
      this.hidePodcastModal();
    });
    document.getElementById('podcast-cancel-btn').addEventListener('click', () => {
      this.hidePodcastModal();
    });
    document.getElementById('podcast-save-btn').addEventListener('click', () => {
      this.savePodcastPreferences();
    });

    // Add URL Modal (manually ingest a single link)
    const addUrlModal = document.getElementById('add-url-modal');

    document.getElementById('header-add-btn').addEventListener('click', () => {
      this.showAddUrlModal();
    });
    addUrlModal.querySelector('.modal-overlay').addEventListener('click', () => {
      this.hideAddUrlModal();
    });
    addUrlModal.querySelector('.modal-close-btn').addEventListener('click', () => {
      this.hideAddUrlModal();
    });
    document.getElementById('add-url-cancel-btn').addEventListener('click', () => {
      this.hideAddUrlModal();
    });
    document.getElementById('add-url-save-btn').addEventListener('click', () => {
      this.saveUrlManually();
    });

    // Import Articles Modal (CSV from other read-it-later services)
    const importModal = document.getElementById('import-modal');

    document.getElementById('import-settings-btn').addEventListener('click', () => {
      this.showImportModal();
    });
    importModal.querySelector('.modal-overlay').addEventListener('click', () => {
      this.hideImportModal();
    });
    importModal.querySelector('.modal-close-btn').addEventListener('click', () => {
      this.hideImportModal();
    });
    document.getElementById('import-cancel-btn').addEventListener('click', () => {
      this.handleImportCancel();
    });
    document.getElementById('import-file').addEventListener('change', (e) => {
      this.handleImportFile(e.target.files[0]);
    });
    document.getElementById('import-start-btn').addEventListener('click', () => {
      this.runImport();
    });

    // PWA: Online/Offline Status
    window.addEventListener('online', () => this.updateOnlineStatus());
    window.addEventListener('offline', () => this.updateOnlineStatus());
    
    // PWA: Install Prompt
    const installBtn = document.getElementById('install-app-settings-btn');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      installBtn.classList.remove('hidden');
    });

    installBtn.addEventListener('click', () => {
      if (!this.deferredPrompt) return;
      this.deferredPrompt.prompt();
      this.deferredPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
          console.log('User accepted the install prompt');
        }
        this.deferredPrompt = null;
      });
    });

    window.addEventListener('appinstalled', () => {
      installBtn.classList.add('hidden');
      this.deferredPrompt = null;
    });
  }

  setupRealtime() {
    this.supabase
      .channel('public:saves')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'saves' }, (payload) => {
        const updatedSave = payload.new;
        
        // Update local data
        const index = this.saves.findIndex(s => s.id === updatedSave.id);
        if (index !== -1) {
          this.saves[index] = updatedSave;
          
          // If this save is currently open in reading pane, refresh it
          if (this.currentSave && this.currentSave.id === updatedSave.id) {
            // Only refresh if audio_url changed (avoid unnecessary re-renders)
            if (this.currentSave.audio_url !== updatedSave.audio_url) {
              this.openReadingPane(updatedSave);
            }
          }
          
          // Update list view card if visible (e.g. remove "Generating..." or update title)
          // For simplicity, we'll just re-render the list if it's the current view
          if (this.currentView === 'all' || this.currentView === 'articles') {
            this.renderSaves();
          }
        }
      })
      .subscribe();
  }

  showAuthScreen() {
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('main-screen').classList.add('hidden');
  }

  showMainScreen() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');
  }

  async signIn() {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('auth-error');
    const btn = document.getElementById('signin-btn');

    btn.disabled = true;
    btn.textContent = 'Signing in...';
    errorEl.textContent = '';

    const { error } = await this.supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      errorEl.textContent = error.message;
    }

    btn.disabled = false;
    btn.textContent = 'Sign In';
  }

  async signUp() {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('auth-error');
    const messageEl = document.getElementById('auth-message');
    const btn = document.getElementById('signup-btn');

    if (!email || !password) {
      errorEl.textContent = 'Please enter email and password';
      return;
    }

    if (password.length < 6) {
      errorEl.textContent = 'Password must be at least 6 characters';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating account...';
    errorEl.textContent = '';
    messageEl.textContent = '';

    const { error } = await this.supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      errorEl.textContent = error.message;
    } else {
      messageEl.textContent = 'Check your email to confirm your account!';
    }

    btn.disabled = false;
    btn.textContent = 'Create Account';
  }

  async signOut() {
    await this.supabase.auth.signOut();
  }

  async loadData() {
    await this.loadSaves();
  }

  // Filter + sort cached saves to match what the server query would return
  // for the current view and sort selection. Used to render the offline cache
  // instantly without flashing the wrong items/order before the fresh fetch.
  filterAndSortSaves(saves) {
    if (!saves || saves.length === 0) return [];

    const wantArchived = this.currentView === 'archived';
    const filtered = saves.filter(s => !!s.is_archived === wantArchived);

    const sortValue = document.getElementById('sort-select').value;
    const [column, direction] = sortValue.split('.');
    const ascending = direction === 'asc';

    return filtered.sort((a, b) => {
      const av = a[column];
      const bv = b[column];
      let cmp;
      if (column === 'created_at') {
        cmp = new Date(av || 0) - new Date(bv || 0);
      } else {
        cmp = String(av || '').localeCompare(String(bv || ''));
      }
      return ascending ? cmp : -cmp;
    });
  }

  async loadSaves() {
    const container = document.getElementById('saves-container');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty-state');
    
    // OFFLINE: Load from IndexedDB first for instant render.
    // getArticles() returns the raw cache (all articles, keyed/ordered by id),
    // so we must apply the same view filter + sort the server query uses.
    // Otherwise the first paint flashes archived items in id order before the
    // fresh server response replaces it with the correct, ordered list.
    const cachedSaves = await window.StashDB.getArticles();
    const visibleCached = this.filterAndSortSaves(cachedSaves);
    if (visibleCached.length > 0) {
        this.saves = visibleCached;
        this.renderSaves();
    } else {
        // Only show spinner if we have NO data to show for this view
        loading.classList.remove('hidden');
    }

    // ONLINE: Fetch fresh data
    const sortValue = document.getElementById('sort-select').value;
    const [column, direction] = sortValue.split('.');

    let query = this.supabase
      .from('saves')
      .select('*')
      .order(column, { ascending: direction === 'asc' });

    // Apply view filters
    if (this.currentView === 'archived') {
      query = query.eq('is_archived', true);
    } else {
      query = query.eq('is_archived', false);
    }

    const { data, error } = await query;

    loading.classList.add('hidden');

    if (error) {
      console.error('Error loading saves:', error);
      // If we have cached data, we are fine. Maybe show a toast?
      // For now, silent fail to offline mode is acceptable behavior
      return;
    }

    this.saves = data || [];
    
    // UPDATE CACHE: Save latest data to IndexedDB
    if (this.saves.length > 0) {
        window.StashDB.saveArticles(this.saves);
    }

    if (this.saves.length === 0) {
      empty.classList.remove('hidden');
      container.innerHTML = ''; // Clear any cached data if server says empty (edge case)
    } else {
      empty.classList.add('hidden');
      this.renderSaves();
    }
  }

  renderSaves() {
    const container = document.getElementById('saves-container');

    // Swipe-to-archive only makes sense for lists that aren't already archived.
    const swipeEnabled = this.currentView !== 'archived';

    container.innerHTML = this.saves.map(save => {
      const isHighlight = !!save.highlight;
      const date = new Date(save.created_at).toLocaleDateString();

      let cardHtml;
      if (isHighlight) {
        cardHtml = `
          <div class="save-card highlight" data-id="${save.id}">
            <div class="save-card-content">
              <div class="save-card-site">${this.escapeHtml(save.site_name || '')}</div>
              <div class="save-card-highlight">"${this.escapeHtml(save.highlight)}"</div>
              <div class="save-card-title">${this.escapeHtml(save.title || 'Untitled')}</div>
              <div class="save-card-meta">
                <span class="save-card-date">${date}</span>
              </div>
            </div>
          </div>
        `;
      } else {
        const minutes = this.readingTime(save);
        const readtime = minutes === null ? '' : `
                <span class="save-card-readtime">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="9"></circle>
                    <path d="M12 7v5l3 2"></path>
                  </svg>${minutes} min read
                </span>`;
        cardHtml = `
          <div class="save-card" data-id="${save.id}">
            <div class="save-card-content">
              <div class="save-card-body">
                <div class="save-card-site">${this.escapeHtml(save.site_name || this.hostFromUrl(save.url))}</div>
                <div class="save-card-title">${this.escapeHtml(save.title || 'Untitled')}</div>
                ${readtime}
              </div>
              <div class="save-card-thumb">${this.cardThumb(save)}</div>
            </div>
          </div>
        `;
      }

      if (!swipeEnabled) return cardHtml;

      // Wrap in a swipe container with an "Archive" action revealed on left-swipe
      return `
        <div class="save-card-swipe" data-id="${save.id}">
          <div class="save-card-swipe-action" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="21 8 21 21 3 21 3 8"></polyline>
              <rect x="1" y="3" width="22" height="5"></rect>
              <line x1="10" y1="12" x2="14" y2="12"></line>
            </svg>
            <span>Archive</span>
          </div>
          ${cardHtml}
        </div>
      `;
    }).join('');

    // Bind click events (guarding against clicks that are really the end of a swipe)
    container.querySelectorAll('.save-card').forEach(card => {
      card.addEventListener('click', () => {
        const swipeEl = card.closest('.save-card-swipe');
        if (swipeEl && swipeEl._suppressClick) return;
        const id = card.dataset.id;
        const save = this.saves.find(s => s.id === id);
        if (save) this.openReadingPane(save);
      });
    });

    // Wire up swipe-to-archive on each card
    if (swipeEnabled) {
      container.querySelectorAll('.save-card-swipe').forEach(swipeEl => {
        const card = swipeEl.querySelector('.save-card');
        const save = this.saves.find(s => s.id === swipeEl.dataset.id);
        if (card && save) this.attachSwipeToArchive(swipeEl, card, save);
      });
    }
  }

  // Attach a left-swipe-to-archive gesture to a single save card.
  attachSwipeToArchive(swipeEl, cardEl, save) {
    const action = swipeEl.querySelector('.save-card-swipe-action');
    const THRESHOLD = 90; // px of left-drag needed to commit the archive
    let startX = 0, startY = 0, dx = 0;
    let decided = false, horizontal = false;

    const onMove = (e) => {
      const mx = e.clientX - startX;
      const my = e.clientY - startY;

      // Decide once whether this gesture is a horizontal swipe or a vertical scroll
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        decided = true;
        horizontal = Math.abs(mx) > Math.abs(my);
        if (horizontal) {
          try { cardEl.setPointerCapture(e.pointerId); } catch (_) {}
        }
      }
      if (!horizontal) return;

      e.preventDefault();
      dx = Math.min(0, mx); // only allow dragging left
      cardEl.style.transform = `translateX(${dx}px)`;
      const progress = Math.min(1, Math.abs(dx) / THRESHOLD);
      if (action) action.style.opacity = String(0.5 + 0.5 * progress);
      swipeEl.classList.toggle('will-archive', Math.abs(dx) >= THRESHOLD);
    };

    const onUp = () => {
      cardEl.removeEventListener('pointermove', onMove);
      cardEl.removeEventListener('pointerup', onUp);
      cardEl.removeEventListener('pointercancel', onUp);
      if (!horizontal) return;

      // Any real drag should swallow the trailing click so the card doesn't open
      swipeEl._suppressClick = true;
      setTimeout(() => { swipeEl._suppressClick = false; }, 400);

      cardEl.style.transition = 'transform 0.2s ease';
      if (Math.abs(dx) >= THRESHOLD) {
        cardEl.style.transform = 'translateX(-100%)';
        setTimeout(() => this.archiveSaveById(save.id, swipeEl), 160);
      } else {
        cardEl.style.transform = 'translateX(0)';
        swipeEl.classList.remove('will-archive');
        if (action) action.style.opacity = '';
      }
    };

    cardEl.addEventListener('pointerdown', (e) => {
      // Ignore secondary mouse buttons
      if (e.button && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      decided = false;
      horizontal = false;
      cardEl.style.transition = 'none';
      cardEl.addEventListener('pointermove', onMove);
      cardEl.addEventListener('pointerup', onUp);
      cardEl.addEventListener('pointercancel', onUp);
    });
  }

  // Archive a save by id (used by swipe-to-archive), collapsing its card out.
  async archiveSaveById(id, swipeEl) {
    // Collapse the row with a short animation, then remove it
    if (swipeEl) {
      swipeEl.style.maxHeight = `${swipeEl.offsetHeight}px`;
      swipeEl.style.overflow = 'hidden';
      requestAnimationFrame(() => {
        swipeEl.style.transition = 'max-height 0.25s ease, opacity 0.25s ease, margin 0.25s ease';
        swipeEl.style.maxHeight = '0px';
        swipeEl.style.opacity = '0';
        swipeEl.style.margin = '0';
      });
    }

    // Optimistically drop it from local state
    const idx = this.saves.findIndex(s => s.id === id);
    if (idx !== -1) this.saves.splice(idx, 1);

    const { error } = await this.supabase
      .from('saves')
      .update({ is_archived: true })
      .eq('id', id);

    if (error) {
      console.error('Error archiving save:', error);
      this.showToast('Could not archive — try again');
      this.loadSaves();
      return;
    }

    window.StashDB.saveArticles(this.saves);
    // Keep the cached copy's archived flag in sync so it doesn't flash back
    // into the "all" list on the next offline-first render.
    window.StashDB.setArchived(id, true);
    this.showToast('Archived', {
      label: 'Undo',
      onClick: () => this.unarchiveSaveById(id),
    });

    // Remove the collapsed node, or fall back to the empty state
    setTimeout(() => {
      swipeEl?.remove();
      if (this.saves.length === 0) {
        document.getElementById('empty-state').classList.remove('hidden');
      }
    }, 280);
  }

  // Undo an archive (used by the "Undo" action in the archive toast).
  async unarchiveSaveById(id) {
    const { error } = await this.supabase
      .from('saves')
      .update({ is_archived: false })
      .eq('id', id);

    if (error) {
      console.error('Error restoring save:', error);
      this.showToast('Could not undo — try again');
      return;
    }

    // Keep the cache in sync so the restored item is filed correctly on the
    // next offline-first render (rather than lingering as archived).
    window.StashDB.setArchived(id, false);

    // Reload the current list so the restored item reappears
    await this.loadSaves();
    this.showToast('Restored');
  }

  // Lightweight toast helper. Pass an optional action ({ label, onClick }) to
  // render a tappable button (e.g. "Undo") alongside the message.
  showToast(message, action = null) {
    const toast = document.getElementById('toast');
    const msg = document.getElementById('toast-message');
    if (!toast || !msg) return;
    msg.textContent = message;

    // Clear any action button left over from a previous toast
    const prev = toast.querySelector('.toast-action');
    if (prev) prev.remove();

    if (action && action.label && typeof action.onClick === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        clearTimeout(this._toastTimer);
        toast.classList.add('hidden');
        action.onClick();
      });
      toast.appendChild(btn);
    }

    toast.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    // Give a little longer to react when there's an action to take
    this._toastTimer = setTimeout(() => toast.classList.add('hidden'), action ? 6000 : 2500);
  }

  // Ask the Service Worker to retry the pending-save queue when connectivity
  // returns. No-op on browsers without the Background Sync API; syncPendingShares
  // remains the immediate fallback on app open / online.
  async requestBackgroundSync() {
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('sync-pending-saves');
    } catch (e) {
      // Background Sync unavailable; ignore.
    }
  }

  async syncPendingShares() {
    if (!navigator.onLine) {
      // Offline: hand off to Background Sync so queued saves retry later.
      this.requestBackgroundSync();
      return;
    }
    let pending;
    try {
      pending = await window.StashDB.getPendingShares();
    } catch (e) {
      return;
    }
    if (!pending.length) return;

    let synced = 0;
    for (const { key, data } of pending) {
      try {
        // Drain through the scraper so the full article is ingested, not just
        // the shared link that was queued while offline.
        const ok = await window.StashSave.saveViaScrape(data);
        if (ok) {
          await window.StashDB.deletePendingShare(key);
          synced++;
        }
      } catch (e) {
        // Leave in queue, try again next time
      }
    }
    if (synced > 0) {
      this.loadSaves();
    }
  }

  updateOnlineStatus() {
    const toast = document.getElementById('toast');
    const msg = document.getElementById('toast-message');

    if (navigator.onLine) {
        msg.textContent = "Back online";
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 3000);

        this.syncPendingShares();
    } else {
        msg.textContent = "You are offline. Showing cached content.";
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 5000);
    }
  }

  setView(view) {
    this.currentView = view;

    // Update bottom tab bar active state
    document.querySelectorAll('.bottom-nav-item[data-view]').forEach(item => {
      item.classList.toggle('active', item.dataset.view === view);
    });

    // Sorting and adding a URL only apply to lists of saves, so hide those
    // controls on Podcasts and Settings (search stays visible on every view).
    const showSavesControls = (view === 'all' || view === 'archived') ? '' : 'none';
    const headerSort = document.getElementById('header-sort');
    if (headerSort) {
      headerSort.style.display = showSavesControls;
    }
    const headerAddBtn = document.getElementById('header-add-btn');
    if (headerAddBtn) {
      headerAddBtn.style.display = showSavesControls;
    }

    // Toggle between the saves view and the settings view
    const savesView = document.getElementById('saves-view');
    const settingsView = document.getElementById('settings-view');
    if (view === 'settings') {
      savesView.classList.add('hidden');
      settingsView.classList.remove('hidden');
      // Always land on the settings list (not a lingering stats panel)
      document.getElementById('settings-list').classList.remove('hidden');
      document.getElementById('settings-stats').classList.add('hidden');
      return;
    }

    savesView.classList.remove('hidden');
    settingsView.classList.add('hidden');

    if (view === 'podcasts') {
      this.loadPodcasts();
    } else {
      this.loadSaves();
    }
  }

  // Podcasts view (Listen Later, #12)
  async loadPodcasts() {
    const container = document.getElementById('saves-container');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty-state');

    empty.classList.add('hidden');
    loading.classList.remove('hidden');
    container.innerHTML = '';

    const { data, error } = await this.supabase
      .from('podcast_episodes')
      .select('id, title, description, audio_url, duration_seconds, created_at, artwork_url')
      .order('created_at', { ascending: false });

    loading.classList.add('hidden');

    const episodes = (!error && data) ? data : [];
    const generateBtn = `
      <a class="btn primary podcast-generate-btn" href="${CONFIG.PODCAST_WORKFLOW_URL}" target="_blank" rel="noopener"
         title="Opens the GitHub Actions workflow — click 'Run workflow' to generate a new episode now.">
        🎙️ Generate Podcast Now
      </a>`;

    if (episodes.length === 0) {
      container.innerHTML = `
        <div class="podcasts-view">
          <div class="podcasts-header">
            <p class="podcasts-intro">Your saved articles, turned into a conversational AI podcast. Subscribe with the RSS feed in any podcast app, or generate a new episode on demand.</p>
            ${generateBtn}
          </div>
          <div class="podcasts-empty">
            <div class="empty-icon">🎧</div>
            <h3>No episodes yet</h3>
            <p>Generate your first episode, or wait for the daily "Morning Brief" to run.</p>
          </div>
        </div>`;
      return;
    }

    const cards = episodes.map(ep => {
      const date = new Date(ep.created_at).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric'
      });
      const duration = ep.duration_seconds ? this.formatTime(ep.duration_seconds) : '';
      return `
        <div class="podcast-episode" data-id="${ep.id}">
          <div class="podcast-episode-header">
            ${ep.artwork_url ? `<img class="podcast-episode-artwork" src="${this.escapeHtml(ep.artwork_url)}" alt="">` : ''}
            <div class="podcast-episode-header-text">
              <div class="podcast-episode-title">${this.escapeHtml(ep.title || 'Untitled Episode')}</div>
              <div class="podcast-episode-meta">${date}${duration ? ` · ${duration}` : ''}</div>
            </div>
          </div>
          ${ep.description ? `<div class="podcast-episode-desc">${ep.description}</div>` : ''}
          ${ep.audio_url
            ? `<audio class="podcast-audio" controls preload="none" src="${this.escapeHtml(ep.audio_url)}"></audio>`
            : `<div class="podcast-episode-pending">⏳ Audio is still being generated…</div>`}
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="podcasts-view">
        <div class="podcasts-header">
          <p class="podcasts-intro">Your saved articles, turned into a conversational AI podcast. Subscribe with the RSS feed in any podcast app, or generate a new episode on demand.</p>
          ${generateBtn}
        </div>
        <div class="podcasts-list">${cards}</div>
      </div>`;
  }

  async search(query) {
    if (!query.trim()) {
      this.loadSaves();
      return;
    }

    const { data } = await this.supabase.rpc('search_saves', {
      search_query: query,
      user_uuid: this.user.id,
    });

    this.saves = data || [];
    this.renderSaves();
  }

  openReadingPane(save) {
    this.currentSave = save;
    const pane = document.getElementById('reading-pane');

    // Stop any existing audio
    this.stopAudio();

    document.getElementById('reading-title').textContent = save.title || 'Untitled';
    document.getElementById('reading-meta').innerHTML = `
      ${save.site_name || ''} ${save.author ? `· ${save.author}` : ''} · ${new Date(save.created_at).toLocaleDateString()}
    `;

    // Handle audio player visibility
    const audioPlayer = document.getElementById('audio-player');
    const audioGenerating = document.getElementById('audio-generating');

    if (save.audio_url) {
      // Audio is ready - show player
      audioPlayer.classList.remove('hidden');
      audioGenerating.classList.add('hidden');
      this.initAudio(save.audio_url);
    } else if (save.content && save.content.length > 100 && !save.highlight) {
      // Content exists but no audio yet - show generating indicator
      audioPlayer.classList.add('hidden');
      audioGenerating.classList.remove('hidden');
    } else {
      // No audio applicable (highlights, short content)
      audioPlayer.classList.add('hidden');
      audioGenerating.classList.add('hidden');
    }

    if (save.highlight) {
      document.getElementById('reading-body').innerHTML = `
        <blockquote style="font-style: italic; background: #fef3c7; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          "${this.escapeHtml(save.highlight)}"
        </blockquote>
        <p><a href="${save.url}" target="_blank" style="color: var(--primary);">View original →</a></p>
      `;
    } else if (save.content || save.excerpt) {
      document.getElementById('reading-body').innerHTML = this.renderMarkdown(save.content || save.excerpt);
    } else {
      document.getElementById('reading-body').innerHTML = `
        <div class="reading-empty">
          <p>We couldn't fetch this article's content.</p>
          <a href="${save.url || '#'}" target="_blank" class="btn primary">View Original</a>
        </div>
      `;
    }

    document.getElementById('open-original-btn').href = save.url || '#';

    // Update button states
    document.getElementById('archive-btn').classList.toggle('active', save.is_archived);

    // Show the percent already read from a previous session.
    const initialPercent = Math.min(Math.max(save.read_percent || 0, 0), 100);
    this.updateReadingProgressDisplay(initialPercent);

    pane.classList.remove('hidden');
    pane.classList.remove('chrome-hidden');
    this.lastReadingScrollTop = 0;
    // Add open class for mobile slide-in animation
    requestAnimationFrame(() => {
      pane.classList.add('open');
      // Resume roughly where the reader left off.
      const readingContent = document.getElementById('reading-content');
      if (readingContent && initialPercent > 0) {
        const scrollHeight = readingContent.scrollHeight - readingContent.clientHeight;
        if (scrollHeight > 0) {
          readingContent.scrollTop = (initialPercent / 100) * scrollHeight;
        }
      }
    });

    // Push a history entry so the Android back gesture closes the reading
    // pane instead of falling through to the OS and exiting the app.
    history.pushState({ stashView: 'reading' }, '');
  }

  closeReadingPane({ fromPopState = false } = {}) {
    const pane = document.getElementById('reading-pane');
    pane.classList.remove('open');
    pane.classList.remove('chrome-hidden');
    this.lastReadingScrollTop = 0;
    // Stop audio when closing
    this.stopAudio();
    // Persist any progress made since the last debounced save before we
    // lose the reference to currentSave.
    this.flushReadingProgress();
    // Reset progress bar
    const progressFill = document.getElementById('reading-progress-fill');
    if (progressFill) progressFill.style.width = '0%';
    // Wait for animation on mobile before hiding
    setTimeout(() => {
      if (!pane.classList.contains('open')) {
        pane.classList.add('hidden');
      }
    }, 300);
    this.currentSave = null;

    // If closing wasn't already triggered by the back gesture (e.g. the
    // user tapped the close button), unwind the history entry we pushed
    // in openReadingPane so back-stack stays balanced.
    if (!fromPopState && history.state && history.state.stashView === 'reading') {
      history.back();
    }
  }

  // Reading Progress Bar
  updateReadingProgress() {
    const readingContent = document.getElementById('reading-content');
    if (!readingContent) return;

    const scrollTop = readingContent.scrollTop;
    const scrollHeight = readingContent.scrollHeight - readingContent.clientHeight;
    // If the article fits without scrolling, it's all on screen at once.
    const progress = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 100;

    this.updateReadingProgressDisplay(progress);
    this.queueReadingProgressSave(Math.round(Math.min(Math.max(progress, 0), 100)));
  }

  // Updates the progress bar fill and the "N% read" label. Shared by the
  // live scroll handler and by openReadingPane (to show progress restored
  // from a previous session before any scrolling happens).
  updateReadingProgressDisplay(percent) {
    const progressFill = document.getElementById('reading-progress-fill');
    const progressLabel = document.getElementById('reading-progress-percent');
    const clamped = Math.min(Math.max(percent, 0), 100);

    if (progressFill) progressFill.style.width = `${clamped}%`;
    if (progressLabel) progressLabel.textContent = `${Math.round(clamped)}% read`;
  }

  // Debounce persisting scroll progress so we don't hit Supabase on every
  // scroll event; flushed immediately when the reading pane closes.
  queueReadingProgressSave(percent) {
    if (!this.currentSave) return;
    this.pendingReadPercent = percent;
    clearTimeout(this.readProgressSaveTimer);
    this.readProgressSaveTimer = setTimeout(() => {
      this.flushReadingProgress();
    }, 1000);
  }

  async flushReadingProgress() {
    clearTimeout(this.readProgressSaveTimer);
    const save = this.currentSave;
    const percent = this.pendingReadPercent;
    if (!save || percent === undefined || percent === save.read_percent) return;
    this.pendingReadPercent = undefined;

    save.read_percent = percent;
    const localSave = this.saves.find(s => s.id === save.id);
    if (localSave) localSave.read_percent = percent;
    window.StashDB.setReadPercent(save.id, percent);

    const { error } = await this.supabase
      .from('saves')
      .update({ read_percent: percent })
      .eq('id', save.id);

    if (error) console.error('Error saving reading progress:', error);
  }

  // Hide the reader header/progress bar/footer when scrolling down to read,
  // bring them back when scrolling up.
  updateReadingChromeVisibility() {
    const readingContent = document.getElementById('reading-content');
    const pane = document.getElementById('reading-pane');
    if (!readingContent || !pane) return;

    const scrollTop = readingContent.scrollTop;
    const delta = scrollTop - this.lastReadingScrollTop;
    const SCROLL_THRESHOLD = 8;
    const TOP_REVEAL_ZONE = 40;

    if (scrollTop < TOP_REVEAL_ZONE) {
      pane.classList.remove('chrome-hidden');
    } else if (delta > SCROLL_THRESHOLD) {
      pane.classList.add('chrome-hidden');
    } else if (delta < -SCROLL_THRESHOLD) {
      pane.classList.remove('chrome-hidden');
    }

    this.lastReadingScrollTop = scrollTop;
  }

  // Audio player methods
  async initAudio(url) {
    this.stopAudio();

    // Extract filename from URL and get a signed URL
    const filename = url.split('/').pop();
    const signedUrl = await this.getSignedAudioUrl(filename);

    if (!signedUrl) {
      console.error('Failed to get signed URL for audio');
      return;
    }

    this.audio = new Audio(signedUrl);
    this.isPlaying = false;

    // Reset UI
    document.getElementById('audio-progress').style.width = '0%';
    document.getElementById('audio-current').textContent = '0:00';
    document.getElementById('audio-duration').textContent = '0:00';
    document.getElementById('audio-speed').value = '1';
    this.updatePlayButton();

    // Set up event listeners
    this.audio.addEventListener('loadedmetadata', () => {
      document.getElementById('audio-duration').textContent = this.formatTime(this.audio.duration);
    });

    this.audio.addEventListener('timeupdate', () => {
      const progress = (this.audio.currentTime / this.audio.duration) * 100;
      document.getElementById('audio-progress').style.width = `${progress}%`;
      document.getElementById('audio-current').textContent = this.formatTime(this.audio.currentTime);
    });

    this.audio.addEventListener('ended', () => {
      this.isPlaying = false;
      this.updatePlayButton();
    });

    this.audio.addEventListener('error', (e) => {
      console.error('Audio error:', e);
    });
  }

  toggleAudioPlayback() {
    if (!this.audio) return;

    if (this.isPlaying) {
      this.audio.pause();
      this.isPlaying = false;
    } else {
      this.audio.play();
      this.isPlaying = true;
    }
    this.updatePlayButton();
  }

  stopAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
      this.isPlaying = false;
      this.updatePlayButton();
    }
  }

  updatePlayButton() {
    const playIcon = document.querySelector('#audio-play-btn .play-icon');
    const pauseIcon = document.querySelector('#audio-play-btn .pause-icon');

    if (this.isPlaying) {
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
    } else {
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
    }
  }

  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  async getSignedAudioUrl(path) {
    // Get a signed URL for the audio file (valid for 1 hour)
    const { data, error } = await this.supabase.storage
      .from('audio')
      .createSignedUrl(path, 3600);

    if (error) {
      console.error('Error getting signed URL:', error);
      return null;
    }
    return data.signedUrl;
  }

  async toggleArchive() {
    if (!this.currentSave) return;

    const newValue = !this.currentSave.is_archived;
    await this.supabase
      .from('saves')
      .update({ is_archived: newValue })
      .eq('id', this.currentSave.id);

    this.currentSave.is_archived = newValue;
    // Keep the offline cache in sync so the next render files this item correctly.
    window.StashDB.setArchived(this.currentSave.id, newValue);
    this.loadSaves();
    if (newValue) this.closeReadingPane();
  }

  async showStats() {
    const { data: saves } = await this.supabase
      .from('saves')
      .select('created_at, highlight, is_archived');

    const totalSaves = saves?.length || 0;
    const highlights = saves?.filter(s => s.highlight)?.length || 0;
    const articles = totalSaves - highlights;
    const archived = saves?.filter(s => s.is_archived)?.length || 0;

    // Group by month
    const byMonth = {};
    saves?.forEach(s => {
      const month = new Date(s.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
      byMonth[month] = (byMonth[month] || 0) + 1;
    });

    // Render into the Settings stats sub-panel and reveal it
    document.getElementById('settings-list').classList.add('hidden');
    const statsPanel = document.getElementById('settings-stats');
    statsPanel.classList.remove('hidden');
    statsPanel.innerHTML = `
      <div class="stats-container">
        <div class="stats-header">
          <button class="btn secondary" id="stats-back-btn">← Back</button>
          <h2>Your Stats</h2>
        </div>

        <div class="stats-cards">
          <div class="stat-card">
            <div class="stat-card-value">${totalSaves}</div>
            <div class="stat-card-label">Total Saves</div>
          </div>
          <div class="stat-card">
            <div class="stat-card-value">${articles}</div>
            <div class="stat-card-label">Articles</div>
          </div>
          <div class="stat-card">
            <div class="stat-card-value">${highlights}</div>
            <div class="stat-card-label">Highlights</div>
          </div>
          <div class="stat-card">
            <div class="stat-card-value">${archived}</div>
            <div class="stat-card-label">Archived</div>
          </div>
        </div>

        <div class="stats-section">
          <h3>Saves by Month</h3>
          <div style="display: flex; gap: 24px; flex-wrap: wrap; margin-top: 16px;">
            ${Object.entries(byMonth).slice(-6).map(([month, count]) => `
              <div>
                <div style="font-size: 24px; font-weight: 600; color: var(--primary);">${count}</div>
                <div style="font-size: 13px; color: var(--text-muted);">${month}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    // Back returns to the settings list
    document.getElementById('stats-back-btn').addEventListener('click', () => {
      statsPanel.classList.add('hidden');
      document.getElementById('settings-list').classList.remove('hidden');
    });
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Human-friendly host (e.g. "theverge.com") used as the publication source
  // when a save has no site_name.
  hostFromUrl(url) {
    if (!url) return '';
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  // Estimate reading time from the saved article body at ~220 words/min.
  // Returns null when there's no content to estimate from, so the card can
  // simply omit the reading-time line rather than show a bogus value.
  readingTime(save) {
    const text = save.content || '';
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (words === 0) return null;
    return Math.max(1, Math.round(words / 220));
  }

  // Deterministic gradient for the fallback thumbnail tile, derived from the
  // source/title so a given save always gets the same color.
  fallbackGradient(seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
    }
    const hue = Math.abs(hash) % 360;
    return `linear-gradient(135deg, hsl(${hue} 62% 68%) 0%, hsl(${(hue + 40) % 360} 58% 52%) 100%)`;
  }

  // Thumbnail markup for an article card: the real og:image when present,
  // otherwise a colored monogram tile using the source's first letter.
  cardThumb(save) {
    if (save.image_url) {
      const onerr = `this.closest('.save-card-thumb').innerHTML = window.stashApp.fallbackTile(this.dataset.seed, this.dataset.initial)`;
      const seed = this.escapeHtml(save.site_name || save.title || save.url || '');
      const initial = this.escapeHtml((save.site_name || save.title || '?').trim().charAt(0) || '?');
      return `<img src="${save.image_url}" alt="" data-seed="${seed}" data-initial="${initial}" onerror="${onerr}">`;
    }
    return this.fallbackTile(save.site_name || save.title || save.url || '', (save.site_name || save.title || '?').trim().charAt(0) || '?');
  }

  fallbackTile(seed, initial) {
    return `<div class="save-card-thumb-fallback" style="background:${this.fallbackGradient(seed)}">${this.escapeHtml(initial)}</div>`;
  }

  renderMarkdown(text) {
    if (!text) return '';

    // Configure marked for safe rendering
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,  // Convert \n to <br>
        gfm: true,     // GitHub Flavored Markdown
      });

      try {
        return marked.parse(text);
      } catch (e) {
        console.error('Markdown parse error:', e);
        // Fallback to escaped plain text
        return `<div style="white-space: pre-wrap;">${this.escapeHtml(text)}</div>`;
      }
    }

    // Fallback if marked isn't loaded
    return `<div style="white-space: pre-wrap;">${this.escapeHtml(text)}</div>`;
  }

  // Add URL Methods (manually ingest a single link from the home page)
  showAddUrlModal() {
    const modal = document.getElementById('add-url-modal');
    modal.classList.remove('hidden');
    this.resetAddUrlModal();
    document.getElementById('add-url-url').focus();
  }

  hideAddUrlModal() {
    if (this.addUrlRunning) return;
    document.getElementById('add-url-modal').classList.add('hidden');
  }

  resetAddUrlModal() {
    this.addUrlRunning = false;
    document.getElementById('add-url-url').value = '';
    document.getElementById('add-url-status').classList.add('hidden');

    const saveBtn = document.getElementById('add-url-save-btn');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }

  async saveUrlManually() {
    const status = document.getElementById('add-url-status');
    const saveBtn = document.getElementById('add-url-save-btn');
    const url = document.getElementById('add-url-url').value.trim();

    if (!url) {
      status.textContent = 'Please enter a URL.';
      status.className = 'digest-status error';
      status.classList.remove('hidden');
      return;
    }

    try {
      new URL(url);
    } catch (e) {
      status.textContent = 'That doesn\'t look like a valid URL.';
      status.className = 'digest-status error';
      status.classList.remove('hidden');
      return;
    }

    this.addUrlRunning = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    status.classList.add('hidden');

    const request = window.StashSave.buildScrapeRequest({
      url,
      user_id: this.user.id,
      source: 'manual',
      highlight: null,
      title: null,
    });

    try {
      const ok = await window.StashSave.saveViaScrape(request);
      if (!ok) throw new Error('Server rejected the save');

      status.textContent = 'Saved!';
      status.className = 'digest-status success';
      status.classList.remove('hidden');

      if (this.currentView === 'all' || this.currentView === 'archived') {
        this.loadSaves();
      }

      this.addUrlRunning = false;
      setTimeout(() => this.hideAddUrlModal(), 1000);
    } catch (error) {
      console.error('Error saving URL:', error);
      this.addUrlRunning = false;
      status.textContent = "Couldn't save this URL. Please try again.";
      status.className = 'digest-status error';
      status.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }

  // Podcast Settings Methods (custom host personalities, #13)
  showPodcastModal() {
    const modal = document.getElementById('podcast-modal');
    modal.classList.remove('hidden');
    this.loadPodcastPreferences();
  }

  hidePodcastModal() {
    const modal = document.getElementById('podcast-modal');
    modal.classList.add('hidden');
    document.getElementById('podcast-status').classList.add('hidden');
  }

  async loadPodcastPreferences() {
    try {
      const { data, error } = await this.supabase
        .from('user_preferences')
        .select('podcast_host_a_name, podcast_host_a_persona, podcast_host_b_name, podcast_host_b_persona, podcast_tone')
        .eq('user_id', this.user.id)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
        throw error;
      }

      const prefs = data || {};
      document.getElementById('podcast-host-a-name').value = prefs.podcast_host_a_name || '';
      document.getElementById('podcast-host-a-persona').value = prefs.podcast_host_a_persona || '';
      document.getElementById('podcast-host-b-name').value = prefs.podcast_host_b_name || '';
      document.getElementById('podcast-host-b-persona').value = prefs.podcast_host_b_persona || '';
      document.getElementById('podcast-tone').value = prefs.podcast_tone || '';
    } catch (error) {
      console.error('Error loading podcast preferences:', error);
    }
  }

  async savePodcastPreferences() {
    const status = document.getElementById('podcast-status');
    const saveBtn = document.getElementById('podcast-save-btn');

    // Empty string -> null so the pipeline falls back to defaults.
    const clean = (id) => document.getElementById(id).value.trim() || null;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const { error } = await this.supabase
        .from('user_preferences')
        .upsert({
          user_id: this.user.id,
          podcast_host_a_name: clean('podcast-host-a-name'),
          podcast_host_a_persona: clean('podcast-host-a-persona'),
          podcast_host_b_name: clean('podcast-host-b-name'),
          podcast_host_b_persona: clean('podcast-host-b-persona'),
          podcast_tone: clean('podcast-tone'),
        }, {
          onConflict: 'user_id'
        });

      if (error) throw error;

      status.textContent = 'Saved! Your next podcast will use these hosts.';
      status.className = 'digest-status success';
      status.classList.remove('hidden');

      setTimeout(() => this.hidePodcastModal(), 1500);
    } catch (error) {
      console.error('Error saving podcast preferences:', error);
      status.textContent = 'Error saving preferences. Please try again.';
      status.className = 'digest-status error';
      status.classList.remove('hidden');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Settings';
    }
  }

  // Import Methods (CSV from Pocket/Instapaper/etc.)
  showImportModal() {
    const modal = document.getElementById('import-modal');
    modal.classList.remove('hidden');
    this.resetImportModal();
  }

  hideImportModal() {
    // Don't let the modal be dismissed mid-import — that would orphan the
    // in-flight scrape requests with no feedback.
    if (this.importRunning) return;
    document.getElementById('import-modal').classList.add('hidden');
  }

  // Reset the modal back to its initial "choose a file" state.
  resetImportModal() {
    this.importRows = null;
    this.importRunning = false;
    this.importStop = false;

    const fileInput = document.getElementById('import-file');
    fileInput.value = '';
    fileInput.disabled = false;

    document.getElementById('import-summary').classList.add('hidden');
    document.getElementById('import-progress').classList.add('hidden');
    document.getElementById('import-progress-fill').style.width = '0%';
    document.getElementById('import-status').classList.add('hidden');

    const startBtn = document.getElementById('import-start-btn');
    startBtn.disabled = true;
    startBtn.textContent = 'Import';
    document.getElementById('import-cancel-btn').textContent = 'Cancel';
  }

  async handleImportFile(file) {
    const summary = document.getElementById('import-summary');
    const status = document.getElementById('import-status');
    const startBtn = document.getElementById('import-start-btn');

    status.classList.add('hidden');
    this.importRows = null;
    startBtn.disabled = true;

    if (!file) {
      summary.classList.add('hidden');
      return;
    }

    let text;
    try {
      text = await file.text();
    } catch (e) {
      summary.classList.add('hidden');
      status.textContent = 'Could not read that file. Please try again.';
      status.className = 'digest-status error';
      status.classList.remove('hidden');
      return;
    }

    const rows = window.StashImport.parseCsv(text);

    if (rows.length === 0) {
      summary.classList.add('hidden');
      status.textContent = 'No articles with a URL column were found in that CSV.';
      status.className = 'digest-status error';
      status.classList.remove('hidden');
      return;
    }

    this.importRows = rows;
    summary.textContent = `Found ${rows.length} article${rows.length === 1 ? '' : 's'} to import.`;
    summary.classList.remove('hidden');
    startBtn.disabled = false;
  }

  // Cancel doubles as "stop" during a run and "close" otherwise.
  handleImportCancel() {
    if (this.importRunning) {
      this.importStop = true;
      document.getElementById('import-cancel-btn').textContent = 'Stopping…';
      return;
    }
    this.hideImportModal();
  }

  async runImport() {
    const rows = this.importRows || [];
    if (!rows.length || this.importRunning) return;

    const startBtn = document.getElementById('import-start-btn');
    const cancelBtn = document.getElementById('import-cancel-btn');
    const fileInput = document.getElementById('import-file');
    const progress = document.getElementById('import-progress');
    const fill = document.getElementById('import-progress-fill');
    const label = document.getElementById('import-progress-label');
    const status = document.getElementById('import-status');

    this.importRunning = true;
    this.importStop = false;

    startBtn.disabled = true;
    startBtn.textContent = 'Importing…';
    fileInput.disabled = true;
    cancelBtn.textContent = 'Stop';
    status.classList.add('hidden');
    progress.classList.remove('hidden');

    const total = rows.length;
    let done = 0;
    let failed = 0;

    const updateProgress = () => {
      const pct = Math.round((done / total) * 100);
      fill.style.width = `${pct}%`;
      label.textContent = `Imported ${done} of ${total}${failed ? ` · ${failed} failed` : ''}`;
    };
    updateProgress();

    let cursor = 0;
    const worker = async () => {
      while (cursor < rows.length && !this.importStop) {
        const row = rows[cursor++];
        try {
          const req = window.StashSave.buildScrapeRequest({
            url: row.url,
            user_id: this.user.id,
            source: 'import',
            created_at: row.created_at, // preserve original save date when present
          });
          const ok = await window.StashSave.saveViaScrape(req);
          if (!ok) failed++;
        } catch (e) {
          failed++;
        }
        done++;
        updateProgress();
      }
    };

    // A little concurrency keeps large imports moving without hammering the
    // scraper Edge Function.
    const CONCURRENCY = 3;
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    this.importRunning = false;
    const imported = done - failed;
    const stopped = this.importStop && cursor < rows.length;

    let message = `Imported ${imported} article${imported === 1 ? '' : 's'}.`;
    if (failed) message += ` ${failed} could not be fetched.`;
    if (stopped) message += ' Import stopped.';

    status.textContent = message;
    status.className = `digest-status ${failed && imported === 0 ? 'error' : 'success'}`;
    status.classList.remove('hidden');

    startBtn.textContent = 'Import';
    cancelBtn.textContent = 'Close';

    // Refresh the list so freshly imported saves show up.
    if (imported > 0 && (this.currentView === 'all' || this.currentView === 'archived')) {
      this.loadSaves();
    }
  }
}

// Initialize app
const app = new StashApp();
// Exposed for inline handlers (e.g. thumbnail onerror fallback).
window.stashApp = app;
