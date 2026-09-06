-- Migration: On-demand podcast generation requests (rate-limit ledger)
-- Created at: 2026-09-06
--
-- The Podcasts tab has a "Make an episode now" button. It fans out to the
-- daily GitHub Actions workflow (podcast.yml, workflow_dispatch) for a single
-- user via the `request-podcast` Edge Function. This table is the rate-limit
-- ledger: one row per accepted on-demand request, so the function can cap a
-- user to a few requests per rolling 24h and the UI can show how many are
-- left.
--
-- Rows are written only by the Edge Function (service role, bypasses RLS).
-- Users may read their own rows so the client can render "1 of 3 used today".
-- No client INSERT/UPDATE/DELETE policy exists, so a user can't forge or
-- clear their own ledger to get around the cap.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS podcast_generation_requests (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- Flipped to true once the GitHub workflow_dispatch actually returned OK.
    -- A row that never gets here (dispatch failed) is deleted by the function
    -- so it doesn't count against the user; this column is just an audit aid.
    workflow_dispatched boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS podcast_generation_requests_user_created_idx
    ON podcast_generation_requests (user_id, created_at DESC);

ALTER TABLE podcast_generation_requests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'podcast_generation_requests'
          AND policyname = 'Users can view own generation requests'
    ) THEN
        CREATE POLICY "Users can view own generation requests" ON podcast_generation_requests
            FOR SELECT USING (auth.uid() = user_id);
    END IF;
END
$$;
