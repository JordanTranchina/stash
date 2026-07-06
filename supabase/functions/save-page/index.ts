import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// `?external=canvas` keeps esm.sh/the edge bundler from trying to build
// linkedom's optional native `canvas` dependency (a .node binary that fails to
// bundle). We never render <canvas>, so it's only ever lazily referenced.
import { parseHTML } from "https://esm.sh/linkedom@0.16.8?external=canvas";
import { Readability } from "https://esm.sh/@mozilla/readability@0.5.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Hosts that wrap the real article behind a redirect/interstitial page (share
// sheets, link shorteners). When we land on one of these we try to discover the
// canonical destination and re-fetch it so Readability sees the real article.
const REDIRECT_WRAPPER_HOSTS = [
  "share.google",
  "www.google.com",
  "news.google.com",
  "l.facebook.com",
  "t.co",
  "lnkd.in",
  "trib.al",
];

// Extract meta content by name or property
function extractMeta(doc: any, attr: string, value: string): string | null {
  const el = doc.querySelector(`meta[${attr}="${value}"]`);
  return el?.getAttribute("content") || null;
}

// Pull the most likely "real" destination URL out of an interstitial/redirect
// page: a meta-refresh, canonical link, og:url, or a prominent anchor.
function findRedirectTarget(html: string, currentUrl: string): string | null {
  const { document } = parseHTML(html);

  // <meta http-equiv="refresh" content="0; url=https://...">
  const refresh = document.querySelector('meta[http-equiv="refresh"], meta[http-equiv="Refresh"]');
  const refreshContent = refresh?.getAttribute("content");
  if (refreshContent) {
    const match = refreshContent.match(/url=([^;]+)/i);
    if (match) {
      try { return new URL(match[1].trim().replace(/['"]/g, ""), currentUrl).href; } catch { /* ignore */ }
    }
  }

  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const ogUrl = extractMeta(document, "property", "og:url");
  const candidate = canonical || ogUrl;
  if (candidate) {
    try {
      const resolved = new URL(candidate, currentUrl);
      // Only treat it as a redirect if it points somewhere other than the wrapper.
      if (resolved.hostname !== new URL(currentUrl).hostname) return resolved.href;
    } catch { /* ignore */ }
  }

  return null;
}

// Class/id/data-track fragments that mark recirculation, promo and chrome
// blocks (related-article teasers, "popular stories", newsletter/subscribe
// prompts, share bars, comments). These modules routinely contain text
// truncated with "…" that Readability otherwise swallows into the article body.
const NOISE_RE = /(?:^|[\s_-])(related|popular|recirc|read-?more|more-?stories|newsletter|subscribe|promo|social|share-?(?:bar|button|tool)|comment|disqus|trending|recommend|outbrain|taboola|linkback|sidebar)(?:[\s_-]|$)/i;

// Strip obvious non-article nodes from the DOM before Readability scores it, so
// sidebars and "you might also like" teaser cards don't get merged into the
// content. Conservative on purpose: only clear chrome tags and elements whose
// id/class/data-track advertise themselves as recirculation/promo.
function removeNoise(document: any) {
  document
    .querySelectorAll("script,style,noscript,iframe,svg,form,nav,aside,footer")
    .forEach((el: any) => el.remove());

  document.querySelectorAll("[class],[id],[data-track]").forEach((el: any) => {
    const signature = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""} ${el.getAttribute("data-track") || ""}`;
    if (NOISE_RE.test(signature)) el.remove();
  });
}

// Resolve an image/link URL to an absolute one, skipping empty / inline data
// URIs. Relative paths are resolved against the article URL so they still load.
function resolveUrl(src: string | null, baseUrl: string): string | null {
  if (!src) return null;
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith("data:")) return null;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return null;
  }
}

// Serialize Readability's article HTML to Markdown, keeping images inline where
// they appear in the article (Pocket-style) rather than dropping them. The
// reading view renders this Markdown with `marked`, so `![alt](src)` becomes an
// inline <img>. Text is whitespace-normalized the same way the old paragraph
// extractor was, so recirculation teaser cards don't run words together.
function htmlToMarkdown(root: any, baseUrl: string): string {
  function walk(node: any): string {
    let out = "";
    node.childNodes.forEach((child: any) => {
      // 3 = TEXT_NODE, 1 = ELEMENT_NODE
      if (child.nodeType === 3) {
        out += (child.textContent || "").replace(/\s+/g, " ");
      } else if (child.nodeType === 1) {
        const tag = (child.tagName || "").toLowerCase();
        if (tag === "img") {
          const src = child.getAttribute("src") ||
                      child.getAttribute("data-src") ||
                      child.getAttribute("data-original") ||
                      child.getAttribute("data-lazy-src");
          const abs = resolveUrl(src, baseUrl);
          if (abs) {
            const alt = (child.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
            out += `\n\n![${alt}](${abs})\n\n`;
          }
        } else if (["p", "div", "section", "article", "header", "figure"].includes(tag)) {
          out += "\n\n" + walk(child) + "\n\n";
        } else if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
          out += "\n\n" + "#".repeat(Number(tag[1])) + " " + walk(child).trim() + "\n\n";
        } else if (tag === "br") {
          out += "\n";
        } else if (tag === "li") {
          out += "\n- " + walk(child).trim();
        } else if (["ul", "ol"].includes(tag)) {
          out += "\n" + walk(child) + "\n";
        } else if (tag === "blockquote") {
          const inner = walk(child).trim().split("\n").map((l) => "> " + l).join("\n");
          out += "\n\n" + inner + "\n\n";
        } else if (tag === "figcaption") {
          const caption = walk(child).trim();
          if (caption) out += "\n\n*" + caption + "*\n\n";
        } else if (tag === "a") {
          const href = child.getAttribute("href");
          const text = walk(child).trim();
          const abs = resolveUrl(href, baseUrl);
          if (abs && text && !href.startsWith("#")) out += `[${text}](${abs})`;
          else out += text;
        } else if (["strong", "b"].includes(tag)) {
          out += "**" + walk(child) + "**";
        } else if (["em", "i"].includes(tag)) {
          out += "*" + walk(child) + "*";
        } else if (tag === "code") {
          out += "`" + walk(child) + "`";
        } else if (tag === "pre") {
          out += "\n\n```\n" + walk(child) + "\n```\n\n";
        } else if (["script", "style", "noscript", "iframe"].includes(tag)) {
          // skip
        } else {
          out += walk(child);
        }
      }
    });
    return out;
  }

  return walk(root)
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Parse HTML and extract article data
function extractArticle(html: string, url: string) {
  const { document } = parseHTML(html);
  removeNoise(document);
  const reader = new Readability(document);
  const article = reader.parse();

  const title = article?.title ||
               extractMeta(document, "property", "og:title") ||
               document.querySelector("title")?.textContent ||
               "Untitled";

  const excerpt = article?.excerpt ||
                 extractMeta(document, "name", "description") ||
                 extractMeta(document, "property", "og:description") ||
                 "";

  const image_url = extractMeta(document, "property", "og:image");

  const site_name = extractMeta(document, "property", "og:site_name") ||
                   new URL(url).hostname.replace("www.", "");

  const author = article?.byline ||
                extractMeta(document, "name", "author") ||
                extractMeta(document, "property", "article:author") ||
                null;

  // Serialize the article body to Markdown, keeping images inline where they
  // appear (Pocket-style) instead of dropping them. Relative image/link URLs
  // are resolved against the article URL so they still load in the reading view.
  let content = "";
  if (article?.content) {
    const { document: articleDoc } = parseHTML(article.content);
    // Readability returns a `<div id="readability-page-1">…</div>` fragment, so
    // the content sits under documentElement (linkedom leaves an empty <body>
    // for a bare fragment). documentElement always holds the parsed nodes.
    content = htmlToMarkdown(articleDoc.documentElement || articleDoc.body || articleDoc, url);
  }

  if (!content && article?.textContent) {
    content = article.textContent;
  }

  return { title, excerpt, image_url, site_name, author, content };
}

// Fetch a URL as a browser would, transparently following redirect-wrapper
// pages (share.google, t.co, etc.) up to a couple of hops. Returns the final
// HTML and the resolved URL it came from.
async function fetchArticleHtml(inputUrl: string): Promise<{ html: string; finalUrl: string }> {
  let currentUrl = inputUrl;

  for (let hop = 0; hop < 3; hop++) {
    const response = await fetch(currentUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    // response.url reflects any HTTP-level redirects that were followed.
    const resolvedUrl = response.url || currentUrl;
    const html = response.ok ? await response.text() : "";
    if (!html) return { html, finalUrl: resolvedUrl };

    // If we landed on a known wrapper host (or the HTML looks like an
    // interstitial), try to discover the real destination and follow it.
    const host = new URL(resolvedUrl).hostname.replace(/^www\./, "");
    const isWrapper = REDIRECT_WRAPPER_HOSTS.some((h) => host === h || host.endsWith("." + h));
    if (isWrapper) {
      const target = findRedirectTarget(html, resolvedUrl);
      if (target && target !== resolvedUrl) {
        currentUrl = target;
        continue;
      }
    }

    return { html, finalUrl: resolvedUrl };
  }

  // Ran out of hops; do one last plain fetch of wherever we ended up.
  const response = await fetch(currentUrl, { headers: { "User-Agent": BROWSER_UA }, redirect: "follow" });
  return { html: response.ok ? await response.text() : "", finalUrl: response.url || currentUrl };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url, user_id, highlight, source, prefetched } = await req.json();

    if (!url || !user_id) {
      return new Response(
        JSON.stringify({ error: "url and user_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let article: any = null;
    let resolvedUrl = url;

    // If client sent prefetched data, use it (handles paywalled sites, etc.)
    if (prefetched) {
      console.log("Using prefetched data from client");
      article = {
        title: prefetched.title || "Untitled",
        excerpt: prefetched.excerpt || "",
        content: prefetched.content || "",
        image_url: prefetched.image_url || null,
        site_name: prefetched.site_name || new URL(url).hostname.replace("www.", ""),
        author: prefetched.author || null,
      };
    } else {
      // Server-side fetch, following share-link/redirect wrappers to the real
      // article so we scrape the full content the way Pocket does.
      const { html, finalUrl } = await fetchArticleHtml(url);
      resolvedUrl = finalUrl;
      article = html ? extractArticle(html, finalUrl) : null;
    }

    if (!article) {
      throw new Error("Could not extract article content");
    }

    // Always store the scraped article body. A highlight/note is stored
    // alongside it (not instead of it) so a saved article is fully readable —
    // matching Pocket's behaviour rather than just keeping the shared snippet.
    const content = article.content
      ? String(article.content).substring(0, 100000)
      : null;

    // Build save object. Persist the resolved URL so share.google-style links
    // land on the real article.
    const saveData: Record<string, unknown> = {
      user_id,
      url: resolvedUrl,
      title: article.title,
      excerpt: article.excerpt,
      content,
      highlight: highlight || null,
      image_url: article.image_url,
      site_name: article.site_name,
      author: article.author,
      source: source || "api",
    };

    // Save to database
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data, error } = await supabase
      .from("saves")
      .insert(saveData)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return new Response(
      JSON.stringify({ success: true, save: data }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
