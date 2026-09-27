-- Stash: Pocket Replacement Schema
-- Run this in your Supabase SQL Editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Folders table
create table folders (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  color text default '#6366f1',
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Saves table (main content)
create table saves (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  folder_id uuid references folders(id) on delete set null,

  -- Content
  url text,
  title text,
  excerpt text,
  content text, -- full article text
  highlight text, -- if this is a highlight save

  -- Metadata
  site_name text,
  author text,
  published_at timestamp with time zone,
  image_url text,

  -- Status
  is_archived boolean default false,
  is_favorite boolean default false,
  read_at timestamp with time zone,
  read_percent smallint not null default 0 check (read_percent >= 0 and read_percent <= 100),

  -- Source tracking
  source text default 'extension', -- 'extension', 'import', 'manual'

  -- Audio (TTS)
  audio_url text, -- Generated TTS audio file URL

  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Tags table
create table tags (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  color text default '#6366f1',
  created_at timestamp with time zone default now(),

  unique(user_id, name)
);

-- Junction table for saves <-> tags (many-to-many)
create table save_tags (
  save_id uuid references saves(id) on delete cascade not null,
  tag_id uuid references tags(id) on delete cascade not null,
  created_at timestamp with time zone default now(),

  primary key (save_id, tag_id)
);

-- Indexes for performance
create index saves_user_id_idx on saves(user_id);
create index saves_created_at_idx on saves(created_at desc);
create index saves_folder_id_idx on saves(folder_id);
create index saves_is_archived_idx on saves(is_archived);
create index tags_user_id_idx on tags(user_id);
create index folders_user_id_idx on folders(user_id);

-- Full-text search index
alter table saves add column fts tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(highlight, '')), 'B')
  ) stored;

create index saves_fts_idx on saves using gin(fts);

-- Row Level Security (RLS) - IMPORTANT!
alter table saves enable row level security;
alter table tags enable row level security;
alter table folders enable row level security;
alter table save_tags enable row level security;

-- RLS Policies: Users can only access their own data
create policy "Users can view own saves" on saves
  for select using (auth.uid() = user_id);

create policy "Users can insert own saves" on saves
  for insert with check (auth.uid() = user_id);

create policy "Users can update own saves" on saves
  for update using (auth.uid() = user_id);

create policy "Users can delete own saves" on saves
  for delete using (auth.uid() = user_id);

create policy "Users can view own tags" on tags
  for select using (auth.uid() = user_id);

create policy "Users can insert own tags" on tags
  for insert with check (auth.uid() = user_id);

create policy "Users can update own tags" on tags
  for update using (auth.uid() = user_id);

create policy "Users can delete own tags" on tags
  for delete using (auth.uid() = user_id);

create policy "Users can view own folders" on folders
  for select using (auth.uid() = user_id);

create policy "Users can insert own folders" on folders
  for insert with check (auth.uid() = user_id);

create policy "Users can update own folders" on folders
  for update using (auth.uid() = user_id);

create policy "Users can delete own folders" on folders
  for delete using (auth.uid() = user_id);

-- For save_tags, check via the saves table
create policy "Users can view own save_tags" on save_tags
  for select using (
    exists (select 1 from saves where saves.id = save_id and saves.user_id = auth.uid())
  );

create policy "Users can insert own save_tags" on save_tags
  for insert with check (
    exists (select 1 from saves where saves.id = save_id and saves.user_id = auth.uid())
  );

create policy "Users can delete own save_tags" on save_tags
  for delete using (
    exists (select 1 from saves where saves.id = save_id and saves.user_id = auth.uid())
  );

-- Function to update updated_at timestamp
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql
set search_path = '';

-- Triggers for updated_at
create trigger saves_updated_at
  before update on saves
  for each row execute function update_updated_at();

create trigger folders_updated_at
  before update on folders
  for each row execute function update_updated_at();

-- Function for full-text search
create or replace function search_saves(search_query text, user_uuid uuid)
returns setof saves as $$
begin
  return query
  select *
  from public.saves
  where user_id = user_uuid
    and fts @@ plainto_tsquery('english', search_query)
  order by ts_rank(fts, plainto_tsquery('english', search_query)) desc;
end;
$$ language plpgsql
set search_path = '';

-- User preferences table (podcast host personalities, etc.)
create table user_preferences (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null unique,

  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- RLS for user_preferences
alter table user_preferences enable row level security;

create policy "Users can view own preferences" on user_preferences
  for select using (auth.uid() = user_id);

create policy "Users can insert own preferences" on user_preferences
  for insert with check (auth.uid() = user_id);

create policy "Users can update own preferences" on user_preferences
  for update using (auth.uid() = user_id);

-- Trigger for updated_at
create trigger user_preferences_updated_at
  before update on user_preferences
  for each row execute function update_updated_at();

create policy "Users can delete own preferences" on user_preferences
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Invite allowlist
-- ---------------------------------------------------------------------------
-- Stash is invite-only: a trigger on auth.users refuses a sign-up whose email
-- isn't listed here, so a link forwarded beyond the intended circle can't
-- onboard strangers onto the project's quota. No client policies — the trigger
-- is SECURITY DEFINER and rows are managed from the Supabase dashboard or by
-- the friend-invite functions below, so RLS with no policy means anon and
-- authenticated see nothing.

create table allowed_emails (
  email      text primary key,
  note       text,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table allowed_emails enable row level security;

create or replace function public.enforce_email_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is null
     or not exists (select 1 from allowed_emails where email = lower(new.email))
  then
    raise exception 'Stash is invite-only right now. Ask Jordan to add % to the list.', new.email
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger enforce_email_allowlist
  before insert on auth.users
  for each row execute function public.enforce_email_allowlist();

-- Friend invites: each signed-in user can add up to 3 emails to the allowlist
-- from Settings > Invite Friends. The table still has no client policies;
-- these SECURITY DEFINER functions are the only way in, they enforce the cap,
-- and they record the inviter in invited_by (which is also what the cap
-- counts). Rows the owner adds by hand have no invited_by.

create index allowed_emails_invited_by_idx on allowed_emails (invited_by);

create or replace function public.my_invites()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_limit constant int := 3;
  v_rows  json;
  v_count int;
begin
  if v_uid is null then
    raise exception 'Sign in to invite friends.' using errcode = '42501';
  end if;

  select count(*),
         coalesce(json_agg(json_build_object(
           'email', a.email,
           'created_at', a.created_at,
           'joined', exists (select 1 from auth.users u where lower(u.email) = a.email)
         ) order by a.created_at), '[]'::json)
    into v_count, v_rows
    from allowed_emails a
   where a.invited_by = v_uid;

  return json_build_object(
    'limit', v_limit,
    'remaining', greatest(v_limit - v_count, 0),
    'invites', v_rows
  );
end;
$$;

create or replace function public.invite_friend(p_email text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_limit constant int := 3;
  v_count int;
begin
  if v_uid is null then
    raise exception 'Sign in to invite friends.' using errcode = '42501';
  end if;

  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That doesn''t look like an email address.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('invite_friend:' || v_uid::text));

  if exists (select 1 from allowed_emails where email = v_email) then
    raise exception 'That email can already sign in to Stash.' using errcode = '23505';
  end if;

  select count(*) into v_count from allowed_emails where invited_by = v_uid;
  if v_count >= v_limit then
    raise exception 'You''ve used all % of your invites.', v_limit using errcode = '54000';
  end if;

  insert into allowed_emails (email, note, invited_by)
  values (v_email, 'friend invite', v_uid);

  return public.my_invites();
end;
$$;

revoke all on function public.my_invites() from public, anon;
revoke all on function public.invite_friend(text) from public, anon;
grant execute on function public.my_invites() to authenticated;
grant execute on function public.invite_friend(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Per-user podcast feeds
-- ---------------------------------------------------------------------------
-- Podcast apps can't do OAuth, so a private feed is scoped by an unguessable
-- token in the URL rather than by a session. `subscribed` is opt-in: the
-- generation pipeline only spends Gemini/TTS quota on users who asked for
-- episodes, so someone who just wants to read costs nothing.

create table podcast_feeds (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  token      text not null unique default encode(gen_random_bytes(24), 'hex'),
  subscribed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table podcast_feeds enable row level security;

create policy "Users can view own feed" on podcast_feeds
  for select using (auth.uid() = user_id);

create policy "Users can insert own feed" on podcast_feeds
  for insert with check (auth.uid() = user_id);

create policy "Users can update own feed" on podcast_feeds
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.create_podcast_feed_for_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into podcast_feeds (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger create_podcast_feed_for_user
  after insert on auth.users
  for each row execute function public.create_podcast_feed_for_user();

-- ---------------------------------------------------------------------------
-- On-demand podcast generation requests (rate-limit ledger)
-- ---------------------------------------------------------------------------
-- The Podcasts tab's "Make an episode now" button hits the `request-podcast`
-- Edge Function, which triggers the daily GitHub Actions workflow for one
-- user. Each accepted request writes a row here; the function caps a user to
-- a few requests per rolling 24h off this table and the UI reads it to show
-- how many are left. Rows are written only by the function (service role);
-- users may read their own but there is no client write policy, so the cap
-- can't be forged around.

create table podcast_generation_requests (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  created_at          timestamptz not null default now(),
  workflow_dispatched boolean not null default false
);

create index podcast_generation_requests_user_created_idx
  on podcast_generation_requests (user_id, created_at desc);

alter table podcast_generation_requests enable row level security;

create policy "Users can view own generation requests" on podcast_generation_requests
  for select using (auth.uid() = user_id);
