-- Migration: Remove weekly digest email columns from user_preferences
-- Created at: 2026-07-21
--
-- The weekly digest email feature (Settings > Weekly Digest Email, the
-- send-digest Edge Function) has been removed. Drops the columns and index
-- that backed it; any pg_cron job calling send-digest should also be
-- unscheduled (select cron.unschedule('send-weekly-digest')).
--
-- Idempotent: safe to re-run.

DROP INDEX IF EXISTS user_preferences_digest_idx;

ALTER TABLE user_preferences
    DROP COLUMN IF EXISTS digest_enabled,
    DROP COLUMN IF EXISTS digest_email,
    DROP COLUMN IF EXISTS digest_day,
    DROP COLUMN IF EXISTS digest_hour,
    DROP COLUMN IF EXISTS last_digest_sent;
