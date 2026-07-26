-- Migration: Track which saves have already been discussed in a podcast episode
-- Created at: 2026-07-26
--
-- Why:
--  * podcast/extract.py selected saves using only is_archived=false plus a
--    7-day recency window, ordered newest-first. Two bugs fell out of that:
--      1. Saving more than `limit` articles in the window pushed older ones
--         out silently — they aged past 7 days and were never discussed.
--      2. Nothing recorded that a save had already been covered, so an
--         unarchived save could be re-discussed in a later episode.
--  * This column lets extract.py exclude already-discussed saves directly,
--    independent of is_archived and the recency window.
--
-- Idempotent: safe to re-run.

ALTER TABLE saves
    ADD COLUMN IF NOT EXISTS podcast_episode_id uuid REFERENCES podcast_episodes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS podcast_discussed_at timestamptz;

CREATE INDEX IF NOT EXISTS saves_podcast_discussed_at_idx ON saves(podcast_discussed_at);
