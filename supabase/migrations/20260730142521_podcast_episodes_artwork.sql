-- Migration: Add artwork_url column to podcast_episodes
-- Created at: 2026-07-29
--
-- Why:
--  * Episodes now get a per-episode cover image, built as a collage of the
--    covered articles' images by podcast/artwork.py and uploaded alongside
--    the episode MP3 (see podcast/script.py upload_artwork_to_supabase).
--    This stores its public URL so podcast-rss and the web app can surface it.
--
-- Idempotent: safe to run against a table that already has this column.

ALTER TABLE podcast_episodes
    ADD COLUMN IF NOT EXISTS artwork_url TEXT;
