/**
 * Unit tests for extension/supabase.js
 *
 * Tests the session storage, JWT user parsing, user healing, and session state
 * handling for Google sign-in and password auth flows.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createMockToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = Buffer.from('mock-signature').toString('base64');
  return `${header}.${body}.${sig}`;
}

function loadSupabaseClient(storageData = {}) {
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', 'extension', 'supabase.js'),
    'utf8'
  );

  let storage = { ...storageData };
  const mockStorage = {
    local: {
      get: jest.fn(async (keys) => {
        if (Array.isArray(keys)) {
          const res = {};
          keys.forEach(k => { if (k in storage) res[k] = storage[k]; });
          return res;
        }
        return { ...storage };
      }),
      set: jest.fn(async (items) => {
        Object.assign(storage, items);
      }),
      remove: jest.fn(async (keys) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        keyList.forEach(k => delete storage[k]);
      }),
    },
  };

  const sandbox = {
    chrome: {
      storage: mockStorage,
      identity: {
        getRedirectURL: jest.fn(() => 'https://mockextid.chromiumapp.org/'),
        launchWebAuthFlow: jest.fn(),
      },
      runtime: {
        lastError: null,
      },
    },
    fetch: jest.fn(),
    atob: (str) => Buffer.from(str, 'base64').toString('binary'),
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    decodeURIComponent,
    encodeURIComponent,
    console,
    Date,
    Math,
    URLSearchParams,
  };

  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.SupabaseClient = SupabaseClient;\nthis.parseJwtPayload = parseJwtPayload;\nthis.userFromToken = userFromToken;', sandbox);

  return {
    SupabaseClient: sandbox.SupabaseClient,
    parseJwtPayload: sandbox.parseJwtPayload,
    userFromToken: sandbox.userFromToken,
    sandbox,
    storage,
  };
}

describe('JWT decoding helpers', () => {
  const { parseJwtPayload, userFromToken } = loadSupabaseClient();

  test('parseJwtPayload extracts JSON payload from valid token', () => {
    const token = createMockToken({ sub: 'user-123', email: 'test@example.com' });
    const payload = parseJwtPayload(token);
    expect(payload).toEqual({ sub: 'user-123', email: 'test@example.com' });
  });

  test('parseJwtPayload returns null on malformed token', () => {
    expect(parseJwtPayload('not-a-jwt')).toBeNull();
    expect(parseJwtPayload('')).toBeNull();
  });

  test('userFromToken extracts id, email, and metadata', () => {
    const token = createMockToken({
      sub: 'google-user-456',
      email: 'google@gmail.com',
      user_metadata: { full_name: 'Test User' },
    });
    const user = userFromToken(token);
    expect(user).toEqual({
      id: 'google-user-456',
      email: 'google@gmail.com',
      user_metadata: { full_name: 'Test User' },
      app_metadata: {},
    });
  });

  test('userFromToken returns null if sub claim is missing', () => {
    const token = createMockToken({ email: 'no-sub@gmail.com' });
    expect(userFromToken(token)).toBeNull();
  });
});

describe('SupabaseClient session and user persistence', () => {
  test('storeSession saves user and userId getter returns user id', async () => {
    const { SupabaseClient, sandbox } = loadSupabaseClient();
    const client = new SupabaseClient('https://example.supabase.co', 'anon-key');

    const token = createMockToken({ sub: 'user-abc', email: 'user@example.com' });
    await client.storeSession({
      access_token: token,
      refresh_token: 'ref-1',
      user: { id: 'user-abc', email: 'user@example.com' },
    });

    expect(client.userId).toBe('user-abc');
    expect(client.session.user).toEqual({ id: 'user-abc', email: 'user@example.com' });
    expect(sandbox.chrome.storage.local.set).toHaveBeenCalledWith({
      stash_session: expect.objectContaining({
        access_token: token,
        user: { id: 'user-abc', email: 'user@example.com' },
      }),
    });
  });

  test('storeSession automatically extracts user from access_token if user was not passed', async () => {
    const { SupabaseClient } = loadSupabaseClient();
    const client = new SupabaseClient('https://example.supabase.co', 'anon-key');

    const token = createMockToken({ sub: 'auto-user-id', email: 'auto@example.com' });
    await client.storeSession({
      access_token: token,
      refresh_token: 'ref-1',
    });

    expect(client.userId).toBe('auto-user-id');
    expect(client.session.user.id).toBe('auto-user-id');
    expect(client.session.user.email).toBe('auto@example.com');
  });

  test('storeSession preserves existing user on token refresh if response has no user', async () => {
    const { SupabaseClient } = loadSupabaseClient();
    const client = new SupabaseClient('https://example.supabase.co', 'anon-key');

    const token1 = createMockToken({ sub: 'user-orig', email: 'orig@example.com' });
    await client.storeSession({
      access_token: token1,
      refresh_token: 'ref-1',
      user: { id: 'user-orig', email: 'orig@example.com', full_profile: true },
    });

    const token2 = createMockToken({ sub: 'user-orig', email: 'orig@example.com' });
    await client.storeSession({
      access_token: token2,
      refresh_token: 'ref-2',
    });

    expect(client.userId).toBe('user-orig');
    expect(client.session.user.full_profile).toBe(true);
  });

  test('init heals session if stored session has access_token but missing user', async () => {
    const token = createMockToken({ sub: 'healed-user-999', email: 'healed@example.com' });
    const legacySession = {
      access_token: token,
      refresh_token: 'ref-legacy',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };

    const { SupabaseClient, sandbox } = loadSupabaseClient({ stash_session: legacySession });
    const client = new SupabaseClient('https://example.supabase.co', 'anon-key');

    await client.init();

    expect(client.userId).toBe('healed-user-999');
    expect(client.session.user).toBeDefined();
    expect(client.session.user.id).toBe('healed-user-999');
    expect(client.session.user.email).toBe('healed@example.com');
    expect(sandbox.chrome.storage.local.set).toHaveBeenCalledWith({
      stash_session: expect.objectContaining({
        user: expect.objectContaining({ id: 'healed-user-999' }),
      }),
    });
  });

  test('getUser updates this.session.user and persists to storage', async () => {
    const token = createMockToken({ sub: 'user-x', email: 'x@example.com' });
    const { SupabaseClient, sandbox } = loadSupabaseClient();
    const client = new SupabaseClient('https://example.supabase.co', 'anon-key');

    await client.storeSession({
      access_token: token,
      refresh_token: 'ref-1',
    });

    sandbox.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'user-x',
        email: 'x@example.com',
        user_metadata: { name: 'Full Profile' },
      }),
    });

    const user = await client.getUser();
    expect(user.id).toBe('user-x');
    expect(client.session.user.user_metadata.name).toBe('Full Profile');
    expect(sandbox.chrome.storage.local.set).toHaveBeenCalledWith({
      stash_session: expect.objectContaining({
        user: expect.objectContaining({
          user_metadata: { name: 'Full Profile' },
        }),
      }),
    });
  });

  test('signInWithGoogle flow stores user, populates userId, and satisfies signed-in check', async () => {
    const { SupabaseClient, sandbox } = loadSupabaseClient();
    const client = new SupabaseClient('https://example.supabase.co', 'anon-key');

    const mockAccessToken = createMockToken({ sub: 'google-user-777', email: 'guser@gmail.com' });
    const mockCallbackUrl = `https://mockextid.chromiumapp.org/#access_token=${mockAccessToken}&refresh_token=ref-g-123&expires_in=3600&token_type=bearer`;

    sandbox.chrome.identity.launchWebAuthFlow.mockImplementation((opts, callback) => {
      callback(mockCallbackUrl);
    });

    sandbox.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'google-user-777',
        email: 'guser@gmail.com',
      }),
    });

    await client.signInWithGoogle();

    // After sign-in, userId must NOT be null
    expect(client.userId).toBe('google-user-777');
    expect(client.accessToken).toBe(mockAccessToken);

    // Background updateActionForSession check:
    const token = await client.getAccessToken();
    const signedIn = Boolean(token && client.userId);
    expect(signedIn).toBe(true);

    // Background requireUserId check:
    expect(client.userId).toBeTruthy();
  });
});
