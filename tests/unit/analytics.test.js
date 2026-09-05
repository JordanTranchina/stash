/**
 * Unit tests for web/analytics.js — specifically that capture() always
 * leaves a console.info breadcrumb (picked up by logbuffer.js's "Recent
 * logs" ring buffer for bug reports), independent of whether PostHog is
 * actually configured. See issue #107: a bug report filed right after
 * signing in / loading the saves list / opening an article had no record
 * of any of it because nothing logged those events at all.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadStashAnalytics() {
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', 'web', 'analytics.js'),
    'utf8'
  );
  const infoCalls = [];
  const fetchCalls = [];
  const sandbox = {
    self: {},
    console: { info: (...a) => infoCalls.push(a) },
    fetch: (url, opts) => { fetchCalls.push({ url, opts }); return Promise.resolve(); },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { StashAnalytics: sandbox.self.StashAnalytics, infoCalls, fetchCalls };
}

describe('StashAnalytics.capture', () => {
  test('logs a breadcrumb via console.info even when PostHog is not configured', () => {
    const { StashAnalytics, infoCalls, fetchCalls } = loadStashAnalytics();
    StashAnalytics.capture('signed_in');
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0][0]).toBe('[event] signed_in');
    // No API key was ever set via init() — capture() must not try to POST.
    expect(fetchCalls).toHaveLength(0);
  });

  test('logs the breadcrumb AND posts to PostHog once configured', () => {
    const { StashAnalytics, infoCalls, fetchCalls } = loadStashAnalytics();
    StashAnalytics.init('phc_test', 'https://us.i.posthog.com', 'user-1');
    StashAnalytics.capture('saves_loaded', { view: 'all', total: 42 });

    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0][0]).toBe('[event] saves_loaded');
    expect(infoCalls[0][1]).toEqual({ view: 'all', total: 42 });

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.event).toBe('saves_loaded');
    expect(body.distinct_id).toBe('user-1');
  });
});
