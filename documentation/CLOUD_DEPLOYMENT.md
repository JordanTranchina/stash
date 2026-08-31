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
   - `VERCEL_OIDC_TOKEN`: Your Vercel OIDC token

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

### `report-bug` function (in-app "Report a Bug")

The `report-bug` Edge Function files an in-app bug report as a GitHub issue and
stores its screenshot/video attachments in Storage. It needs two extra secrets:

- `GITHUB_TOKEN` — a **fine-grained** personal access token scoped to **only the
  `stash` repo**, with **Issues: Read and write**. Nothing else. This is the
  account the issues are created as; the end user never signs in to GitHub.
- `GITHUB_REPO` — `JordanTranchina/stash` (the `owner/repo` issues are filed in).

It also expects the `bug-attachments` Storage bucket to exist — apply
`supabase/migrations/20260831_bug_attachments_bucket.sql` (`supabase db push`, or
run it in the SQL editor). That bucket is **public-read** so images render inline
in the issue body; object paths include a random UUID so the URLs are
unguessable. If that tradeoff is unacceptable, make the bucket private and switch
the function to signed URLs.

Deploy: `supabase functions deploy report-bug`.

## 4. Summary of Key Locations

| Secret | Rotation/Redo Link | Cloud Deployment Link (to set) |
| :-- | :-- | :-- |
| **Gemini API Key** | [AI Studio](https://aistudio.google.com/app/apikey) | [GitHub Secrets](https://github.com/JordanTranchina/stash/settings/secrets/actions) |
| **Supabase Key** | [Supabase API Settings](https://supabase.com/dashboard/project/jntnmvxkirrosxjquuoy/settings/api) | [GitHub Secrets](https://github.com/JordanTranchina/stash/settings/secrets/actions) |
| **Vercel Token** | [Vercel Personal Access Tokens](https://vercel.com/account/tokens) | [GitHub Secrets](https://github.com/JordanTranchina/stash/settings/secrets/actions) |
| **`GITHUB_TOKEN` (report-bug)** | [Fine-grained PATs](https://github.com/settings/personal-access-tokens) — `stash` repo, Issues: R/W | [Supabase Edge Function Secrets](https://supabase.com/dashboard/project/jntnmvxkirrosxjquuoy/settings/edge-functions) |

### Note on `VERCEL_OIDC_TOKEN`

The `VERCEL_OIDC_TOKEN` found in your local `.env.local` is a system-generated variable managed by the Vercel CLI.

- **Why it's not in the Dashboard**: It's a "System Environment Variable" that Vercel manages automatically. It won't appear in your project-level settings.
- **How to redo it locally**: Run `vercel env pull` in your terminal. This will refresh your local `.env.local` (or create a new one) with a fresh session token.
- **For GitHub Actions**: If you are using GitHub Actions to deploy or interact with Vercel, you should use a **Vercel Personal Access Token** (created [here](https://vercel.com/account/tokens)) and store it as `VERCEL_TOKEN` in GitHub Secrets.
