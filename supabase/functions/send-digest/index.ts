import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Generate a simple summary from content (first 2 sentences)
function generateSummary(content: string | null, excerpt: string | null): string {
  // Strip inline image markdown (![alt](url)) so an image never bleeds into the
  // email summary when we fall back to the article body.
  const text = (excerpt || content || "").replace(/!\[[^\]]*\]\([^)]+\)/g, " ");
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  return sentences.slice(0, 2).join(". ").trim() + (sentences.length > 0 ? "." : "");
}

// Format a date nicely
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// Build HTML email content
function buildEmailHtml(saves: any[], highlights: any[], weekStart: string, weekEnd: string): string {
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your Stash Weekly Digest</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; margin: 0; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
        <div style="background: #6366f1; color: white; padding: 24px; text-align: center;">
          <h1 style="margin: 0; font-size: 24px;">Your Stash Weekly Digest</h1>
          <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">${weekStart} - ${weekEnd}</p>
        </div>

        <div style="padding: 24px;">
  `;

  // Saved articles section
  if (saves.length > 0) {
    html += `
          <h2 style="font-size: 18px; margin: 0 0 16px; color: #111827;">Saved This Week (${saves.length})</h2>
    `;

    for (const save of saves) {
      const summary = generateSummary(save.content, save.excerpt);
      html += `
          <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #e5e7eb;">
            <a href="${save.url}" style="color: #6366f1; text-decoration: none; font-weight: 600; font-size: 16px;">${save.title || "Untitled"}</a>
            <p style="color: #6b7280; font-size: 12px; margin: 4px 0 8px;">${save.site_name || new URL(save.url).hostname} • ${formatDate(save.created_at)}</p>
            ${summary ? `<p style="color: #374151; font-size: 14px; margin: 0; line-height: 1.5;">${summary.substring(0, 200)}${summary.length > 200 ? "..." : ""}</p>` : ""}
          </div>
      `;
    }
  } else {
    html += `
          <p style="color: #6b7280; font-style: italic;">No new saves this week. Time to find some interesting reads!</p>
    `;
  }

  // Kindle highlights section
  if (highlights.length > 0) {
    html += `
          <h2 style="font-size: 18px; margin: 24px 0 16px; color: #111827;">Kindle Highlights to Revisit</h2>
    `;

    for (const highlight of highlights) {
      html += `
          <div style="margin-bottom: 16px; padding: 16px; background: #fef3c7; border-radius: 8px; border-left: 4px solid #f59e0b;">
            <p style="color: #92400e; font-size: 14px; margin: 0; line-height: 1.6; font-style: italic;">"${highlight.highlight}"</p>
            <p style="color: #b45309; font-size: 12px; margin: 8px 0 0; font-weight: 500;">— ${highlight.title || "Unknown Source"}</p>
          </div>
      `;
    }
  }

  html += `
        </div>

        <div style="background: #f9fafb; padding: 16px 24px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 12px; margin: 0;">
            Sent from your Stash app •
            <a href="#" style="color: #6366f1;">Manage preferences</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  return html;
}

// Build plain text email content
function buildEmailText(saves: any[], highlights: any[], weekStart: string, weekEnd: string): string {
  let text = `YOUR STASH WEEKLY DIGEST\n${weekStart} - ${weekEnd}\n\n`;

  if (saves.length > 0) {
    text += `SAVED THIS WEEK (${saves.length})\n${"=".repeat(40)}\n\n`;
    for (const save of saves) {
      const summary = generateSummary(save.content, save.excerpt);
      text += `${save.title || "Untitled"}\n`;
      text += `${save.site_name || new URL(save.url).hostname} • ${formatDate(save.created_at)}\n`;
      if (summary) text += `${summary.substring(0, 200)}${summary.length > 200 ? "..." : ""}\n`;
      text += `${save.url}\n\n`;
    }
  } else {
    text += `No new saves this week.\n\n`;
  }

  if (highlights.length > 0) {
    text += `\nKINDLE HIGHLIGHTS TO REVISIT\n${"=".repeat(40)}\n\n`;
    for (const highlight of highlights) {
      text += `"${highlight.highlight}"\n— ${highlight.title || "Unknown Source"}\n\n`;
    }
  }

  return text;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY not configured");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get current day/hour in UTC
    const now = new Date();
    const currentDay = now.getUTCDay(); // 0 = Sunday
    const currentHour = now.getUTCHours();

    // Parse request body for optional targeting
    let targetUserId: string | null = null;
    try {
      const body = await req.json();
      targetUserId = body?.user_id || null;
    } catch {
      // No body or invalid JSON is fine
    }

    // Build query for users due for digest
    let query = supabase
      .from("user_preferences")
      .select("*")
      .eq("digest_enabled", true);

    if (targetUserId) {
      // Send to specific user (for testing or manual trigger)
      query = query.eq("user_id", targetUserId);
    } else {
      // Normal cron: match day/hour and check last_digest_sent
      query = query
        .eq("digest_day", currentDay)
        .eq("digest_hour", currentHour);
    }

    const { data: users, error: usersError } = await query;

    if (usersError) throw usersError;

    if (!users || users.length === 0) {
      return new Response(
        JSON.stringify({ message: "No users due for digest", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: any[] = [];
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const weekEnd = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    for (const user of users) {
      try {
        // Skip if already sent within last 6 days (prevent duplicates)
        if (user.last_digest_sent && !targetUserId) {
          const lastSent = new Date(user.last_digest_sent);
          const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
          if (lastSent > sixDaysAgo) {
            results.push({ user_id: user.user_id, status: "skipped", reason: "recently_sent" });
            continue;
          }
        }

        // Get saves from the past week (excluding highlights)
        const { data: saves } = await supabase
          .from("saves")
          .select("id, url, title, excerpt, content, site_name, created_at")
          .eq("user_id", user.user_id)
          .is("highlight", null)
          .gte("created_at", oneWeekAgo)
          .order("created_at", { ascending: false })
          .limit(20);

        // Get random kindle highlights (from all time, with highlight field set)
        const { data: allHighlights } = await supabase
          .from("saves")
          .select("id, title, highlight")
          .eq("user_id", user.user_id)
          .not("highlight", "is", null)
          .eq("source", "kindle");

        // Pick 5 random highlights
        const highlights = allHighlights
          ? allHighlights.sort(() => Math.random() - 0.5).slice(0, 5)
          : [];

        // Skip if nothing to send
        if ((!saves || saves.length === 0) && highlights.length === 0) {
          results.push({ user_id: user.user_id, status: "skipped", reason: "no_content" });
          continue;
        }

        // Build email content
        const htmlContent = buildEmailHtml(saves || [], highlights, weekStart, weekEnd);
        const textContent = buildEmailText(saves || [], highlights, weekStart, weekEnd);

        // Send via Resend
        const emailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "Stash <digest@yourdomain.com>", // User must configure this in Resend
            to: user.digest_email,
            subject: `Your Stash Weekly Digest - ${weekEnd}`,
            html: htmlContent,
            text: textContent,
          }),
        });

        if (!emailRes.ok) {
          const error = await emailRes.text();
          throw new Error(`Resend error: ${error}`);
        }

        // Update last_digest_sent
        await supabase
          .from("user_preferences")
          .update({ last_digest_sent: now.toISOString() })
          .eq("user_id", user.user_id);

        results.push({
          user_id: user.user_id,
          status: "sent",
          saves_count: saves?.length || 0,
          highlights_count: highlights.length,
        });

      } catch (err) {
        results.push({
          user_id: user.user_id,
          status: "error",
          error: err.message,
        });
      }
    }

    const sentCount = results.filter(r => r.status === "sent").length;

    return new Response(
      JSON.stringify({
        message: `Digest emails processed`,
        sent: sentCount,
        total: users.length,
        results
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
