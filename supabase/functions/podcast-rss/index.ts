import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Convert integer seconds to HH:MM:SS format required by iTunes
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

// Convert ISO 8601 timestamp to RFC-822 format required by RSS pubDate
export function formatRFC822(dateStr: string): string {
  return new Date(dateStr).toUTCString();
}

// Escape special XML characters in text content
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Wrap HTML content in a CDATA section so podcast clients render it as markup
// (the episode description is HTML with links). Any literal "]]>" is split so
// it can't terminate the section early.
function cdata(str: string): string {
  return `<![CDATA[${str.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

serve(async (req) => {
  try {
    // Podcast apps can't sign in, so the feed is scoped by an unguessable token
    // from podcast_feeds instead of a JWT. No token, no feed.
    const token = new URL(req.url).searchParams.get("token");
    if (!token) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
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

    // An unknown token is a 404, not a 500 — podcast apps retry 5xx forever but
    // handle a 404 as "this feed is gone".
    if (!feed) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const { data: episodes, error } = await supabase
      .from("podcast_episodes")
      .select("id, title, description, audio_url, duration_seconds, size_bytes, created_at, chapters")
      .eq("user_id", feed.user_id)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw error;

    // Base URLs for the companion chapters endpoint (Podcasting 2.0 chapters)
    // and this feed itself. Both carry the token: the chapters endpoint uses it
    // to check the episode belongs to this feed's user.
    const functionsBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
    const chaptersBase = `${functionsBase}/podcast-chapters`;
    const selfUrl = `${functionsBase}/podcast-rss?token=${token}`;

    const items = (episodes ?? [])
      .map((ep) => {
        const title = escapeXml(ep.title ?? "Untitled");
        // Description is HTML (links + timestamps); emit as CDATA so clients render it.
        const description = cdata(ep.description ?? "");
        const pubDate = formatRFC822(ep.created_at);
        const duration = formatDuration(ep.duration_seconds ?? 0);
        const enclosureLength = ep.size_bytes ?? 0;
        const audioUrl = escapeXml(ep.audio_url ?? "");

        // Only advertise chapters when the episode actually has them.
        const hasChapters = Array.isArray(ep.chapters) && ep.chapters.length > 0;
        const chaptersTag = hasChapters
          ? `\n      <podcast:chapters url="${escapeXml(`${chaptersBase}?id=${ep.id}&token=${token}`)}" type="application/json+chapters"/>`
          : "";

        return `    <item>
      <title>${title}</title>
      <description>${description}</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${ep.id}</guid>
      <enclosure url="${audioUrl}" length="${enclosureLength}" type="audio/mpeg"/>
      <itunes:duration>${duration}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>${chaptersTag}
    </item>`;
      })
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:content="http://purl.org/rss/modules/content/"
  xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Stash: Listen Later</title>
    <link>https://stash.app</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>Your personal Stash articles, read aloud by AI.</description>
    <language>en-us</language>
    <itunes:author>Stash</itunes:author>
    <itunes:category text="Technology"/>
    <itunes:explicit>false</itunes:explicit>
    <itunes:block>yes</itunes:block>
${items}
  </channel>
</rss>`;

    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        // Private per-user feed: a shared cache (s-maxage) would risk serving
        // one listener's episodes to another.
        "Cache-Control": "private, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(`Internal Server Error: ${err.message}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
});
