import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Serves a Podcasting 2.0 "chapters" JSON document for a single episode.
// Referenced from the RSS feed via <podcast:chapters url="...?id=<episode_id>"/>.
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
    if (!id) {
      return new Response(JSON.stringify({ error: "Missing 'id' query parameter" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: episode, error } = await supabase
      .from("podcast_episodes")
      .select("title, chapters")
      .eq("id", id)
      .single();

    if (error) throw error;

    // Stored chapters are [{ startTime: seconds, title: string }, ...].
    const chapters = Array.isArray(episode?.chapters) ? episode.chapters : [];

    const body = {
      version: "1.2.0",
      title: episode?.title ?? "Listen Later",
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
        "Cache-Control": "s-maxage=3600",
      },
    });
  } catch (err) {
    return new Response(`Internal Server Error: ${err.message}`, {
      status: 500,
      headers: { ...cors, "Content-Type": "text/plain" },
    });
  }
});
