// Minimal Supabase client for Chrome extension
class SupabaseClient {
  constructor(url, anonKey) {
    this.url = url;
    this.anonKey = anonKey;
    this.accessToken = null;
  }

  async init() {
    const stored = await chrome.storage.local.get(['stash_session']);
    if (stored.stash_session) {
      this.accessToken = stored.stash_session.access_token;
    }
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

    const data = await res.json();
    this.accessToken = data.access_token;
    await chrome.storage.local.set({ stash_session: data });
    return data;
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
    this.accessToken = null;
    await chrome.storage.local.remove(['stash_session']);
  }

  async getUser() {
    if (!this.accessToken) return null;

    const res = await fetch(`${this.url}/auth/v1/user`, {
      headers: this.headers,
    });

    if (!res.ok) return null;
    return await res.json();
  }

  // Database operations
  async insert(table, data) {
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
