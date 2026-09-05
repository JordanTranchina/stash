-- Migration: Drop mezcal_bottles (cross-project contamination cleanup)
-- Applied at: 2026-09-05
--
-- The mezcal_bottles table (and its RLS policies) belong to an unrelated
-- "Mezcal Scraper" Supabase project in the same org. They ended up in the
-- Stash database by mistake -- a CLI session was apparently linked to the
-- wrong project at some point (see issue #110). The table was confirmed
-- empty (0 rows) and nothing in this codebase ever referenced it.
--
-- The two migration versions that originally created it/enabled its RLS
-- (20260304051335 create_mezcal_bottles_table, 20260314185103
-- enable_rls_mezcal_bottles) were removed from
-- supabase_migrations.schema_migrations directly, since they were never
-- part of this repo's history and shouldn't be reconciled with a local
-- file the way the rest of issue #110 was.
--
-- Idempotent: safe to run against a database that no longer has this table.

DROP TABLE IF EXISTS public.mezcal_bottles;
