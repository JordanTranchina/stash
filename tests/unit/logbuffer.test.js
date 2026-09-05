/**
 * Unit tests for web/logbuffer.js — the in-memory console ring buffer + last
 * error capture that the "Report a bug" flow attaches to a report.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadStashLog() {
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', 'web', 'logbuffer.js'),
    'utf8'
  );
  const calls = [];
  const console = {
    log: (...a) => calls.push(['log', a]),
    info: (...a) => calls.push(['info', a]),
    warn: (...a) => calls.push(['warn', a]),
    error: (...a) => calls.push(['error', a]),
  };
  const sandbox = {
    self: {
      navigator: { userAgent: 'test-agent', language: 'en-US', onLine: true },
      location: { href: 'https://stash.example/app' },
      screen: { width: 1440, height: 900 },
      STASH_VERSION: { build: 42, commit: 'abc1234' },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { StashLog: sandbox.self.StashLog, sandbox, passthrough: calls };
}

// parseUserAgent is stateless — load once and reuse across cases.
const StashLogFn = loadStashLog().StashLog.parseUserAgent;

describe('StashLog ring buffer', () => {
  test('captures console output in order and still forwards to the real console', () => {
    const { StashLog, sandbox, passthrough } = loadStashLog();
    sandbox.console.log('hello');
    sandbox.console.warn('careful');
    sandbox.console.error('boom');

    const logs = StashLog.getLogs();
    expect(logs.map((l) => l.level)).toEqual(['log', 'warn', 'error']);
    expect(logs.map((l) => l.msg)).toEqual(['hello', 'careful', 'boom']);
    expect(logs[0].t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // original console still invoked
    expect(passthrough).toHaveLength(3);
  });

  test('caps the buffer at 200 entries, dropping the oldest', () => {
    const { StashLog, sandbox } = loadStashLog();
    for (let i = 0; i < 250; i++) sandbox.console.log('line ' + i);
    const logs = StashLog.getLogs();
    expect(logs).toHaveLength(200);
    expect(logs[0].msg).toBe('line 50');
    expect(logs[199].msg).toBe('line 249');
  });

  test('getLogs returns a copy — callers cannot mutate the buffer', () => {
    const { StashLog, sandbox } = loadStashLog();
    sandbox.console.log('one');
    StashLog.getLogs().push({ level: 'log', msg: 'injected' });
    expect(StashLog.getLogs()).toHaveLength(1);
  });
});

describe('StashLog.redact', () => {
  test('strips bearer tokens, api keys, and JWTs from log lines', () => {
    const { StashLog, sandbox } = loadStashLog();
    sandbox.console.log('req Authorization: Bearer eyJhbGciOiJI.payload.signature done');
    sandbox.console.error('apikey=sb_publishable_ABCDEF12345 refresh_token: "r0token"');

    const joined = StashLog.getLogs().map((l) => l.msg).join('\n');
    expect(joined).not.toMatch(/eyJhbGciOiJI/);
    expect(joined).not.toMatch(/sb_publishable_ABCDEF12345/);
    expect(joined).not.toMatch(/r0token/);
    expect(joined).toContain('[redacted]');
  });

  test('redact() is exposed for callers that build their own payloads', () => {
    const { StashLog } = loadStashLog();
    expect(StashLog.redact('Bearer abc.def.ghi')).toBe('Bearer [redacted]');
  });
});

describe('StashLog.noteError / getEnv', () => {
  test('noteError records a redacted message + stack', () => {
    const { StashLog } = loadStashLog();
    StashLog.noteError('failed with Bearer secrettoken', 'at foo (app.js:1)', 'archive');
    const le = StashLog.getLastError();
    expect(le.message).toBe('failed with Bearer [redacted]');
    expect(le.source).toBe('archive');
    expect(le.stack).toContain('app.js:1');
  });

  test('every console.error() call also populates getLastError(), not just explicit noteError() call sites', () => {
    const { StashLog, sandbox } = loadStashLog();
    expect(StashLog.getLastError()).toBeNull();

    // The common shape in app.js: a handled Supabase { error } result logged
    // via console.error, with no throw and so no window 'error'/
    // 'unhandledrejection' event to catch it (issue #107).
    sandbox.console.error('Error loading saves:', { message: 'column word_count does not exist' });

    const le = StashLog.getLastError();
    expect(le.source).toBe('console.error');
    expect(le.message).toContain('Error loading saves:');
  });

  test('console.error with an Error object captures its stack', () => {
    const { StashLog, sandbox } = loadStashLog();
    // Built inside the sandbox's own realm so `instanceof Error` (checked in
    // logbuffer.js against that realm's Error) actually matches — a host
    // Error wouldn't.
    vm.runInContext('console.error("Unhandled:", new Error("boom"))', sandbox);
    const le = StashLog.getLastError();
    expect(le.stack).toContain('Error: boom');
  });

  test('getEnv snapshots version, url, UA and the passed view', () => {
    const { StashLog } = loadStashLog();
    const env = StashLog.getEnv('podcasts');
    expect(env).toMatchObject({
      version: { build: 42, commit: 'abc1234' },
      url: 'https://stash.example/app',
      userAgent: 'test-agent',
      view: 'podcasts',
    });
  });
});

describe('StashLog.parseUserAgent', () => {
  test('desktop Chrome on macOS', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    expect(StashLogFn(ua)).toEqual({
      isMobile: false,
      os: 'macOS 10.15',
      browser: 'Chrome 126',
      device: 'unknown',
    });
  });

  test('iPhone Safari', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const parsed = StashLogFn(ua);
    expect(parsed.isMobile).toBe(true);
    expect(parsed.os).toBe('iOS 17.5');
    expect(parsed.device).toBe('iPhone');
    expect(parsed.browser).toBe('Safari 17');
  });

  test('Android Chrome reports a device model', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
    const parsed = StashLogFn(ua);
    expect(parsed.isMobile).toBe(true);
    expect(parsed.os).toBe('Android 14');
    expect(parsed.device).toBe('Pixel 8');
    expect(parsed.browser).toBe('Chrome 125');
  });
});
