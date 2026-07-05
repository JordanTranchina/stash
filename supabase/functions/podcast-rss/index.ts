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

serve(async () => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: episodes, error } = await supabase
      .from("podcast_episodes")
      .select("id, title, description, audio_url, duration_seconds, size_bytes, created_at, chapters")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw error;

    // Base URL for the companion chapters endpoint (Podcasting 2.0 chapters).
    const chaptersBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1/podcast-chapters`;

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
          ? `\n      <podcast:chapters url="${escapeXml(`${chaptersBase}?id=${ep.id}`)}" type="application/json+chapters"/>`
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
  xmlns:content="http://purl.org/rss/modules/content/"
  xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Stash: Listen Later</title>
    <link>https://stash.app</link>
    <description>Your personal Stash articles, read aloud by AI.</description>
    <language>en-us</language>
    <itunes:author>Stash</itunes:author>
    <itunes:category text="Technology"/>
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>`;

    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "s-maxage=3600",
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
