-- Migration: de-duplicate saves by URL
-- Created at: 2026-08-24
--
-- Why:
--  * Every client (extension, bookmarklet, share sheet, CSV import) inserted a
--    new `saves` row unconditionally, so re-saving an article you'd already
--    stashed produced a second copy — and the podcast pipeline then happily
--    discussed the same piece twice.
--  * Saving something again is a signal that you want to read it *now*, so the
--    right behaviour is not "reject the save" but "move the existing one back
--    to the top of the list": keep one row and bump its saved-at date.
--
-- What this does:
--  1. stash_normalize_url() — a canonical form of a URL for comparison
--     (scheme/www/fragment/tracking params stripped, host lowercased).
--  2. Merges duplicates that already exist, keeping the copy with the most
--     scraped content and giving it the newest saved-at date.
--  3. A unique index on (user_id, normalized url) so duplicates can't come
--     back through any path.
--  4. A BEFORE INSERT trigger that turns a duplicate insert into an update of
--     the existing row (bumping created_at, back-filling anything the original
--     save was missing) instead of letting it hit that unique index as an
--     error. Callers get an empty result back — see supabase/functions/
--     save-page/index.ts and extension/background.js, which report it as
--     "already saved".
--
-- Highlight saves (`highlight is not null`) are deliberately exempt: several
-- different highlights from the same page are distinct saves, not duplicates.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. URL normalization
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stash_normalize_url(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  u    text;
  host text;
  rest text;
BEGIN
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;

  u := btrim(raw);
  IF u = '' THEN
    RETURN NULL;
  END IF;

  -- #fragment never identifies a different article
  u := regexp_replace(u, '#.*$', '');
  -- http:// and https:// are the same page
  u := regexp_replace(u, '^[a-z][a-z0-9+.-]*://', '', 'i');
  u := regexp_replace(u, '^www\.', '', 'i');

  -- Campaign/click-tracking params. Deliberately conservative: params that
  -- can carry real meaning elsewhere (`s`, `ref`, `source`, `v`, `id`) are
  -- left alone so two genuinely different pages never collapse into one.
  u := regexp_replace(
    u,
    '[?&](utm_[^&=]*|fbclid|gclid|gbraid|wbraid|msclkid|dclid|yclid|mc_cid|mc_eid|igshid|igsh|si|ref_src|ref_url|__twitter_impression|guccounter|guce_referrer|guce_referrer_sig|spm|cmpid|mkt_tok|_hsenc|_hsmi|ck_subscriber_id)=[^&]*',
    '',
    'gi'
  );

  -- Stripping params can leave the query string malformed
  -- ("?utm_source=x&a=1" -> "&a=1", "?a=1&utm_source=x" -> "?a=1&").
  u := regexp_replace(u, '\?&+', '?');
  u := regexp_replace(u, '^([^?]*)&', '\1?');
  u := regexp_replace(u, '&&+', '&', 'g');
  u := regexp_replace(u, '[?&]+$', '');

  -- Trailing slashes are not part of a page's identity
  u := regexp_replace(u, '/+$', '');

  -- Hostnames are case-insensitive; paths and query strings are not, so only
  -- the host portion is lowercased.
  host := substring(u FROM '^[^/?]*');
  rest := substr(u, length(host) + 1);
  u := lower(host) || rest;

  RETURN nullif(u, '');
END;
$$;

COMMENT ON FUNCTION stash_normalize_url(text) IS
  'Canonical form of a URL used for duplicate detection in saves.';

-- ---------------------------------------------------------------------------
-- 2. Merge duplicates that already exist
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS stash_dupe_groups;

-- keeper_id = the copy we keep: the one with the most scraped content, then
-- the oldest, so the fullest version of the article survives the merge.
CREATE TEMPORARY TABLE stash_dupe_groups AS
SELECT
  id,
  first_value(id) OVER w AS keeper_id
FROM saves
WHERE url IS NOT NULL
  AND highlight IS NULL
WINDOW w AS (
  PARTITION BY user_id, stash_normalize_url(url)
  ORDER BY coalesce(length(content), 0) DESC, created_at ASC, id ASC
);

-- The surviving row inherits the group's newest saved-at date, plus any
-- podcast/favourite state that only one of the copies carried.
UPDATE saves s
SET created_at           = g.newest_saved,
    podcast_discussed_at = coalesce(s.podcast_discussed_at, g.discussed_at),
    podcast_episode_id   = coalesce(s.podcast_episode_id, g.episode_id),
    is_favorite          = s.is_favorite OR g.favorited,
    updated_at           = now()
FROM (
  SELECT m.keeper_id,
         max(sv.created_at)           AS newest_saved,
         min(sv.podcast_discussed_at) AS discussed_at,
         (array_agg(sv.podcast_episode_id) FILTER (WHERE sv.podcast_episode_id IS NOT NULL))[1] AS episode_id,
         bool_or(sv.is_favorite)      AS favorited
  FROM stash_dupe_groups m
  JOIN saves sv ON sv.id = m.id
  GROUP BY m.keeper_id
  HAVING count(*) > 1
) g
WHERE s.id = g.keeper_id;

-- Tags on the copies we're about to delete move to the survivor.
INSERT INTO save_tags (save_id, tag_id)
SELECT m.keeper_id, st.tag_id
FROM stash_dupe_groups m
JOIN save_tags st ON st.save_id = m.id
WHERE m.id <> m.keeper_id
ON CONFLICT DO NOTHING;

DELETE FROM saves s
USING stash_dupe_groups m
WHERE s.id = m.id
  AND m.id <> m.keeper_id;

DROP TABLE stash_dupe_groups;

-- ---------------------------------------------------------------------------
-- 3. Stop duplicates coming back
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS saves_user_normalized_url_uniq
  ON saves (user_id, stash_normalize_url(url))
  WHERE url IS NOT NULL AND highlight IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Turn duplicate inserts into a bump of the existing save
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stash_dedup_save()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing saves%ROWTYPE;
BEGIN
  IF NEW.url IS NULL OR NEW.highlight IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Scoped to NEW.user_id, which the table's RLS insert policy has already
  -- constrained to the caller — SECURITY DEFINER is only here so the lookup
  -- and bump work identically for every client.
  SELECT * INTO existing
  FROM saves
  WHERE user_id = NEW.user_id
    AND highlight IS NULL
    AND url IS NOT NULL
    AND stash_normalize_url(url) = stash_normalize_url(NEW.url)
  ORDER BY created_at ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  UPDATE saves SET
    -- "Saved at" becomes the most recent time this article was saved. GREATEST
    -- rather than now() so a CSV import carrying an older original date can't
    -- drag a save backwards down the list.
    created_at   = GREATEST(existing.created_at, coalesce(NEW.created_at, now())),
    updated_at   = now(),
    -- Re-saving something you'd archived means you want it back in the list.
    is_archived  = false,
    -- Back-fill anything the first save didn't manage to scrape. A later save
    -- that scraped more of the article wins; a worse scrape never overwrites a
    -- good one.
    title        = CASE WHEN coalesce(existing.title, '') IN ('', 'Untitled')
                        THEN coalesce(NEW.title, existing.title)
                        ELSE existing.title END,
    content      = CASE WHEN coalesce(length(NEW.content), 0) > coalesce(length(existing.content), 0)
                        THEN NEW.content
                        ELSE existing.content END,
    excerpt      = coalesce(nullif(existing.excerpt, ''), NEW.excerpt),
    site_name    = coalesce(nullif(existing.site_name, ''), NEW.site_name),
    author       = coalesce(existing.author, NEW.author),
    published_at = coalesce(existing.published_at, NEW.published_at),
    image_url    = coalesce(existing.image_url, NEW.image_url),
    folder_id    = coalesce(existing.folder_id, NEW.folder_id)
  WHERE id = existing.id;

  -- Skip the insert: PostgREST returns an empty representation, which callers
  -- surface as "already saved".
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS saves_dedup_before_insert ON saves;
CREATE TRIGGER saves_dedup_before_insert
  BEFORE INSERT ON saves
  FOR EACH ROW
  EXECUTE FUNCTION stash_dedup_save();

-- ---------------------------------------------------------------------------
-- 5. Lookup helper so a client can report *which* save a duplicate collapsed
--    into. SECURITY INVOKER (the default) so RLS still applies.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stash_find_save_by_url(p_user_id uuid, p_url text)
RETURNS SETOF saves
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM saves
  WHERE user_id = p_user_id
    AND highlight IS NULL
    AND url IS NOT NULL
    AND stash_normalize_url(url) = stash_normalize_url(p_url)
  ORDER BY created_at DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION stash_normalize_url(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION stash_find_save_by_url(uuid, text) TO anon, authenticated;
