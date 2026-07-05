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
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('stash-theme', newTheme);
    this.updateThemeToggle(newTheme);
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

    document.getElementById('archive-btn').addEventListener('click', () => {
      this.toggleArchive();
    });

    document.getElementById('favorite-btn').addEventListener('click', () => {
      this.toggleFavorite();
    });

    document.getElementById('delete-btn').addEventListener('click', () => {
      this.deleteSave();
    });

    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', () => {
      this.toggleTheme();
    });

    // Reading progress bar
    const readingContent = document.getElementById('reading-content');
    if (readingContent) {
      readingContent.addEventListener('scroll', () => {
        this.updateReadingProgress();
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

    // Digest Settings Modal
    const digestModal = document.getElementById('digest-modal');

    document.getElementById('digest-settings-btn').addEventListener('click', () => {
      this.showDigestModal();
    });

    digestModal.querySelector('.modal-overlay').addEventListener('click', () => {
      this.hideDigestModal();
    });
    digestModal.querySelector('.modal-close-btn').addEventListener('click', () => {
      this.hideDigestModal();
    });
    document.getElementById('digest-cancel-btn').addEventListener('click', () => {
      this.hideDigestModal();
    });
    document.getElementById('digest-save-btn').addEventListener('click', () => {
      this.saveDigestPreferences();
    });

    // Toggle enabled/disabled state of options
    document.getElementById('digest-enabled').addEventListener('change', () => {
      this.updateDigestOptionsState();
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

    // PWA: Online/Offline Status
    window.addEventListener('online', () => this.updateOnlineStatus());
    window.addEventListener('offline', () => this.updateOnlineStatus());
    
    // PWA: Install Prompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      const installBtn = document.getElementById('pwa-install-btn');
      installBtn.classList.remove('hidden');
      
      installBtn.addEventListener('click', () => {
        installBtn.classList.add('hidden');
        this.deferredPrompt.prompt();
        this.deferredPrompt.userChoice.then((choiceResult) => {
          if (choiceResult.outcome === 'accepted') {
            console.log('User accepted the install prompt');
          }
          this.deferredPrompt = null;
        });
      });
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

  async loadSaves() {
    const container = document.getElementById('saves-container');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty-state');
    
    // OFFLINE: Load from IndexedDB first for instant render
    const cachedSaves = await window.StashDB.getArticles();
    if (cachedSaves && cachedSaves.length > 0) {
        this.saves = cachedSaves;
        // Apply local sort/filter if needed, but for now just render raw dump or basic sort
        // We'll skip complex filtering on cached data for MVP or do basic JS sort
        this.renderSaves(); 
    } else {
        // Only show spinner if we have NO data
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

    // Sorting only applies to lists of saves, so hide the sort control on
    // Podcasts and Settings (search stays visible on every view).
    const headerSort = document.getElementById('header-sort');
    if (headerSort) {
      headerSort.style.display = (view === 'all' || view === 'archived') ? '' : 'none';
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
      .select('id, title, description, audio_url, duration_seconds, created_at')
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
            <div class="podcast-episode-title">${this.escapeHtml(ep.title || 'Untitled Episode')}</div>
            <div class="podcast-episode-meta">${date}${duration ? ` · ${duration}` : ''}</div>
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
    } else {
      const content = save.content || save.excerpt || 'No content available.';
      document.getElementById('reading-body').innerHTML = this.renderMarkdown(content);
    }

    document.getElementById('open-original-btn').href = save.url || '#';

    // Update button states
    document.getElementById('archive-btn').classList.toggle('active', save.is_archived);
    document.getElementById('favorite-btn').classList.toggle('active', save.is_favorite);

    pane.classList.remove('hidden');
    // Add open class for mobile slide-in animation
    requestAnimationFrame(() => {
      pane.classList.add('open');
    });
  }

  closeReadingPane() {
    const pane = document.getElementById('reading-pane');
    pane.classList.remove('open');
    // Stop audio when closing
    this.stopAudio();
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
  }

  // Reading Progress Bar
  updateReadingProgress() {
    const readingContent = document.getElementById('reading-content');
    const progressFill = document.getElementById('reading-progress-fill');

    if (!readingContent || !progressFill) return;

    const scrollTop = readingContent.scrollTop;
    const scrollHeight = readingContent.scrollHeight - readingContent.clientHeight;

    if (scrollHeight > 0) {
      const progress = (scrollTop / scrollHeight) * 100;
      progressFill.style.width = `${Math.min(progress, 100)}%`;
    }
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
    this.loadSaves();
    if (newValue) this.closeReadingPane();
  }

  async toggleFavorite() {
    if (!this.currentSave) return;

    const newValue = !this.currentSave.is_favorite;
    await this.supabase
      .from('saves')
      .update({ is_favorite: newValue })
      .eq('id', this.currentSave.id);

    this.currentSave.is_favorite = newValue;
    document.getElementById('favorite-btn').classList.toggle('active', newValue);
  }

  async deleteSave() {
    if (!this.currentSave) return;

    if (!confirm('Delete this save? This cannot be undone.')) return;

    await this.supabase
      .from('saves')
      .delete()
      .eq('id', this.currentSave.id);

    this.closeReadingPane();
    this.loadSaves();
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

  // Digest Settings Methods
  showDigestModal() {
    const modal = document.getElementById('digest-modal');
    modal.classList.remove('hidden');
    this.loadDigestPreferences();
  }

  hideDigestModal() {
    const modal = document.getElementById('digest-modal');
    modal.classList.add('hidden');
    document.getElementById('digest-status').classList.add('hidden');
  }

  async loadDigestPreferences() {
    try {
      const { data, error } = await this.supabase
        .from('user_preferences')
        .select('*')
        .eq('user_id', this.user.id)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
        throw error;
      }

      // Populate form with existing preferences or defaults
      const prefs = data || {};
      document.getElementById('digest-enabled').checked = prefs.digest_enabled || false;
      document.getElementById('digest-email').value = prefs.digest_email || '';
      document.getElementById('digest-day').value = prefs.digest_day ?? 0;
      document.getElementById('digest-hour').value = prefs.digest_hour ?? 9;

      // Update UI state
      this.updateDigestOptionsState();

    } catch (error) {
      console.error('Error loading digest preferences:', error);
    }
  }

  updateDigestOptionsState() {
    const enabled = document.getElementById('digest-enabled').checked;
    const options = document.getElementById('digest-options');
    const schedule = document.getElementById('digest-schedule-group');

    if (enabled) {
      options.classList.remove('disabled');
      schedule.classList.remove('disabled');
    } else {
      options.classList.add('disabled');
      schedule.classList.add('disabled');
    }
  }

  async saveDigestPreferences() {
    const status = document.getElementById('digest-status');
    const saveBtn = document.getElementById('digest-save-btn');

    const enabled = document.getElementById('digest-enabled').checked;
    const email = document.getElementById('digest-email').value.trim();
    const day = parseInt(document.getElementById('digest-day').value);
    const hour = parseInt(document.getElementById('digest-hour').value);

    // Validate email if enabled
    if (enabled && !email) {
      status.textContent = 'Please enter an email address';
      status.className = 'digest-status error';
      status.classList.remove('hidden');
      return;
    }

    if (enabled && !email.includes('@')) {
      status.textContent = 'Please enter a valid email address';
      status.className = 'digest-status error';
      status.classList.remove('hidden');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      // Upsert preferences (insert or update)
      const { error } = await this.supabase
        .from('user_preferences')
        .upsert({
          user_id: this.user.id,
          digest_enabled: enabled,
          digest_email: email || null,
          digest_day: day,
          digest_hour: hour,
        }, {
          onConflict: 'user_id'
        });

      if (error) throw error;

      status.textContent = enabled
        ? 'Digest enabled! You\'ll receive emails weekly.'
        : 'Digest disabled. You won\'t receive emails.';
      status.className = 'digest-status success';
      status.classList.remove('hidden');

      // Close modal after delay
      setTimeout(() => this.hideDigestModal(), 1500);

    } catch (error) {
      console.error('Error saving digest preferences:', error);
      status.textContent = 'Error saving preferences. Please try again.';
      status.className = 'digest-status error';
      status.classList.remove('hidden');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Settings';
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
}

// Initialize app
const app = new StashApp();
// Exposed for inline handlers (e.g. thumbnail onerror fallback).
window.stashApp = app;
