-- Migration: Friend invites (3 per user)
-- Created at: 2026-09-27
--
-- Stash is invite-only: the enforce_email_allowlist trigger on auth.users
-- refuses a sign-up whose email isn't in `allowed_emails`. Until now only the
-- owner could add rows, from the Supabase dashboard. This lets every signed-in
-- user invite up to 3 friends from Settings > Invite Friends.
--
-- allowed_emails keeps RLS on with no client policies, so a user still can't
-- read or write the table directly. The two functions below are the only way
-- in. They are SECURITY DEFINER, so they enforce the cap themselves and only
-- ever write rows with invited_by = the caller. `invited_by` (added in
-- 20260824000000_multi_user_lockdown.sql) is the record of who invited whom,
-- and counting a user's rows there is the cap. Rows the owner adds by hand
-- have no invited_by, so they never count against anyone.
--
-- Idempotent: safe to re-run.

CREATE INDEX IF NOT EXISTS allowed_emails_invited_by_idx
    ON allowed_emails (invited_by);

-- Returns the caller's invites and how many they have left, so Settings can
-- show "2 of 3 invites left" and whether each friend has signed up yet.
CREATE OR REPLACE FUNCTION public.my_invites()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid    uuid := auth.uid();
    v_limit  constant int := 3;
    v_rows   json;
    v_count  int;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Sign in to invite friends.' USING ERRCODE = '42501';
    END IF;

    SELECT count(*),
           coalesce(json_agg(json_build_object(
               'email', a.email,
               'created_at', a.created_at,
               'joined', EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = a.email)
           ) ORDER BY a.created_at), '[]'::json)
      INTO v_count, v_rows
      FROM allowed_emails a
     WHERE a.invited_by = v_uid;

    RETURN json_build_object(
        'limit', v_limit,
        'remaining', greatest(v_limit - v_count, 0),
        'invites', v_rows
    );
END;
$$;

-- Adds a friend's email to the allowlist on the caller's behalf. Refuses a
-- 4th invite, and doesn't spend an invite on an email that's already listed.
CREATE OR REPLACE FUNCTION public.invite_friend(p_email text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid   uuid := auth.uid();
    v_email text := lower(btrim(coalesce(p_email, '')));
    v_limit constant int := 3;
    v_count int;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Sign in to invite friends.' USING ERRCODE = '42501';
    END IF;

    IF length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RAISE EXCEPTION 'That doesn''t look like an email address.' USING ERRCODE = '22023';
    END IF;

    -- Serialise one user's invites so two quick taps can't both pass the
    -- count check and end up with 4.
    PERFORM pg_advisory_xact_lock(hashtext('invite_friend:' || v_uid::text));

    IF EXISTS (SELECT 1 FROM allowed_emails WHERE email = v_email) THEN
        RAISE EXCEPTION 'That email can already sign in to Stash.' USING ERRCODE = '23505';
    END IF;

    SELECT count(*) INTO v_count FROM allowed_emails WHERE invited_by = v_uid;
    IF v_count >= v_limit THEN
        RAISE EXCEPTION 'You''ve used all % of your invites.', v_limit USING ERRCODE = '54000';
    END IF;

    INSERT INTO allowed_emails (email, note, invited_by)
    VALUES (v_email, 'friend invite', v_uid);

    RETURN public.my_invites();
END;
$$;

REVOKE ALL ON FUNCTION public.my_invites() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.invite_friend(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_invites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.invite_friend(text) TO authenticated;
