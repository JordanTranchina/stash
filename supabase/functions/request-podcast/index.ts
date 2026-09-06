import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { reportError } from "../_shared/sentry.ts";

// In-app "Make an episode now" endpoint. The Podcasts tab POSTs here; this
// function verifies the caller's JWT, enforces a per-user on-demand rate limit
// off the `podcast_generation_requests` ledger, and — if there's budget left —
// triggers the daily podcast GitHub Actions workflow (podcast.yml) scoped to
// just that user via workflow_dispatch.
//
// The end user never touches GitHub — the workflow is dispatched with a
// repo-scoped token held as a function secret. Required secrets:
//   GITHUB_TOKEN         fine-grained PAT, single repo, Actions: read and write
//   GITHUB_REPO          "owner/repo"
// Optional:
//   GITHUB_WORKFLOW_REF  git ref the workflow runs on (default "main")
//   PODCAST_ONDEMAND_LIMIT  max accepted requests per rolling 24h (default 3)
//
// The same GITHUB_TOKEN as report-bug can be reused — it just needs the
// "Actions: read and write" permission added alongside "Issues: read and write".

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WORKFLOW_FILE = "podcast.yml";
const WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24h
const DEFAULT_LIMIT = 3;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface RateLimitVerdict {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  // Seconds until the oldest request in the window ages out (0 when allowed).
  retryAfterSeconds: number;
}

// Pure rate-limit math, kept separate so it can be unit-tested in Node without
// a Deno runtime (see tests/unit/request-podcast.test.js).
export function evaluateRateLimit(
  createdAtIso: string[],
  nowMs: number,
  limit: number,
  windowMs: number = WINDOW_MS,
): RateLimitVerdict {
  const inWindow = createdAtIso
    .map((s) => Date.parse(s))
    .filter((t) => Number.isFinite(t) && nowMs - t < windowMs)
    .sort((a, b) => a - b);

  const used = inWindow.length;
  const allowed = used < limit;
  const remaining = Math.max(0, limit - used - (allowed ? 1 : 0));

  let retryAfterSeconds = 0;
  if (!allowed && inWindow.length > 0) {
    // Once the oldest in-window request crosses windowMs old, a slot frees up.
    retryAfterSeconds = Math.max(1, Math.ceil((inWindow[0] + windowMs - nowMs) / 1000));
  }

  return { allowed, used, limit, remaining, retryAfterSeconds };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: authData, error: authError } = await authClient.auth.getUser();
    if (authError || !authData?.user) return json({ error: "Invalid or expired token" }, 401);
    const user = authData.user;

    const githubToken = Deno.env.get("GITHUB_TOKEN");
    const githubRepo = Deno.env.get("GITHUB_REPO");
    if (!githubToken || !githubRepo) {
      return json(
        { error: "On-demand podcasts are not configured (missing GITHUB_TOKEN / GITHUB_REPO)" },
        500,
      );
    }
    const workflowRef = Deno.env.get("GITHUB_WORKFLOW_REF") || "main";
    const limit = Math.max(1, parseInt(Deno.env.get("PODCAST_ONDEMAND_LIMIT") || "", 10) || DEFAULT_LIMIT);

    // Service-role client: the ledger has no client write policy, and the
    // count must reflect every user's rows, not just the caller's.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data: recent, error: countErr } = await admin
      .from("podcast_generation_requests")
      .select("created_at")
      .eq("user_id", user.id)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true });

    if (countErr) {
      console.error("rate-limit query failed:", countErr.message);
      return json({ error: "Could not check your podcast quota — try again in a bit" }, 500);
    }

    const verdict = evaluateRateLimit(
      (recent || []).map((r) => r.created_at as string),
      Date.now(),
      limit,
    );

    if (!verdict.allowed) {
      return json(
        {
          error: `You've used all ${limit} on-demand episodes for now. Try again later.`,
          limit,
          used: verdict.used,
          remaining: 0,
          retryAfterSeconds: verdict.retryAfterSeconds,
        },
        429,
      );
    }

    // Reserve the slot first so two rapid taps can't both slip through the
    // check above; if the dispatch fails we delete this row below.
    const { data: inserted, error: insErr } = await admin
      .from("podcast_generation_requests")
      .insert({ user_id: user.id })
      .select("id")
      .single();

    if (insErr || !inserted) {
      console.error("ledger insert failed:", insErr?.message);
      return json({ error: "Could not queue your episode — try again in a bit" }, 500);
    }

    const dispatchRes = await fetch(
      `https://api.github.com/repos/${githubRepo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${githubToken}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "stash-request-podcast",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: workflowRef, inputs: { user_id: user.id } }),
      },
    );

    if (!dispatchRes.ok) {
      const detail = await dispatchRes.text();
      console.error("workflow_dispatch failed:", dispatchRes.status, detail);
      // Roll the slot back so a GitHub hiccup doesn't burn the user's quota.
      await admin.from("podcast_generation_requests").delete().eq("id", inserted.id);
      return json({ error: "Couldn't start the episode upstream — try again shortly", status: dispatchRes.status }, 502);
    }

    await admin
      .from("podcast_generation_requests")
      .update({ workflow_dispatched: true })
      .eq("id", inserted.id);

    return json({ success: true, limit, used: verdict.used + 1, remaining: verdict.remaining });
  } catch (err) {
    await reportError(err, "request-podcast");
    return json({ error: (err as Error).message }, 500);
  }
});
