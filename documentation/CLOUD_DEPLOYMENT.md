# Cloud Deployment Guide

To run Stash and the Podcast generator in the cloud, you need to set up your secrets on the platforms you are using (GitHub and Vercel).

## 1. GitHub Actions (For Podcast Automation)

To run `podcast/script.py` on a schedule (e.g., every morning), use GitHub Actions.

### Setting up Secrets

1. Go to your [GitHub Actions Secrets](https://github.com/JordanTranchina/stash/settings/secrets/actions)
2. Click **New repository secret** and add the following:
   - `SUPABASE_URL`: `https://jntnmvxkirrosxjquuoy.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY`: Your service role key (the one we rotated)
   - `USER_ID`: `6c7a3a96-16cd-4702-ac7b-0c7a4a81346d` — **legacy, single-user only** (see below)
   - `GEMINI_API_KEY`: Your Google AI API key

   You do **not** need a `VERCEL_OIDC_TOKEN` secret here — nothing in any
   `.github/workflows/*.yml` file reads it. The only place it exists is as a
   local dev artifact in `podcast/.env` (written there by the Vercel CLI,
   short-lived, already expired). Vercel deploys the web app itself via its
   own native GitHub integration (see the "Vercel" checks on any PR) — that
   needs no GitHub secret at all.

### Note on `USER_ID` (legacy)

Everything else in Stash is multi-user now: nothing hardcodes a user id, and
every client signs in. The podcast pipeline is the one holdout — it still runs
against a single hardcoded account, which is what this secret is.

It's scheduled to be replaced by a loop over the users subscribed in
`podcast_feeds`, generating one episode per feed. Until that lands, the daily
job only ever produces a podcast for the account named here, and other users'
saves are not included. Don't treat this secret as part of the auth story; it
is a stopgap in the podcast job alone.

### Scheduling the Podcast

I have provided a workflow file in `.github/workflows/podcast.yml`. It is set to run daily at 8:00 AM UTC. You can adjust this in the workflow file.

### Automated Supabase deploys (`.github/workflows/deploy-supabase.yml`)

Merging to `main` deploys the Edge Functions and/or database migrations
automatically — there's no `supabase functions deploy` / `supabase db push`
to run by hand afterward. Each half only runs when its own files changed
(a migration-only PR doesn't redeploy functions and vice versa). It can
also be run on demand: open the workflow's page under the Actions tab and
click **Run workflow** to force a full redeploy of both.

This needs two secrets that aren't set by default — **add these yourself**,
Claude (or any automated tool) should never be asked to enter a token like
this on your behalf:

1. Go to [GitHub Actions Secrets](https://github.com/JordanTranchina/stash/settings/secrets/actions)
   → **New repository secret**:
   - `SUPABASE_ACCESS_TOKEN` — a personal access token from
     [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
     (Generate new token → give it any name → copy it — it's shown once).
   - `SUPABASE_DB_PASSWORD` — the project's Postgres password, from
     [Project Settings → Database](https://supabase.com/dashboard/project/jntnmvxkirrosxjquuoy/settings/database).
     If you don't know it, reset it there (this rotates it — nothing else in
     Stash uses the direct DB password, so that's safe).

   Or from your own terminal, once you have each value:
   ```bash
   gh secret set SUPABASE_ACCESS_TOKEN -R JordanTranchina/stash
   gh secret set SUPABASE_DB_PASSWORD -R JordanTranchina/stash
   ```
   (`gh secret set NAME` with no `--body` prompts you to paste the value —
   it never appears in your shell history that way.)

The project ref (`SUPABASE_PROJECT_ID`) is already set as a repo *variable*
(not a secret — it's not sensitive, it's the same ref that's already public
in `web/config.js` and every Edge Function URL in this repo).

## 2. Vercel (For the Web App)

If you have deployed the `web` folder to Vercel, you should also add environment variables there for consistency.

### Setting up Environment Variables

1. Go to your [Vercel Project Settings](https://vercel.com/jordantranchinas-projects/stash/settings/environment-variables).
2. Add the same secrets as above.

## 3. Supabase (For Edge Functions)

If you use Supabase Edge Functions (like `save-page`), secrets are managed via the Supabase CLI or Dashboard.

### Using Dashboard

1. Go to your [Supabase Edge Function Secrets](https://supabase.com/dashboard/project/jntnmvxkirrosxjquuoy/settings/edge-functions).
2. Add or update your secrets there.

## 4. Summary of Key Locations

| Secret | Rotation/Redo Link | Cloud Deployment Link (to set) |
| :-- | :-- | :-- |
| **Gemini API Key** | [AI Studio](https://aistudio.google.com/app/apikey) | [GitHub Secrets](https://github.com/JordanTranchina/stash/settings/secrets/actions) |
| **Supabase Key** | [Supabase API Settings](https://supabase.com/dashboard/project/jntnmvxkirrosxjquuoy/settings/api) | [GitHub Secrets](https://github.com/JordanTranchina/stash/settings/secrets/actions) |
| **Supabase Access Token** (for automated deploys) | [Supabase Access Tokens](https://supabase.com/dashboard/account/tokens) | [GitHub Secrets](https://github.com/JordanTranchina/stash/settings/secrets/actions) |
| **Supabase DB Password** (for automated deploys) | [Project Settings → Database](https://supabase.com/dashboard/project/jntnmvxkirrosxjquuoy/settings/database) | [GitHub Secrets](https://github.com/JordanTranchina/stash/settings/secrets/actions) |
| **Vercel Personal Access Token** (only if you ever script Vercel from CI) | [Vercel Personal Access Tokens](https://vercel.com/account/tokens) | Not needed today — Vercel deploys via its own GitHub integration, no GitHub secret required |

### Note on `VERCEL_OIDC_TOKEN`

The `VERCEL_OIDC_TOKEN` found in your local `.env.local` is a system-generated variable managed by the Vercel CLI.

- **Why it's not in the Dashboard**: It's a "System Environment Variable" that Vercel manages automatically. It won't appear in your project-level settings.
- **How to redo it locally**: Run `vercel env pull` in your terminal. This will refresh your local `.env.local` (or create a new one) with a fresh session token.
- **For GitHub Actions**: If you are using GitHub Actions to deploy or interact with Vercel, you should use a **Vercel Personal Access Token** (created [here](https://vercel.com/account/tokens)) and store it as `VERCEL_TOKEN` in GitHub Secrets.
