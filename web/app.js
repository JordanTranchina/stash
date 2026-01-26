// Stash Web App (Single-user mode - no auth required)
class StashApp {
  constructor() {
    this.supabase = null;
    this.user = { id: CONFIG.USER_ID }; // Hardcoded single user
    this.currentView = 'all';
    this.currentSave = null;
    this.saves = [];
    this.tags = [];
    this.folders = [];
    this.pendingKindleImport = null; // Stores parsed highlights before import

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

    // Navigation
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = item.dataset.view;
        this.setView(view);
      });
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

    document.getElementById('add-tag-btn').addEventListener('click', () => {
      this.addTagToSave();
    });

    // Mobile menu
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    document.getElementById('mobile-menu-btn').addEventListener('click', () => {
      sidebar.classList.add('open');
      overlay.classList.add('open');
    });

    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
    });

    // Close sidebar when nav item clicked on mobile
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
          sidebar.classList.remove('open');
          overlay.classList.remove('open');
        }
      });
    });

    // Add folder
    document.getElementById('add-folder-btn').addEventListener('click', () => {
      this.addFolder();
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

    // Kindle Import
    document.getElementById('kindle-import-btn').addEventListener('click', () => {
      this.showKindleImportModal();
    });

    const kindleModal = document.getElementById('kindle-import-modal');
    const kindleDropzone = document.getElementById('kindle-dropzone');
    const kindleFileInput = document.getElementById('kindle-file-input');

    // Modal close handlers
    kindleModal.querySelector('.modal-overlay').addEventListener('click', () => {
      this.hideKindleImportModal();
    });
    kindleModal.querySelector('.modal-close-btn').addEventListener('click', () => {
      this.hideKindleImportModal();
    });
    document.getElementById('kindle-cancel-btn').addEventListener('click', () => {
      this.hideKindleImportModal();
    });
    document.getElementById('kindle-confirm-btn').addEventListener('click', () => {
      this.confirmKindleImport();
    });

    // Dropzone interactions
    kindleDropzone.addEventListener('click', () => {
      kindleFileInput.click();
    });

    kindleFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.handleKindleFile(e.target.files[0]);
      }
    });

    // Drag and drop
    kindleDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      kindleDropzone.classList.add('dragover');
    });

    kindleDropzone.addEventListener('dragleave', () => {
      kindleDropzone.classList.remove('dragover');
    });

    kindleDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      kindleDropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        this.handleKindleFile(e.dataTransfer.files[0]);
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
    await Promise.all([
      this.loadSaves(),
      this.loadTags(),
      this.loadFolders(),
    ]);
  }

  async loadSaves() {
    const container = document.getElementById('saves-container');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty-state');

    loading.classList.remove('hidden');
    container.innerHTML = '';

    const sortValue = document.getElementById('sort-select').value;
    const [column, direction] = sortValue.split('.');

    let query = this.supabase
      .from('saves')
      .select('*')
      .order(column, { ascending: direction === 'asc' });

    // Apply view filters
    if (this.currentView === 'highlights') {
      query = query.not('highlight', 'is', null);
    } else if (this.currentView === 'articles') {
      query = query.is('highlight', null);
    } else if (this.currentView === 'archived') {
      query = query.eq('is_archived', true);
    } else if (this.currentView === 'weekly') {
      // Weekly review - get this week's saves
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      query = query.gte('created_at', weekAgo.toISOString());
    } else {
      query = query.eq('is_archived', false);
    }

    const { data, error } = await query;

    loading.classList.add('hidden');

    if (error) {
      console.error('Error loading saves:', error);
      return;
    }

    this.saves = data || [];

    if (this.saves.length === 0) {
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      // Use special rendering for weekly view
      if (this.currentView === 'weekly') {
        this.renderWeeklyReview();
      } else {
        this.renderSaves();
      }
    }
  }

  renderSaves() {
    const container = document.getElementById('saves-container');

    container.innerHTML = this.saves.map(save => {
      const isHighlight = !!save.highlight;
      const date = new Date(save.created_at).toLocaleDateString();

      if (isHighlight) {
        return `
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
      }

      return `
        <div class="save-card" data-id="${save.id}">
          ${save.image_url ? `<img class="save-card-image" src="${save.image_url}" alt="" onerror="this.style.display='none'">` : ''}
          <div class="save-card-content">
            <div class="save-card-site">${this.escapeHtml(save.site_name || '')}</div>
            <div class="save-card-title">${this.escapeHtml(save.title || 'Untitled')}</div>
            <div class="save-card-excerpt">${this.escapeHtml(save.excerpt || '')}</div>
            <div class="save-card-meta">
              <span class="save-card-date">${date}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Bind click events
    container.querySelectorAll('.save-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        const save = this.saves.find(s => s.id === id);
        if (save) this.openReadingPane(save);
      });
    });
  }

  // Weekly Review special rendering
  renderWeeklyReview() {
    const container = document.getElementById('saves-container');

    // Calculate stats
    const articles = this.saves.filter(s => !s.highlight);
    const highlights = this.saves.filter(s => s.highlight);
    const totalWords = articles.reduce((sum, s) => {
      const words = (s.content || '').split(/\s+/).length;
      return sum + words;
    }, 0);

    // Get unique sites
    const sites = [...new Set(this.saves.map(s => s.site_name).filter(Boolean))];

    // Pick a random "rediscovery" from older saves
    let rediscovery = null;
    const allSavesQuery = this.supabase
      .from('saves')
      .select('*')
      .lt('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .limit(50);

    allSavesQuery.then(({ data }) => {
      if (data && data.length > 0) {
        rediscovery = data[Math.floor(Math.random() * data.length)];
        this.updateRediscovery(rediscovery);
      }
    });

    container.innerHTML = `
      <div class="weekly-review">
        <div class="weekly-header">
          <h3>Your Week in Review</h3>
          <p class="weekly-dates">${this.getWeekDateRange()}</p>
        </div>

        <div class="weekly-stats">
          <div class="weekly-stat">
            <span class="weekly-stat-value">${this.saves.length}</span>
            <span class="weekly-stat-label">items saved</span>
          </div>
          <div class="weekly-stat">
            <span class="weekly-stat-value">${articles.length}</span>
            <span class="weekly-stat-label">articles</span>
          </div>
          <div class="weekly-stat">
            <span class="weekly-stat-value">${highlights.length}</span>
            <span class="weekly-stat-label">highlights</span>
          </div>
          <div class="weekly-stat">
            <span class="weekly-stat-value">${Math.round(totalWords / 1000)}k</span>
            <span class="weekly-stat-label">words</span>
          </div>
        </div>

        ${sites.length > 0 ? `
          <div class="weekly-section">
            <h4>Sources</h4>
            <div class="weekly-sources">
              ${sites.slice(0, 10).map(site => `<span class="weekly-source">${this.escapeHtml(site)}</span>`).join('')}
            </div>
          </div>
        ` : ''}

        <div class="weekly-section" id="rediscovery-section">
          <h4>Rediscover</h4>
          <p class="weekly-rediscovery-hint">Loading a random gem from your archive...</p>
        </div>

        <div class="weekly-section">
          <h4>This Week's Saves</h4>
        </div>

        <div class="saves-grid">
          ${this.saves.map(save => this.renderSaveCard(save)).join('')}
        </div>
      </div>
    `;

    // Bind click events
    container.querySelectorAll('.save-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        const save = this.saves.find(s => s.id === id);
        if (save) this.openReadingPane(save);
      });
    });
  }

  updateRediscovery(save) {
    const section = document.getElementById('rediscovery-section');
    if (!section || !save) return;

    const date = new Date(save.created_at).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });

    section.innerHTML = `
      <h4>Rediscover</h4>
      <div class="rediscovery-card" data-id="${save.id}">
        <div class="rediscovery-meta">Saved ${date}</div>
        <div class="rediscovery-title">${this.escapeHtml(save.title || 'Untitled')}</div>
        ${save.highlight ? `<div class="rediscovery-highlight">"${this.escapeHtml(save.highlight)}"</div>` : ''}
        <div class="rediscovery-source">${this.escapeHtml(save.site_name || '')}</div>
      </div>
    `;

    section.querySelector('.rediscovery-card')?.addEventListener('click', () => {
      this.openReadingPane(save);
    });
  }

  renderSaveCard(save) {
    const isHighlight = !!save.highlight;
    const date = new Date(save.created_at).toLocaleDateString();

    if (isHighlight) {
      return `
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
    }

    return `
      <div class="save-card" data-id="${save.id}">
        ${save.image_url ? `<img class="save-card-image" src="${save.image_url}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="save-card-content">
          <div class="save-card-site">${this.escapeHtml(save.site_name || '')}</div>
          <div class="save-card-title">${this.escapeHtml(save.title || 'Untitled')}</div>
          <div class="save-card-excerpt">${this.escapeHtml(save.excerpt || '')}</div>
          <div class="save-card-meta">
            <span class="save-card-date">${date}</span>
          </div>
        </div>
      </div>
    `;
  }

  getWeekDateRange() {
    const now = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const options = { month: 'short', day: 'numeric' };
    return `${weekAgo.toLocaleDateString('en-US', options)} - ${now.toLocaleDateString('en-US', options)}`;
  }

  async loadTags() {
    const { data } = await this.supabase
      .from('tags')
      .select('*')
      .order('name');

    this.tags = data || [];
    this.renderTags();
  }

  renderTags() {
    const container = document.getElementById('tags-list');
    container.innerHTML = this.tags.map(tag => `
      <span class="tag" data-id="${tag.id}">${this.escapeHtml(tag.name)}</span>
    `).join('');

    container.querySelectorAll('.tag').forEach(el => {
      el.addEventListener('click', () => {
        // TODO: Filter by tag
      });
    });
  }

  async loadFolders() {
    const { data } = await this.supabase
      .from('folders')
      .select('*')
      .order('name');

    this.folders = data || [];
    this.renderFolders();
  }

  renderFolders() {
    const container = document.getElementById('folders-list');
    container.innerHTML = this.folders.map(folder => `
      <a href="#" class="nav-item" data-folder="${folder.id}">
        <span style="color: ${folder.color}">📁</span>
        ${this.escapeHtml(folder.name)}
      </a>
    `).join('');
  }

  setView(view) {
    this.currentView = view;

    // Update nav
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.classList.toggle('active', item.dataset.view === view);
    });

    // Update title
    const titles = {
      all: 'All Saves',
      highlights: 'Highlights',
      articles: 'Articles',
      kindle: 'Kindle Highlights',
      archived: 'Archived',
      stats: 'Stats',
    };
    document.getElementById('view-title').textContent = titles[view] || 'Saves';

    if (view === 'stats') {
      this.showStats();
    } else if (view === 'kindle') {
      this.loadKindleHighlights();
    } else {
      this.loadSaves();
    }
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

  async addTagToSave() {
    if (!this.currentSave) return;

    const tagName = prompt('Enter tag name:');
    if (!tagName?.trim()) return;

    // Get or create tag
    let { data: existingTag } = await this.supabase
      .from('tags')
      .select('*')
      .eq('name', tagName.trim())
      .single();

    if (!existingTag) {
      const { data: newTag } = await this.supabase
        .from('tags')
        .insert({ user_id: this.user.id, name: tagName.trim() })
        .select()
        .single();
      existingTag = newTag;
    }

    if (existingTag) {
      await this.supabase
        .from('save_tags')
        .insert({ save_id: this.currentSave.id, tag_id: existingTag.id });

      this.loadTags();
    }
  }

  async addFolder() {
    const name = prompt('Folder name:');
    if (!name?.trim()) return;

    await this.supabase
      .from('folders')
      .insert({ user_id: this.user.id, name: name.trim() });

    this.loadFolders();
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

    const content = document.querySelector('.content');
    content.innerHTML = `
      <div class="stats-container">
        <div class="stats-header">
          <h2>Your Stats</h2>
          <button class="btn secondary" onclick="app.setView('all')">← Back</button>
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
  }

  // Kindle Highlights View
  async loadKindleHighlights() {
    const container = document.getElementById('saves-container');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty-state');

    loading.classList.remove('hidden');
    container.innerHTML = '';

    const { data, error } = await this.supabase
      .from('saves')
      .select('*')
      .eq('source', 'kindle')
      .order('title', { ascending: true });

    loading.classList.add('hidden');

    if (error) {
      console.error('Error loading Kindle highlights:', error);
      return;
    }

    if (!data || data.length === 0) {
      empty.classList.remove('hidden');
      document.querySelector('.empty-icon').textContent = '📚';
      document.querySelector('.empty-state h3').textContent = 'No Kindle highlights yet';
      document.querySelector('.empty-state p').textContent = 'Import your Kindle highlights using the "Import Kindle" button in the sidebar, or sync from the Chrome extension.';
      return;
    }

    empty.classList.add('hidden');

    // Group by book title
    const books = {};
    data.forEach(save => {
      const key = save.title || 'Unknown Book';
      if (!books[key]) {
        books[key] = {
          title: save.title,
          author: save.author,
          highlights: [],
        };
      }
      books[key].highlights.push(save);
    });

    // Sort books by highlight count (most first)
    const sortedBooks = Object.values(books).sort((a, b) => b.highlights.length - a.highlights.length);

    this.renderKindleBooks(sortedBooks);
  }

  renderKindleBooks(books) {
    const container = document.getElementById('saves-container');

    container.innerHTML = `
      <div class="kindle-stats">
        <div class="kindle-stat">
          <span class="kindle-stat-value">${books.reduce((sum, b) => sum + b.highlights.length, 0)}</span>
          <span class="kindle-stat-label">highlights</span>
        </div>
        <div class="kindle-stat">
          <span class="kindle-stat-value">${books.length}</span>
          <span class="kindle-stat-label">books</span>
        </div>
        <button class="btn secondary kindle-clear-btn" id="clear-kindle-btn">Clear All Kindle Data</button>
      </div>
      <div class="kindle-books-grid">
        ${books.map(book => `
          <div class="kindle-book-card" data-title="${this.escapeHtml(book.title || '')}">
            <div class="kindle-book-header">
              <div class="kindle-book-icon">📖</div>
              <div class="kindle-book-info">
                <h3 class="kindle-book-title">${this.escapeHtml(book.title || 'Unknown Book')}</h3>
                ${book.author ? `<p class="kindle-book-author">${this.escapeHtml(book.author)}</p>` : ''}
              </div>
              <span class="kindle-book-count">${book.highlights.length}</span>
            </div>
            <div class="kindle-highlights-preview">
              ${book.highlights.slice(0, 3).map(h => `
                <div class="kindle-highlight-snippet" data-id="${h.id}">
                  "${this.escapeHtml(h.highlight?.substring(0, 150) || '')}${h.highlight?.length > 150 ? '...' : ''}"
                </div>
              `).join('')}
              ${book.highlights.length > 3 ? `
                <div class="kindle-more-highlights">+${book.highlights.length - 3} more highlights</div>
              ` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;

    // Bind click events to open highlights
    container.querySelectorAll('.kindle-highlight-snippet').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.id;
        const allHighlights = books.flatMap(b => b.highlights);
        const save = allHighlights.find(s => s.id === id);
        if (save) this.openReadingPane(save);
      });
    });

    // Bind book card clicks to expand
    container.querySelectorAll('.kindle-book-card').forEach(card => {
      card.addEventListener('click', () => {
        const title = card.dataset.title;
        const book = books.find(b => (b.title || '') === title);
        if (book) this.showBookHighlights(book);
      });
    });

    // Clear Kindle data button
    const clearBtn = document.getElementById('clear-kindle-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearKindleData());
    }
  }

  async clearKindleData() {
    const count = this.saves?.length || 0;
    if (!confirm(`Delete all ${count} Kindle highlights? This cannot be undone.`)) {
      return;
    }

    try {
      const { error } = await this.supabase
        .from('saves')
        .delete()
        .eq('source', 'kindle');

      if (error) throw error;

      alert('All Kindle data cleared. You can now re-sync from the Chrome extension.');
      this.loadKindleHighlights();
    } catch (err) {
      console.error('Error clearing Kindle data:', err);
      alert('Failed to clear data: ' + err.message);
    }
  }

  showBookHighlights(book) {
    const container = document.getElementById('saves-container');

    container.innerHTML = `
      <div class="kindle-book-detail">
        <button class="btn secondary kindle-back-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          Back to all books
        </button>
        <div class="kindle-book-detail-header">
          <div class="kindle-book-icon-large">📖</div>
          <div>
            <h2>${this.escapeHtml(book.title || 'Unknown Book')}</h2>
            ${book.author ? `<p class="kindle-book-author">${this.escapeHtml(book.author)}</p>` : ''}
            <p class="kindle-book-meta">${book.highlights.length} highlights</p>
          </div>
        </div>
        <div class="kindle-highlights-list">
          ${book.highlights.map(h => `
            <div class="kindle-highlight-card" data-id="${h.id}">
              <div class="kindle-highlight-text">"${this.escapeHtml(h.highlight || '')}"</div>
              <div class="kindle-highlight-meta">
                ${new Date(h.created_at).toLocaleDateString()}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    // Back button
    container.querySelector('.kindle-back-btn').addEventListener('click', () => {
      this.loadKindleHighlights();
    });

    // Highlight clicks
    container.querySelectorAll('.kindle-highlight-card').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        const save = book.highlights.find(s => s.id === id);
        if (save) this.openReadingPane(save);
      });
    });
  }

  // Kindle Import Methods
  showKindleImportModal() {
    const modal = document.getElementById('kindle-import-modal');
    modal.classList.remove('hidden');
    this.resetKindleImportModal();
  }

  hideKindleImportModal() {
    const modal = document.getElementById('kindle-import-modal');
    modal.classList.add('hidden');
    this.resetKindleImportModal();
  }

  resetKindleImportModal() {
    this.pendingKindleImport = null;
    document.getElementById('kindle-file-input').value = '';
    document.getElementById('kindle-import-preview').classList.add('hidden');
    document.getElementById('kindle-import-footer').classList.add('hidden');
    const dropzone = document.getElementById('kindle-dropzone');
    dropzone.classList.remove('success', 'processing');
  }

  async handleKindleFile(file) {
    if (!file.name.endsWith('.txt')) {
      alert('Please upload a .txt file (My Clippings.txt from your Kindle)');
      return;
    }

    const dropzone = document.getElementById('kindle-dropzone');
    dropzone.classList.add('processing');

    try {
      const content = await file.text();
      const highlights = this.parseMyClippings(content);

      if (highlights.length === 0) {
        alert('No highlights found in this file. Make sure it\'s a valid My Clippings.txt file.');
        dropzone.classList.remove('processing');
        return;
      }

      // Check for duplicates against existing saves
      const { data: existingSaves } = await this.supabase
        .from('saves')
        .select('highlight, title')
        .not('highlight', 'is', null);

      const existingSet = new Set(
        (existingSaves || []).map(s => `${s.highlight}|||${s.title}`)
      );

      let duplicateCount = 0;
      const newHighlights = highlights.filter(h => {
        const key = `${h.highlight}|||${h.title}`;
        if (existingSet.has(key)) {
          duplicateCount++;
          return false;
        }
        return true;
      });

      this.pendingKindleImport = newHighlights;

      // Group by book for display
      const bookCounts = {};
      newHighlights.forEach(h => {
        const key = h.title;
        if (!bookCounts[key]) {
          bookCounts[key] = { title: h.title, author: h.author, count: 0 };
        }
        bookCounts[key].count++;
      });

      // Update UI
      dropzone.classList.remove('processing');
      dropzone.classList.add('success');

      document.getElementById('import-total').textContent = newHighlights.length;
      document.getElementById('import-books').textContent = Object.keys(bookCounts).length;
      document.getElementById('import-duplicates').textContent = duplicateCount;

      const booksList = document.getElementById('import-books-list');
      booksList.innerHTML = Object.values(bookCounts)
        .sort((a, b) => b.count - a.count)
        .map(book => `
          <div class="import-book-item">
            <div>
              <div class="import-book-title">${this.escapeHtml(book.title)}</div>
              ${book.author ? `<div class="import-book-author">${this.escapeHtml(book.author)}</div>` : ''}
            </div>
            <span class="import-book-count">${book.count}</span>
          </div>
        `).join('');

      document.getElementById('kindle-import-preview').classList.remove('hidden');
      document.getElementById('kindle-import-footer').classList.remove('hidden');

    } catch (error) {
      console.error('Error parsing Kindle file:', error);
      alert('Error reading the file. Please try again.');
      dropzone.classList.remove('processing');
    }
  }

  parseMyClippings(content) {
    // Split by the Kindle clipping delimiter
    const clippings = content.split('==========').filter(c => c.trim());
    const highlights = [];

    for (const clipping of clippings) {
      const lines = clipping.trim().split('\n').filter(l => l.trim());
      if (lines.length < 3) continue;

      // First line: Book Title (Author)
      const titleLine = lines[0].trim();
      let title = titleLine;
      let author = null;

      // Extract author from parentheses at the end
      const authorMatch = titleLine.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (authorMatch) {
        title = authorMatch[1].trim();
        author = authorMatch[2].trim();
      }

      // Second line: metadata (type, location, date)
      const metaLine = lines[1].trim();

      // Check if this is a highlight (not a bookmark or note)
      if (!metaLine.toLowerCase().includes('highlight')) {
        continue; // Skip bookmarks and notes
      }

      // Extract date from metadata line
      let addedAt = null;
      const dateMatch = metaLine.match(/Added on (.+)$/i);
      if (dateMatch) {
        try {
          addedAt = new Date(dateMatch[1]).toISOString();
        } catch (e) {
          // Ignore date parsing errors
        }
      }

      // Remaining lines are the highlight text
      const highlightText = lines.slice(2).join('\n').trim();

      if (!highlightText) continue;

      highlights.push({
        title,
        author,
        highlight: highlightText,
        addedAt,
      });
    }

    return highlights;
  }

  async confirmKindleImport() {
    if (!this.pendingKindleImport || this.pendingKindleImport.length === 0) {
      this.hideKindleImportModal();
      return;
    }

    const confirmBtn = document.getElementById('kindle-confirm-btn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Importing...';

    try {
      // Prepare saves for batch insert
      const saves = this.pendingKindleImport.map(h => ({
        user_id: this.user.id,
        title: h.title,
        author: h.author,
        highlight: h.highlight,
        site_name: 'Kindle',
        source: 'kindle',
        created_at: h.addedAt || new Date().toISOString(),
      }));

      // Insert in batches of 50 to avoid request size limits
      const batchSize = 50;
      for (let i = 0; i < saves.length; i += batchSize) {
        const batch = saves.slice(i, i + batchSize);
        const { error } = await this.supabase.from('saves').insert(batch);
        if (error) throw error;
      }

      // Success - close modal and refresh
      this.hideKindleImportModal();
      this.loadSaves();

      alert(`Successfully imported ${saves.length} highlights!`);

    } catch (error) {
      console.error('Error importing highlights:', error);
      alert('Error importing highlights. Please try again.');
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Import Highlights';
    }
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
}

// Initialize app
const app = new StashApp();
