# Privacy Policy — Stash Browser Extension

_Last updated: 2026-09-03_

Stash is a self-hosted read-it-later app. This policy covers the Chrome and
Firefox browser extensions only.

## What the extension does

When you save a page, the extension reads that page's content in your browser
(via [Mozilla Readability](https://github.com/mozilla/readability)) and sends
the page's URL, title, and extracted text to the Stash instance you signed in
to. That instance is a Supabase project — either the maintainer's hosted
instance or one you deployed yourself; see `documentation/SETUP.md`.

The extension does not:

- Read or store pages you have not explicitly saved.
- Sell, share, or transfer your data to any third party for advertising or
  unrelated purposes.
- Track your browsing history. `host_permissions: ["<all_urls>"]` is used only
  so the "Save" action and right-click context menu work on any site you
  choose to save from — the extension takes no action on a page until you
  click Save.

## What is collected, and where it goes

| Data | Where it goes | Why |
|---|---|---|
| Page URL, title, and extracted article text | Your Stash instance's Supabase database | This is the save itself — the core feature |
| Your Supabase session (email-based sign-in) | Supabase Auth | Identifies your account so saves are private to you (Row Level Security) |
| Anonymous usage events (e.g. "save succeeded", "save failed") | PostHog, if `POSTHOG_API_KEY` is configured | Diagnosing failures and understanding feature usage — no page content or URLs are included in these events |
| Error reports (stack traces) | Sentry, if `SENTRY_DSN` is configured | Diagnosing crashes in the background script |

Analytics and error reporting are both **optional** and controlled entirely by
the `POSTHOG_API_KEY` and `SENTRY_DSN` values in `config.js`. A self-hosted
deployment can leave these blank to disable both — see `extension/config.js`.

## Data retention and deletion

Your saves live in your Supabase project's database for as long as your
account exists. Deleting a save in the Stash web app or extension deletes it
from the database immediately. To delete your account and all associated
data, contact the maintainer of the Stash instance you use (or, if
self-hosting, delete your row from Supabase Auth and the `saves` table
directly).

## Permissions justification

| Permission | Why the extension needs it |
|---|---|
| `activeTab` | Reads the current tab's content only when you click Save or use the context menu |
| `scripting` | Injects the Readability-based content extractor into the active page on demand |
| `contextMenus` | Adds the right-click "Save to Stash" menu item |
| `storage` | Persists your Supabase session locally so you stay signed in between browser restarts |
| `host_permissions: <all_urls>` | Lets Save work on any site, since a read-it-later tool must work everywhere you might read something |

## Contact

This is an open-source project. Questions, issues, or data-deletion requests
can be filed at the project's GitHub repository:
https://github.com/JordanTranchina/stash
