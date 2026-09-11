-- Migration: Add reader settings to user_preferences
-- Created at: 2026-09-11
--
-- Backs the "Reading Mode & In-Article Customization" feature.
-- Persists reading typography (font family, percentage scale, color theme, and
-- cross-article sync) to user_preferences in Supabase.
--
-- Idempotent: safe to re-run.

ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS reader_font          text DEFAULT 'sans',
    ADD COLUMN IF NOT EXISTS reader_scale         integer DEFAULT 100,
    ADD COLUMN IF NOT EXISTS reader_theme         text DEFAULT 'white',
    ADD COLUMN IF NOT EXISTS reader_sync_articles boolean DEFAULT true;
