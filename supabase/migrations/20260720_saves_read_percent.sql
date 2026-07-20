-- Migration: Add read_percent to saves
-- Created at: 2026-07-20
--
-- Why:
--  * The reading pane already renders a visual scroll-progress bar
--    (see web/app.js updateReadingProgress) but never persisted it, so
--    the percent read reset every time an article was reopened.
--  * This column stores the last-known scroll percentage (0-100) so the
--    reader can display "X% read" and resume roughly where the user left off.
--
-- Idempotent: safe to run against a table that already has the column.

ALTER TABLE saves
    ADD COLUMN IF NOT EXISTS read_percent smallint NOT NULL DEFAULT 0
        CONSTRAINT saves_read_percent_range CHECK (read_percent >= 0 AND read_percent <= 100);
