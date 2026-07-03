-- Migration: Add podcast host personality settings to user_preferences
-- Created at: 2026-07-03
--
-- Backs the "Custom Host Personalities" feature (issue #13). The podcast pipeline
-- (podcast/script.py) reads these to build the Gemini system prompt; when a value
-- is NULL the pipeline falls back to the default Alex/Taylor personas.
--
-- Idempotent: safe to re-run.

ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS podcast_host_a_name    text,
    ADD COLUMN IF NOT EXISTS podcast_host_a_persona text,
    ADD COLUMN IF NOT EXISTS podcast_host_b_name    text,
    ADD COLUMN IF NOT EXISTS podcast_host_b_persona text,
    ADD COLUMN IF NOT EXISTS podcast_tone           text;
