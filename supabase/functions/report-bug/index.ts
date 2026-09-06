import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { reportError } from "../_shared/sentry.ts";

// In-app "Report a bug" endpoint. The web app and the browser extension POST a
// multipart form here; this function verifies the caller's JWT, stores any
// screenshot / video / file attachments in the public `bug-attachments` Storage
// bucket, and opens a GitHub issue that mirrors .github/ISSUE_TEMPLATE/bug_report.md
// (keep the buildIssueBody sections below in sync with that template).
//
// The end user never touches GitHub — the issue is created with a repo-scoped
// token held as a function secret. Required secrets:
//   GITHUB_TOKEN  fine-grained PAT, single repo, Issues: read and write
//   GITHUB_REPO   "owner/repo"
// GitHub failures return 502 so the client keeps the report queued for retry.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "bug-attachments";
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB — matches GitHub's own cap
const MAX_TEXT = 5000; // per free-text field, before it goes into the issue body

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clip(value: unknown, max = MAX_TEXT): string {
  const s = (value == null ? "" : String(value)).trim();
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}

// Keep a storage key filesystem-safe; the unguessable part is the UUID segment.
function safeName(name: string): string {
  const cleaned = (name || "file").replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(-80) || "file";
}

// Parse a browser UA into the fields bug_report.md's Desktop / Smartphone
// blocks ask for. Best-effort — an unknown UA just yields "unknown".
function parseUserAgent(ua: string) {
  const s = ua || "";
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(s);

  let os = "unknown";
  let osMatch;
  if ((osMatch = s.match(/iPhone OS (\d+[_.]\d+)/))) os = "iOS " + osMatch[1].replace(/_/g, ".");
  else if ((osMatch = s.match(/CPU OS (\d+[_.]\d+)/))) os = "iPadOS " + osMatch[1].replace(/_/g, ".");
  else if ((osMatch = s.match(/Android (\d+(?:\.\d+)?)/))) os = "Android " + osMatch[1];
  else if (/Windows NT 10/.test(s)) os = "Windows 10/11";
  else if ((osMatch = s.match(/Mac OS X (\d+[_.]\d+)/))) os = "macOS " + osMatch[1].replace(/_/g, ".");
  else if (/Windows/.test(s)) os = "Windows";
  else if (/Mac OS X/.test(s)) os = "macOS";
  else if (/Linux/.test(s)) os = "Linux";

  let browser = "unknown";
  let bMatch;
  if ((bMatch = s.match(/Edg\/(\d+)/))) browser = "Edge " + bMatch[1];
  else if ((bMatch = s.match(/OPR\/(\d+)/))) browser = "Opera " + bMatch[1];
  else if ((bMatch = s.match(/Firefox\/(\d+)/))) browser = "Firefox " + bMatch[1];
  else if (/CriOS\/(\d+)/.test(s)) browser = "Chrome " + s.match(/CriOS\/(\d+)/)![1];
  else if ((bMatch = s.match(/Chrome\/(\d+)/))) browser = "Chrome " + bMatch[1];
  else if (/Safari/.test(s)) browser = (bMatch = s.match(/Version\/(\d+)/)) ? "Safari " + bMatch[1] : "Safari";

  let device = "unknown";
  if (/iPhone/.test(s)) device = "iPhone";
  else if (/iPad/.test(s)) device = "iPad";
  else if ((bMatch = s.match(/;\s?([^;)]+)\sBuild\//))) device = bMatch[1].trim();

  return { isMobile, os, browser, device };
}

interface ReportInput {
  description: string;
  steps: string;
  expected: string;
  observed: string;
  email: string;
  userId?: string;
  source: string;
  env: Record<string, unknown>;
  logs: Array<{ t?: string; level?: string; msg?: string }>;
  lastError: { message?: string; stack?: string; source?: string; t?: string } | null;
  attachments: Array<{ url: string; name: string; isVideo: boolean }>;
}

// Build a GitHub issue body matching .github/ISSUE_TEMPLATE/bug_report.md.
function buildIssueBody(input: ReportInput): string {
  const env = input.env || {};
  const ua = String(env.userAgent || "");
  const { isMobile, os, browser, device } = parseUserAgent(ua);
  const version = env.version && typeof env.version === "object"
    ? `build ${(env.version as any).build ?? "?"} (${(env.version as any).commit ?? "?"})`
    : String(env.version || "unknown");

  const images = input.attachments.filter((a) => !a.isVideo);
  const videos = input.attachments.filter((a) => a.isVideo);
  const screenshotBlock = input.attachments.length
    ? [
        ...images.map((a) => `![${a.name}](${a.url})`),
        ...videos.map((a) => `[${a.name} (video)](${a.url})`),
      ].join("\n\n")
    : "_None provided._";

  const desktop = isMobile
    ? " - OS: N/A\n - Browser: N/A\n - Version: N/A"
    : ` - OS: ${os}\n - Browser: ${browser.replace(/ \d+$/, "")}\n - Version: ${browser.match(/\d+$/)?.[0] || "unknown"}`;
  const phone = isMobile
    ? ` - Device: ${device}\n - OS: ${os}\n - Browser: ${browser.replace(/ \d+$/, "")}\n - Version: ${browser.match(/\d+$/)?.[0] || "unknown"}`
    : " - Device: N/A\n - OS: N/A\n - Browser: N/A\n - Version: N/A";

  const logLines = (input.logs || [])
    .slice(-200)
    .map((l) => `${l.t || ""} [${l.level || "log"}] ${l.msg || ""}`.trim())
    .join("\n");
  const lastErr = input.lastError
    ? `${input.lastError.message || ""}\n${input.lastError.stack || ""}`.trim()
    : "";

  const userTag = input.userId ? ` (user ID: \`${input.userId}\`)` : "";
  const reporter = `_Reported by ${input.email || "unknown"}${userTag} · ${input.source || "web"} · ${new Date().toISOString()}_`;

  return [
    reporter,
    "",
    "**Describe the bug**",
    input.description || "_No description provided._",
    "",
    "**To Reproduce**",
    input.steps || "_Not provided._",
    "",
    "**Expected**",
    input.expected || "_Not provided._",
    "",
    "**Observed**",
    input.observed || "_Not provided._",
    "",
    "**Screenshots**",
    screenshotBlock,
    "",
    "**Desktop (please complete the following information):**",
    desktop,
    "",
    "**Smartphone (please complete the following information):**",
    phone,
    "",
    "**Additional context**",
    `Stash ${version} · ${env.url || "unknown"} · view: ${env.view || "unknown"}`,
    "",
    "<details><summary>Recent logs</summary>",
    "",
    "```",
    logLines || "(none captured)",
    "```",
    "</details>",
    "",
    "<details><summary>Last error</summary>",
    "",
    "```",
    lastErr || "(none captured)",
    "```",
    "</details>",
  ].join("\n");
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
      return json({ error: "Bug reporting is not configured (missing GITHUB_TOKEN / GITHUB_REPO)" }, 500);
    }

    const form = await req.formData();
    const description = clip(form.get("description"));
    if (!description) return json({ error: "description required" }, 400);

    const parseJson = (key: string, fallback: unknown) => {
      try {
        const raw = form.get(key);
        return raw ? JSON.parse(String(raw)) : fallback;
      } catch {
        return fallback;
      }
    };

    const source = clip(form.get("source"), 20) || "web";
    const env = parseJson("env", {}) as Record<string, unknown>;
    const logs = parseJson("logs", []) as ReportInput["logs"];
    const lastError = parseJson("lastError", null) as ReportInput["lastError"];

    // Service-role client for Storage uploads. The row/objects are namespaced
    // under the JWT-derived user id, so bypassing RLS here doesn't widen access.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const files = form.getAll("attachments").filter((f): f is File => f instanceof File);
    const uploaded: ReportInput["attachments"] = [];
    for (const file of files.slice(0, MAX_ATTACHMENTS)) {
      if (!file.size || file.size > MAX_ATTACHMENT_BYTES) continue;
      const key = `${user.id}/${crypto.randomUUID()}/${safeName(file.name)}`;
      const { error: upErr } = await admin.storage.from(BUCKET).upload(key, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (upErr) {
        console.error("attachment upload failed:", upErr.message);
        continue;
      }
      const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(key);
      uploaded.push({
        url: pub.publicUrl,
        name: safeName(file.name),
        isVideo: (file.type || "").startsWith("video/"),
      });
    }

    const input: ReportInput = {
      description,
      steps: clip(form.get("steps")),
      expected: clip(form.get("expected")),
      observed: clip(form.get("observed")),
      email: clip(form.get("email"), 200) || user.email || "unknown",
      userId: user.id || clip(form.get("userId"), 100) || "",
      source,
      env,
      logs,
      lastError,
      attachments: uploaded,
    };

    const titleSummary = description.split("\n")[0].slice(0, 100);
    const issueRes = await fetch(`https://api.github.com/repos/${githubRepo}/issues`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${githubToken}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "stash-bug-reporter",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `[Bug]: ${titleSummary}`,
        body: buildIssueBody(input),
        labels: ["bug", "user-report", `source:${source}`],
      }),
    });

    if (!issueRes.ok) {
      const detail = await issueRes.text();
      console.error("GitHub issue create failed:", issueRes.status, detail);
      // 502: the report is valid, GitHub just didn't take it — client requeues.
      return json({ error: "Could not file the issue upstream", status: issueRes.status }, 502);
    }

    const issue = await issueRes.json();
    return json({ success: true, url: issue.html_url, number: issue.number });
  } catch (err) {
    await reportError(err, "report-bug");
    return json({ error: (err as Error).message }, 500);
  }
});
