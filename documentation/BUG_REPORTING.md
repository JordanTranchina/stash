# In-app bug reporting

Users can report a bug without leaving Stash. A report becomes a GitHub issue in
`JordanTranchina/stash`, formatted to match `.github/ISSUE_TEMPLATE/bug_report.md`.
The reporter never touches GitHub — the issue is created server-side with a
repo-scoped token.

## Pieces

| Where | What |
| :-- | :-- |
| `supabase/functions/report-bug/` | Verifies the caller's JWT, uploads attachments to the `bug-attachments` Storage bucket, creates the GitHub issue. |
| `supabase/migrations/20260831000000_bug_attachments_bucket.sql` | Creates the public-read `bug-attachments` bucket. |
| `web/logbuffer.js` | Wraps `console.*` into a 200-entry ring buffer + captures the last uncaught error. Loaded first in `index.html` / `save.html`. |
| `web/bug-report.js` | `BugReporter` — the modal, auto screenshot (lazy-loads html2canvas), submit, and an IndexedDB retry queue drained on `online` / app open / Background Sync (`sync-bug-reports`). |
| `web/app.js` | Settings entry point, `?report-bug=1` deep link, and a throttled "Something went wrong · Report" toast wired to `window.onerror` / `unhandledrejection` and the archive/undo failure paths. |
| `extension/logbuffer.js` | Same ring buffer, persisted to `chrome.storage.local` (`stash_logs`) so it survives the service worker restarting. |
| `extension/report.html` / `report.js` / `report.css` | Standalone reporter page, opened by `background.js` after it stashes a `chrome.tabs.captureVisibleTab` screenshot + logs + env under `stash_pending_bug`. |
| `extension/background.js` | `report-bug` context menu, `reportBug` / `submitBugReport` messages, `SupabaseClient.callFunction('report-bug', formData)`. |
| `extension/content.js` | Save-failure toast grows a **Report** button. |

## Setup

See `documentation/CLOUD_DEPLOYMENT.md` → "`report-bug` function": set the
`GITHUB_TOKEN` and `GITHUB_REPO` Edge Function secrets, apply the bucket
migration, `supabase functions deploy report-bug`.

## Two-click path

1. On an error, a toast shows **Report** → opens the reporter with the screenshot
   and logs already attached, "Observed" prefilled from the error.
2. **Submit**.

The description is the only required field; steps / expected / observed are behind
a "More detail" toggle.

## TODO: podcast channel

Not built yet. `podcast/script.py` `build_description()` is the single place both
the RSS/DB HTML description and the MP3 comment text are assembled (no footer
today). Add a module-level constant and append to **both** `return` sites:

- HTML: `<p>Found a problem with this episode? <a href="{WEB_APP_URL}/?report-bug=1">Report a bug</a>.</p>`
- text: `Report a bug: {WEB_APP_URL}/?report-bug=1`

`WEB_APP_URL` is already in the podcast env/config surface. The `?report-bug=1`
handler exists in `web/app.js`, so this is a few lines plus a `build_description`
test update.
