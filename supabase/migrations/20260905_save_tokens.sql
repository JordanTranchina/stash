-- Migration: Per-user long-lived save tokens
-- Created at: 2026-09-05
--
-- Why: the iOS Shortcut (ios-shortcut/README.md) is the only way to get
-- Stash into the native iOS/iPadOS share sheet — WebKit doesn't implement
-- the Web Share Target API that makes the PWA a share target on Android.
-- Shortcuts can't run a Supabase sign-in flow, so it previously authenticated
-- with a raw access token pasted out of local storage, which expires
-- hourly and has to be re-pasted constantly. That made the "native" iOS
-- path unusable day-to-day, unlike Android's, which just works.
--
-- This mirrors the podcast_feeds pattern (an unguessable per-user token,
-- since the client can't do OAuth) instead: save-page accepts this token as
-- an alternative to a JWT, so the Shortcut is set up once and keeps working.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS save_tokens (
    user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    token        text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

ALTER TABLE save_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own save token" ON save_tokens;
CREATE POLICY "Users can view own save token" ON save_tokens
    FOR SELECT USING (auth.uid() = user_id);

-- Lets the Settings UI "Regenerate" button rotate a leaked/retired token
-- without a support round-trip. Only token/last_used_at are meant to change;
-- there's nothing else on the row worth restricting column-by-column for.
DROP POLICY IF EXISTS "Users can regenerate own save token" ON save_tokens;
CREATE POLICY "Users can regenerate own save token" ON save_tokens
    FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.create_save_token_for_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO save_tokens (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS create_save_token_for_user ON auth.users;
CREATE TRIGGER create_save_token_for_user
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.create_save_token_for_user();

-- Backfill existing users.
INSERT INTO save_tokens (user_id)
SELECT id FROM auth.users
ON CONFLICT (user_id) DO NOTHING;
