-- Migration: Add script_json and chapters columns to podcast_episodes
-- Created at: 2026-07-03
--
-- Why:
--  * `podcast/script.py` (save_to_supabase) inserts a `script_json` field, but the
--    original 20260126200217_create_podcast_episodes.sql never defined that column, so the
--    insert would fail. This adds it.
--  * `chapters` stores the per-article chapter markers used by Interactive RSS Chapters
--    (issue #14) and served by the podcast-chapters edge function.
--
-- Idempotent: safe to run against a table that already has some/all of these columns.

ALTER TABLE podcast_episodes
    ADD COLUMN IF NOT EXISTS script_json jsonb;

ALTER TABLE podcast_episodes
    ADD COLUMN IF NOT EXISTS chapters jsonb;
