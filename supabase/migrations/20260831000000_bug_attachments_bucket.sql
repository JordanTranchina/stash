-- Migration: Storage bucket for in-app bug-report attachments
-- Created at: 2026-08-31
--
-- Screenshots / screen recordings / files attached to a bug report land here.
-- The `report-bug` Edge Function uploads with the service-role key and then
-- embeds the public URLs in a GitHub issue, so the bucket is public-read: an
-- issue body can only render an image from a URL that needs no auth. Object
-- paths are `<user_id>/<uuid>/<filename>`, so the URLs stay unguessable.

INSERT INTO storage.buckets (id, name, public)
VALUES ('bug-attachments', 'bug-attachments', true)
ON CONFLICT (id) DO NOTHING;

-- Uploads go only through the Edge Function (service role, bypasses RLS), so no
-- INSERT policy is needed for end users. This SELECT policy is defensive: it
-- lets a signed-in user read objects under their own `<user_id>/` prefix
-- without exposing anyone else's.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policy WHERE polname = 'bug-attachments owner can read own prefix'
    ) THEN
        CREATE POLICY "bug-attachments owner can read own prefix" ON storage.objects
            FOR SELECT TO authenticated
            USING (
                bucket_id = 'bug-attachments'
                AND (storage.foldername(name))[1] = auth.uid()::text
            );
    END IF;
END
$$;
