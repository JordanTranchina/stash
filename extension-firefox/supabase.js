// Minimal Supabase client for Chrome extension
class SupabaseClient {
  constructor(url, anonKey) {
    this.url = url;
    this.anonKey = anonKey;
    this.session = null;
  }

  // Load the stored session from extension storage. Does not refresh; call
  // getAccessToken() (or any DB operation) for a guaranteed-valid token.
  async init() {
    const stored = await chrome.storage.local.get(['stash_session']);
    this.session = stored.stash_session || null;
    return this.session;
  }

  get accessToken() {
    return this.session?.access_token || null;
  }

  // The signed-in user's id, taken from the session Supabase returned.
  // Never hardcoded — no session means no user.
  get userId() {
    return this.session?.user?.id || null;
  }

  get headers() {
    const h = {
      'apikey': this.anonKey,
      'Content-Type': 'application/json',
    };
    if (this.accessToken) {
      h['Authorization'] = `Bearer ${this.accessToken}`;
    }
    return h;
  }

  // Supabase returns expires_at (unix seconds) on token responses, but fall
  // back to expires_in in case it's missing.
  async storeSession(data) {
    const expiresAt = data.expires_at
      || Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
    this.session = { ...data, expires_at: expiresAt };
    await chrome.storage.local.set({ stash_session: this.session });
    return this.session;
  }

  // Treat a token as expired 60s early so an in-flight save doesn't land on
  // the far side of the expiry.
  isExpired() {
    if (!this.session?.expires_at) return true;
    return Date.now() / 1000 >= this.session.expires_at - 60;
  }

  async refreshSession() {
    const refreshToken = this.session?.refresh_token;
    if (!refreshToken) {
      await this.signOut();
      return null;
    }

    const res = await fetch(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'apikey': this.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) {
      // The refresh token is dead (revoked, or the user signed out elsewhere).
      // Drop the session so the popup falls back to the sign-in view.
      await this.signOut();
      return null;
    }

    return await this.storeSession(await res.json());
  }

  // Returns a valid access token, refreshing if needed, or null if signed out.
  async getAccessToken() {
    if (!this.session) await this.init();
    if (!this.session) return null;
    if (this.isExpired()) await this.refreshSession();
    return this.accessToken;
  }

  // Returns { token, userId } or throws the "sign in" error every caller
  // wants to surface verbatim. The message has to match background.js's
  // SIGN_IN_MESSAGE exactly: that string is how savePage/saveHighlight tell a
  // signed-out state (show the sign-in form) apart from a real failure (show
  // an error, report to Sentry). A DB call that expires mid-save surfaces the
  // signed-out state from here rather than from requireUserId().
  async requireSession() {
    const token = await this.getAccessToken();
    if (!token || !this.userId) {
      throw new Error('Sign in to Stash to save');
    }
    return { token, userId: this.userId };
  }

  async signIn(email, password) {
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'apikey': this.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error_description || err.msg || 'Sign in failed');
    }

    return await this.storeSession(await res.json());
  }

  // Runs the Google OAuth flow in a browser-native tab (chrome.identity),
  // since the extension has no page of its own to redirect back to. Supabase
  // returns the tokens directly in the callback URL's fragment (implicit
  // grant) because this request has no PKCE code_challenge attached — there's
  // nowhere in the extension to persist a code verifier between the redirect
  // out and the redirect back.
  async signInWithGoogle() {
    const redirectUrl = chrome.identity.getRedirectURL();
    const authUrl = `${this.url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl)}`;

    const callbackUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        (result) => {
          if (chrome.runtime.lastError || !result) {
            reject(new Error(chrome.runtime.lastError?.message || 'Google sign-in was cancelled'));
            return;
          }
          resolve(result);
        }
      );
    });

    // Tokens (or an error) come back after the # or ?, depending on which
    // leg of the redirect failed.
    const params = new URLSearchParams(callbackUrl.split(/[#?]/).slice(1).join('&'));

    if (params.get('error')) {
      throw new Error(params.get('error_description') || params.get('error'));
    }

    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) {
      throw new Error('Google sign-in did not return a session');
    }

    return await this.storeSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: params.get('expires_in') ? Number(params.get('expires_in')) : undefined,
      token_type: params.get('token_type') || 'bearer',
    });
  }

  async signUp(email, password) {
    const res = await fetch(`${this.url}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'apikey': this.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error_description || err.msg || 'Sign up failed');
    }

    return await res.json();
  }

  async signOut() {
    this.session = null;
    await chrome.storage.local.remove(['stash_session']);
  }

  async getUser() {
    const token = await this.getAccessToken();
    if (!token) return null;

    const res = await fetch(`${this.url}/auth/v1/user`, {
      headers: this.headers,
    });

    if (!res.ok) return null;
    return await res.json();
  }

  // Call a Supabase Edge Function. `body` may be a FormData (multipart, for the
  // bug reporter's attachments) or a plain object (sent as JSON). Returns the
  // parsed JSON response; throws on a non-2xx so callers can queue for retry.
  async callFunction(name, body) {
    await this.requireSession();
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers = {
      'apikey': this.anonKey,
      'Authorization': `Bearer ${this.accessToken}`,
    };
    if (!isForm) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${this.url}/functions/v1/${name}`, {
      method: 'POST',
      headers,
      body: isForm ? body : JSON.stringify(body || {}),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch (e) { /* ignore */ }
      throw new Error(detail || `${name} failed (${res.status})`);
    }
    return res.json();
  }

  // Database operations
  async insert(table, data) {
    await this.requireSession();
    console.log('Supabase insert:', table, 'data keys:', Object.keys(data));
    const res = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...this.headers, 'Prefer': 'return=representation' },
      body: JSON.stringify(data),
    });

    console.log('Supabase response status:', res.status);

    if (!res.ok) {
      const err = await res.json();
      console.error('Supabase insert error:', err);
      throw new Error(err.message || err.error || 'Insert failed');
    }

    const result = await res.json();
    console.log('Supabase insert success:', result);
    return result;
  }

  async select(table, options = {}) {
    await this.requireSession();
    let url = `${this.url}/rest/v1/${table}?select=${options.select || '*'}`;

    if (options.filters) {
      for (const [key, value] of Object.entries(options.filters)) {
        url += `&${key}=eq.${encodeURIComponent(value)}`;
      }
    }

    if (options.order) {
      url += `&order=${options.order}`;
    }

    if (options.limit) {
      url += `&limit=${options.limit}`;
    }

    const res = await fetch(url, { headers: this.headers });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Select failed');
    }

    return await res.json();
  }

  async update(table, id, data) {
    await this.requireSession();
    const res = await fetch(`${this.url}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...this.headers, 'Prefer': 'return=representation' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Update failed');
    }

    return await res.json();
  }

  async delete(table, id) {
    await this.requireSession();
    const res = await fetch(`${this.url}/rest/v1/${table}?id=eq.${id}`, {
      method: 'DELETE',
      headers: this.headers,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Delete failed');
    }

    return true;
  }
}

// Export for use in extension
if (typeof window !== 'undefined') {
  window.SupabaseClient = SupabaseClient;
}
