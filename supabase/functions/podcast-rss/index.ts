import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { reportError } from "../_shared/sentry.ts";

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

// A shared, no-user-data recording served to every feed that has no real
// episodes yet, so subscribing always shows a new listener *something*
// instead of an empty show. `-v1` is part of the guid so a future
// re-recording can bump it and force clients to treat it as a new item
// rather than silently reusing a cached copy under the same guid.
const WELCOME_GUID = "stash-welcome-v1";
const WELCOME_DURATION_SECONDS = 30;
const WELCOME_SIZE_BYTES = 179750;

function renderWelcomeItem(supabaseUrl: string, feedCreatedAt: string): string {
  const audioUrl = `${supabaseUrl}/storage/v1/object/public/podcasts/welcome.mp3`;
  // pubDate is the subscriber's own signup time, not now() — a fixed date
  // means the item never looks "new" on a re-poll (which would resurface it
  // and re-notify the listener every few hours), and it still reads sensibly
  // ("your show started when you signed up") however long ago that was.
  const pubDate = formatRFC822(feedCreatedAt);
  return `    <item>
      <title>Welcome to your Stash podcast</title>
      <description>${cdata(
        "Your daily episode appears here once you've saved a few articles — " +
          "turn on Podcasts in Stash settings if you haven't already, then " +
          "save something to read later. Episodes land here each morning."
      )}</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${WELCOME_GUID}</guid>
      <enclosure url="${escapeXml(audioUrl)}" length="${WELCOME_SIZE_BYTES}" type="audio/mpeg"/>
      <itunes:duration>${formatDuration(WELCOME_DURATION_SECONDS)}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
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
      .select("user_id, created_at")
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
      .select("id, title, description, audio_url, duration_seconds, size_bytes, created_at, chapters, artwork_url")
      .eq("user_id", feed.user_id)
      // A run can die between inserting the episode row (script.py's
      // save_to_supabase) and uploading its MP3 (upload_audio_to_supabase),
      // leaving a row with no audio_url. Excluding those here means a
      // mid-pipeline failure never surfaces as an unplayable "" enclosure.
      .not("audio_url", "is", null)
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
        const imageTag = ep.artwork_url
          ? `\n      <itunes:image href="${escapeXml(ep.artwork_url)}"/>`
          : "";

        return `    <item>
      <title>${title}</title>
      <description>${description}</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${ep.id}</guid>
      <enclosure url="${audioUrl}" length="${enclosureLength}" type="audio/mpeg"/>
      <itunes:duration>${duration}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>${imageTag}${chaptersTag}
    </item>`;
      })
      .join("\n");

    // No real episodes yet (new subscriber, or a quiet stretch before the
    // first one lands) — show the welcome item instead of an empty feed.
    const itemsXml = (episodes ?? []).length > 0
      ? items
      : renderWelcomeItem(Deno.env.get("SUPABASE_URL")!, feed.created_at);

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
${itemsXml}
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
    await reportError(err, "podcast-rss");
    return new Response(`Internal Server Error: ${err.message}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
});
