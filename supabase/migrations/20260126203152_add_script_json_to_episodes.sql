-- Migration: Add script_json column to podcast_episodes
-- Created at: 2026-01-26
--
-- Reconciliation entry: this version is already recorded in production's
-- migration history (applied directly, not through this repo's CI) but had
-- no matching file here, which made `supabase db push` refuse to run for
-- every later migration too (see issue #110). Filed here, under its
-- original version and name, so local history matches remote and the
-- content stays documented and reproducible from a clean database.
--
-- Idempotent: safe to run against a table that already has this column.

ALTER TABLE podcast_episodes
    ADD COLUMN IF NOT EXISTS script_json jsonb;
