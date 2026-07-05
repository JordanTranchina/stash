"use strict";

// ---------------------------------------------------------------------------
// Helper functions mirrored from supabase/functions/podcast-rss/index.ts
// (Deno edge function; tested in Node/Jest by duplicating the pure helpers)
// ---------------------------------------------------------------------------

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function formatRFC822(dateStr) {
  return new Date(dateStr).toUTCString();
}

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function cdata(str) {
  return `<![CDATA[${str.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function buildRssXml(episodes, chaptersBase = "https://example.supabase.co/functions/v1/podcast-chapters") {
  const items = episodes
    .map((ep) => {
      const title = escapeXml(ep.title ?? "Untitled");
      const description = cdata(ep.description ?? "");
      const pubDate = formatRFC822(ep.created_at);
      const duration = formatDuration(ep.duration_seconds ?? 0);
      const enclosureLength = ep.size_bytes ?? 0;
      const audioUrl = escapeXml(ep.audio_url ?? "");

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

  return `<?xml version="1.0" encoding="UTF-8"?>
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  test("zero seconds", () => {
    expect(formatDuration(0)).toBe("00:00:00");
  });

  test("exactly one hour", () => {
    expect(formatDuration(3600)).toBe("01:00:00");
  });

  test("mixed hours, minutes, seconds", () => {
    expect(formatDuration(3661)).toBe("01:01:01");
  });

  test("90 seconds", () => {
    expect(formatDuration(90)).toBe("00:01:30");
  });

  test("pads single-digit values", () => {
    expect(formatDuration(61)).toBe("00:01:01");
  });
});

describe("formatRFC822", () => {
  test("produces a non-empty string for a valid ISO date", () => {
    const result = formatRFC822("2026-01-15T08:00:00.000Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("contains the year", () => {
    const result = formatRFC822("2026-01-15T08:00:00.000Z");
    expect(result).toMatch(/2026/);
  });

  test("contains GMT suffix (UTC string format)", () => {
    const result = formatRFC822("2026-01-15T08:00:00.000Z");
    expect(result).toMatch(/GMT/);
  });
});

describe("escapeXml", () => {
  test("escapes ampersand", () => {
    expect(escapeXml("A & B")).toBe("A &amp; B");
  });

  test("escapes angle brackets", () => {
    expect(escapeXml("<tag>")).toBe("&lt;tag&gt;");
  });

  test("escapes double quotes", () => {
    expect(escapeXml('"quoted"')).toBe("&quot;quoted&quot;");
  });

  test("leaves plain strings unchanged", () => {
    expect(escapeXml("Hello World")).toBe("Hello World");
  });
});

describe("buildRssXml", () => {
  const mockEpisodes = [
    {
      id: "abc-123",
      title: "Episode One",
      description: "A great episode",
      audio_url: "https://example.com/ep1.mp3",
      duration_seconds: 1800,
      size_bytes: 24000000,
      created_at: "2026-01-15T08:00:00.000Z",
    },
    {
      id: "def-456",
      title: "Episode Two & Three",
      description: null,
      audio_url: "https://example.com/ep2.mp3",
      duration_seconds: 2700,
      size_bytes: 36000000,
      created_at: "2026-01-22T08:00:00.000Z",
    },
  ];

  let xml;
  beforeAll(() => {
    xml = buildRssXml(mockEpisodes);
  });

  test("starts with XML declaration", () => {
    expect(xml).toMatch(/^<\?xml version="1\.0"/);
  });

  test("contains rss root element with version 2.0", () => {
    expect(xml).toMatch(/<rss version="2\.0"/);
  });

  test("includes iTunes namespace", () => {
    expect(xml).toMatch(/xmlns:itunes="http:\/\/www\.itunes\.com\/dtds\/podcast-1\.0\.dtd"/);
  });

  test("contains channel element", () => {
    expect(xml).toMatch(/<channel>/);
  });

  test("contains one <item> per episode", () => {
    const matches = xml.match(/<item>/g);
    expect(matches).toHaveLength(2);
  });

  test("includes enclosure tag with audio/mpeg type", () => {
    expect(xml).toMatch(/<enclosure url="https:\/\/example\.com\/ep1\.mp3" length="24000000" type="audio\/mpeg"/);
  });

  test("formats itunes:duration correctly", () => {
    // 1800s = 00:30:00, 2700s = 00:45:00
    expect(xml).toMatch(/<itunes:duration>00:30:00<\/itunes:duration>/);
    expect(xml).toMatch(/<itunes:duration>00:45:00<\/itunes:duration>/);
  });

  test("includes guid for each episode", () => {
    expect(xml).toMatch(/<guid isPermaLink="false">abc-123<\/guid>/);
    expect(xml).toMatch(/<guid isPermaLink="false">def-456<\/guid>/);
  });

  test("escapes special characters in title", () => {
    expect(xml).toMatch(/Episode Two &amp; Three/);
  });

  test("produces valid XML (no unescaped ampersands outside CDATA)", () => {
    // All & in content should be &amp;
    const withoutDeclaration = xml.replace(/<\?xml[^?]*\?>/, "");
    const bareAmpersands = withoutDeclaration.match(/&(?!amp;|lt;|gt;|quot;|apos;)[a-zA-Z#]/g);
    expect(bareAmpersands).toBeNull();
  });

  test("handles empty episode list", () => {
    const emptyXml = buildRssXml([]);
    expect(emptyXml).toMatch(/<channel>/);
    expect(emptyXml).not.toMatch(/<item>/);
  });

  test("includes the podcast namespace", () => {
    expect(xml).toMatch(/xmlns:podcast="https:\/\/podcastindex\.org\/namespace\/1\.0"/);
  });

  test("wraps the description in CDATA so HTML links render", () => {
    const html =
      'Discussing:<ul><li><a href="https://ex.com/a" target="_blank" rel="noopener">A</a> (1:23)</li></ul>';
    const out = buildRssXml([
      {
        id: "html-desc",
        title: "Has links",
        description: html,
        audio_url: "https://example.com/a.mp3",
        duration_seconds: 100,
        size_bytes: 1,
        created_at: "2026-01-15T08:00:00.000Z",
      },
    ]);
    // The HTML (including the anchor tag) is preserved verbatim inside CDATA,
    // not entity-escaped.
    expect(out).toContain(`<description><![CDATA[${html}]]></description>`);
  });

  test("splits a literal ]]> in the description so CDATA can't terminate early", () => {
    const out = buildRssXml([
      {
        id: "cdata-escape",
        title: "Edge",
        description: "before ]]> after",
        audio_url: "https://example.com/a.mp3",
        duration_seconds: 100,
        size_bytes: 1,
        created_at: "2026-01-15T08:00:00.000Z",
      },
    ]);
    expect(out).toContain("before ]]]]><![CDATA[> after");
  });
});

describe("podcast:chapters", () => {
  test("emits a chapters tag only for episodes that have chapters", () => {
    const xml = buildRssXml([
      {
        id: "with-ch",
        title: "Has chapters",
        audio_url: "https://example.com/a.mp3",
        duration_seconds: 100,
        size_bytes: 1,
        created_at: "2026-01-15T08:00:00.000Z",
        chapters: [{ startTime: 0, title: "Intro" }],
      },
      {
        id: "no-ch",
        title: "No chapters",
        audio_url: "https://example.com/b.mp3",
        duration_seconds: 100,
        size_bytes: 1,
        created_at: "2026-01-16T08:00:00.000Z",
        chapters: [],
      },
    ]);

    const tags = xml.match(/<podcast:chapters /g) || [];
    expect(tags).toHaveLength(1);
    expect(xml).toMatch(
      /<podcast:chapters url="https:\/\/example\.supabase\.co\/functions\/v1\/podcast-chapters\?id=with-ch" type="application\/json\+chapters"\/>/
    );
  });

  test("omits chapters tag when chapters field is absent", () => {
    const xml = buildRssXml([
      {
        id: "x",
        title: "t",
        audio_url: "u",
        duration_seconds: 1,
        size_bytes: 1,
        created_at: "2026-01-15T08:00:00.000Z",
      },
    ]);
    expect(xml).not.toMatch(/<podcast:chapters/);
  });
});
