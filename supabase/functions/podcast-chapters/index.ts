import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Serves a Podcasting 2.0 "chapters" JSON document for a single episode.
// Referenced from the RSS feed via
// <podcast:chapters url="...?id=<episode_id>&token=<feed_token>"/>.
// Chapter titles are article titles, so this can't be open to anyone holding an
// episode UUID. Podcast apps can't send a JWT, so it's scoped by the same feed
// token as the RSS feed: the episode must belong to that token's user.
// Spec: https://github.com/Podcastindex-org/podcast-namespace/blob/main/chapters/jsonChapters.md
serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");
    if (!id) {
      return new Response(JSON.stringify({ error: "Missing 'id' query parameter" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!token) {
      return new Response("Not Found", {
        status: 404,
        headers: { ...cors, "Content-Type": "text/plain" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: feed } = await supabase
      .from("podcast_feeds")
      .select("user_id")
      .eq("token", token)
      .maybeSingle();

    if (!feed) {
      return new Response("Not Found", {
        status: 404,
        headers: { ...cors, "Content-Type": "text/plain" },
      });
    }

    // Scoped by user_id as well as id, so a valid token can't read another
    // user's episode by guessing its UUID.
    const { data: episode } = await supabase
      .from("podcast_episodes")
      .select("title, chapters")
      .eq("id", id)
      .eq("user_id", feed.user_id)
      .maybeSingle();

    if (!episode) {
      return new Response("Not Found", {
        status: 404,
        headers: { ...cors, "Content-Type": "text/plain" },
      });
    }

    // Stored chapters are [{ startTime: seconds, title: string }, ...].
    const chapters = Array.isArray(episode.chapters) ? episode.chapters : [];

    const body = {
      version: "1.2.0",
      title: episode.title ?? "Listen Later",
      chapters: chapters.map((c: { startTime?: number; title?: string }) => ({
        startTime: c.startTime ?? 0,
        title: c.title ?? "",
      })),
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        ...cors,
        // Podcast apps look for the chapters content type; JSON is a safe superset.
        "Content-Type": "application/json+chapters; charset=utf-8",
        // Per-user document behind a token; keep it out of shared caches.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    return new Response(`Internal Server Error: ${err.message}`, {
      status: 500,
      headers: { ...cors, "Content-Type": "text/plain" },
    });
  }
});
