-- Migration: Pin search_path on functions defined in the base schema
-- Created at: 2026-03-14
--
-- Reconciliation entry: this version is already recorded in production's
-- migration history (applied directly, not through this repo's CI) but had
-- no matching file here, which made `supabase db push` refuse to run for
-- every later migration too (see issue #110). Filed here, under its
-- original version and name, so local history matches remote.
--
-- A function without a pinned search_path resolves unqualified identifiers
-- against whatever search_path the calling session has, which a caller can
-- influence (Supabase's "Function Search Path Mutable" advisory). Every
-- function added since (stash_normalize_url, stash_dedup_save, etc.) already
-- sets its own search_path inline; these two predate that convention because
-- they live in schema.sql, not a migration.
--
-- Idempotent: ALTER FUNCTION ... SET only changes function configuration,
-- never the function body, so re-running this is a no-op.

ALTER FUNCTION public.update_updated_at() SET search_path = '';
ALTER FUNCTION public.search_saves(text, uuid) SET search_path = '';
