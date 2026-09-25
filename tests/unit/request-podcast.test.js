"use strict";

// ---------------------------------------------------------------------------
// evaluateRateLimit mirrored from supabase/functions/request-podcast/index.ts
// (Deno edge function; tested in Node/Jest by duplicating the pure helper —
// keep this in sync with the original).
// ---------------------------------------------------------------------------

const WINDOW_MS = 24 * 60 * 60 * 1000;

function evaluateRateLimit(createdAtIso, nowMs, limit, windowMs = WINDOW_MS) {
  const inWindow = createdAtIso
    .map((s) => Date.parse(s))
    .filter((t) => Number.isFinite(t) && nowMs - t < windowMs)
    .sort((a, b) => a - b);

  const used = inWindow.length;
  const allowed = used < limit;
  const remaining = Math.max(0, limit - used - (allowed ? 1 : 0));

  let retryAfterSeconds = 0;
  if (!allowed && inWindow.length > 0) {
    retryAfterSeconds = Math.max(1, Math.ceil((inWindow[0] + windowMs - nowMs) / 1000));
  }

  return { allowed, used, limit, remaining, retryAfterSeconds };
}

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

describe("evaluateRateLimit", () => {
  test("allows the first request when the ledger is empty", () => {
    const v = evaluateRateLimit([], NOW, 3);
    expect(v.allowed).toBe(true);
    expect(v.used).toBe(0);
    expect(v.remaining).toBe(2); // this request consumes one of the three
    expect(v.retryAfterSeconds).toBe(0);
  });

  test("counts down remaining as requests accumulate", () => {
    expect(evaluateRateLimit([hoursAgo(1)], NOW, 3).remaining).toBe(1);
    expect(evaluateRateLimit([hoursAgo(1), hoursAgo(2)], NOW, 3).remaining).toBe(0);
  });

  test("blocks once the limit is reached and reports when a slot frees up", () => {
    const rows = [hoursAgo(20), hoursAgo(5), hoursAgo(1)];
    const v = evaluateRateLimit(rows, NOW, 3);
    expect(v.allowed).toBe(false);
    expect(v.used).toBe(3);
    expect(v.remaining).toBe(0);
    // Oldest is 20h old; a slot opens in ~4h.
    expect(v.retryAfterSeconds).toBe(4 * 3600);
  });

  test("ignores requests older than the rolling window", () => {
    const rows = [hoursAgo(30), hoursAgo(26), hoursAgo(2)];
    const v = evaluateRateLimit(rows, NOW, 3);
    expect(v.used).toBe(1);
    expect(v.allowed).toBe(true);
  });

  test("a request exactly at the window edge has aged out", () => {
    const v = evaluateRateLimit([new Date(NOW - WINDOW_MS).toISOString()], NOW, 1);
    expect(v.used).toBe(0);
    expect(v.allowed).toBe(true);
  });

  test("discards unparseable timestamps rather than counting them", () => {
    const v = evaluateRateLimit(["not-a-date", hoursAgo(1)], NOW, 3);
    expect(v.used).toBe(1);
  });

  test("limit of 1 blocks the second request within the window", () => {
    const v = evaluateRateLimit([hoursAgo(3)], NOW, 1);
    expect(v.allowed).toBe(false);
    expect(v.retryAfterSeconds).toBe(21 * 3600);
  });
});

// ---------------------------------------------------------------------------
// normalizeSaveIds mirrored from supabase/functions/request-podcast/index.ts
// (custom blended episode, #133 — keep in sync with the original).
// ---------------------------------------------------------------------------

const MIN_CUSTOM_SAVES = 2;
const MAX_CUSTOM_SAVES = 8;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeSaveIds(input) {
  if (input === undefined || input === null) return { ids: [] };
  if (!Array.isArray(input)) return { error: "saveIds must be an array of save ids" };

  const ids = [];
  for (const raw of input) {
    if (typeof raw !== "string" || !UUID_RE.test(raw.trim())) {
      return { error: "saveIds contains an invalid save id" };
    }
    const id = raw.trim().toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }

  if (ids.length === 0) return { ids };
  if (ids.length < MIN_CUSTOM_SAVES) {
    return { error: `Pick at least ${MIN_CUSTOM_SAVES} saves for a custom episode` };
  }
  if (ids.length > MAX_CUSTOM_SAVES) {
    return { error: `Pick at most ${MAX_CUSTOM_SAVES} saves for a custom episode` };
  }
  return { ids };
}

const uuid = (n) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

describe("normalizeSaveIds", () => {
  test("no saveIds means a normal episode", () => {
    expect(normalizeSaveIds(undefined)).toEqual({ ids: [] });
    expect(normalizeSaveIds(null)).toEqual({ ids: [] });
    expect(normalizeSaveIds([])).toEqual({ ids: [] });
  });

  test("trims, lowercases and de-duplicates", () => {
    const a = "AAAAAAAA-0000-0000-0000-000000000000";
    expect(normalizeSaveIds([` ${a}`, uuid(1), a.toLowerCase()])).toEqual({
      ids: [a.toLowerCase(), uuid(1)],
    });
  });

  test("rejects a non-array and invalid ids", () => {
    expect(normalizeSaveIds("abc")).toHaveProperty("error");
    expect(normalizeSaveIds([uuid(1), "1),or(x"])).toHaveProperty("error");
    expect(normalizeSaveIds([uuid(1), 42])).toHaveProperty("error");
  });

  test("enforces the min and max number of saves", () => {
    expect(normalizeSaveIds([uuid(1)]).error).toMatch(/at least 2/);
    const nine = Array.from({ length: 9 }, (_, i) => uuid(i));
    expect(normalizeSaveIds(nine).error).toMatch(/at most 8/);
    expect(normalizeSaveIds(nine.slice(0, 8)).ids).toHaveLength(8);
  });
});
