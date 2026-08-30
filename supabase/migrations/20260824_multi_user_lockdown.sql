-- Migration: Multi-user lockdown (launch readiness, Phase 0 + Phase 1)
-- Created at: 2026-08-24
--
-- Single-user mode removed the login screen by adding a second set of RLS
-- policies granting the `public` role (which includes `anon`) full access to
-- one hard-coded user's rows. Because the anon key ships in this repository,
-- anyone who read it could list, edit or delete the entire library. This
-- migration removes that shortcut and makes the database genuinely multi-user:
--
--   1. Drop the four "Allow specific user" policies. Only the correct
--      auth.uid() = user_id policies remain, so every client must sign in.
--   2. Add an `allowed_emails` invite allowlist, enforced at sign-up, so a
--      stray link can't onboard strangers onto the Supabase bill.
--   3. Add per-user podcast feed tokens. Podcast apps can't do OAuth, so an
--      unguessable token in the URL is the standard way to scope a feed.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Drop the public-access policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Allow specific user saves"     ON saves;
DROP POLICY IF EXISTS "Allow specific user tags"      ON tags;
DROP POLICY IF EXISTS "Allow specific user folders"   ON folders;
DROP POLICY IF EXISTS "Allow specific user save_tags" ON save_tags;

-- user_preferences never had a permissive policy, which is why the podcast
-- host settings silently failed to save in single-user mode. It is missing a
-- DELETE policy though, so a user can't clear their own preferences.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'user_preferences'
          AND policyname = 'Users can delete own preferences'
    ) THEN
        CREATE POLICY "Users can delete own preferences" ON user_preferences
            FOR DELETE USING (auth.uid() = user_id);
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Invite allowlist
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS allowed_emails (
    email      text PRIMARY KEY,
    note       text,
    invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Nobody reads or writes this from a client; the sign-up trigger is
-- SECURITY DEFINER and the owner manages rows from the Supabase dashboard.
-- RLS on with no policies = deny all for anon and authenticated.
ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;

-- Everyone who already has an account is grandfathered in.
INSERT INTO allowed_emails (email, note)
SELECT lower(email), 'existing account at lockdown'
FROM auth.users
WHERE email IS NOT NULL
ON CONFLICT (email) DO NOTHING;

CREATE OR REPLACE FUNCTION public.enforce_email_allowlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.email IS NULL
       OR NOT EXISTS (
           SELECT 1 FROM allowed_emails WHERE email = lower(NEW.email)
       )
    THEN
        RAISE EXCEPTION 'Stash is invite-only right now. Ask Jordan to add % to the list.', NEW.email
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_email_allowlist ON auth.users;
CREATE TRIGGER enforce_email_allowlist
    BEFORE INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.enforce_email_allowlist();

-- ---------------------------------------------------------------------------
-- 3. Per-user podcast feed tokens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS podcast_feeds (
    user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    token      text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
    -- Opt-in: the pipeline only generates episodes for users who asked for
    -- them, so a friend who just wants to read isn't burning Gemini quota.
    subscribed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE podcast_feeds ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'podcast_feeds'
          AND policyname = 'Users can view own feed'
    ) THEN
        CREATE POLICY "Users can view own feed" ON podcast_feeds
            FOR SELECT USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'podcast_feeds'
          AND policyname = 'Users can insert own feed'
    ) THEN
        CREATE POLICY "Users can insert own feed" ON podcast_feeds
            FOR INSERT WITH CHECK (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'podcast_feeds'
          AND policyname = 'Users can update own feed'
    ) THEN
        CREATE POLICY "Users can update own feed" ON podcast_feeds
            FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    END IF;
END
$$;

-- Existing users keep their podcast: they are backfilled as subscribed so the
-- feed they already have in their podcast app keeps producing episodes.
INSERT INTO podcast_feeds (user_id, subscribed)
SELECT id, true FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- New users get a feed row (unsubscribed) on sign-up so the Podcasts tab can
-- always show them a personal URL to copy.
CREATE OR REPLACE FUNCTION public.create_podcast_feed_for_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO podcast_feeds (user_id) VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS create_podcast_feed_for_user ON auth.users;
CREATE TRIGGER create_podcast_feed_for_user
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.create_podcast_feed_for_user();
