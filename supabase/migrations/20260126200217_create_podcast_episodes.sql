-- Migration: Create podcast_episodes table
-- Created at: 2026-01-26

CREATE TABLE IF NOT EXISTS podcast_episodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    title TEXT NOT NULL,
    description TEXT,
    audio_url TEXT,
    duration_seconds INT,
    size_bytes INT,
    related_article_ids UUID[]
);

-- Enable RLS
ALTER TABLE podcast_episodes ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policy WHERE polname = 'Users can view own podcast episodes'
    ) THEN
        CREATE POLICY "Users can view own podcast episodes" ON podcast_episodes
            FOR SELECT USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policy WHERE polname = 'Users can insert own podcast episodes'
    ) THEN
        CREATE POLICY "Users can insert own podcast episodes" ON podcast_episodes
            FOR INSERT WITH CHECK (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policy WHERE polname = 'Users can update own podcast episodes'
    ) THEN
        CREATE POLICY "Users can update own podcast episodes" ON podcast_episodes
            FOR UPDATE USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policy WHERE polname = 'Users can delete own podcast episodes'
    ) THEN
        CREATE POLICY "Users can delete own podcast episodes" ON podcast_episodes
            FOR DELETE USING (auth.uid() = user_id);
    END IF;
END
$$;
