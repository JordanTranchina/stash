-- Migration: Store a precomputed word_count on saves
-- Created at: 2026-09-04
--
-- Why:
--  * The saves list (web/app.js renderSaves -> readingTime -> wordCount) was
--    splitting each save's full `content` on whitespace to print "X min
--    read", for every card, on every render. With hundreds of saves this ran
--    the same full-article split over and over and was a big part of why the
--    list felt slow.
--  * The list query is also being changed (see app.js) to stop selecting
--    `content` at all, since the list view never needs the article body —
--    only the reading pane does. Reading time then has nothing to count from
--    unless it's stored ahead of time.
--  * A trigger (not client code) computes it, because five different writers
--    insert/update `saves.content`: the Chrome/Firefox extensions, the web
--    app, and the save-page/save-kindle Edge Functions. One trigger covers
--    all of them.
--
-- Idempotent: safe to re-run.

ALTER TABLE saves
    ADD COLUMN IF NOT EXISTS word_count integer;

CREATE OR REPLACE FUNCTION stash_set_save_word_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.content IS NULL OR btrim(NEW.content) = '' THEN
    NEW.word_count := NULL;
  ELSE
    NEW.word_count := array_length(regexp_split_to_array(btrim(NEW.content), '\s+'), 1);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS saves_set_word_count ON saves;
CREATE TRIGGER saves_set_word_count
  BEFORE INSERT OR UPDATE OF content ON saves
  FOR EACH ROW
  EXECUTE FUNCTION stash_set_save_word_count();

-- Backfill existing rows.
UPDATE saves
SET word_count = array_length(regexp_split_to_array(btrim(content), '\s+'), 1)
WHERE content IS NOT NULL
  AND btrim(content) <> ''
  AND word_count IS NULL;
