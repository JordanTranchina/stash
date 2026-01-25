# **Product Spec: Listen Later (Stash-to-Podcast RSS)**

## **1\. Overview**

Listen Later is a "Software for One" utility that transforms articles saved in a user's **Stash** (open-source read-it-later app) into a conversational AI podcast. It automates extraction, scriptwriting, audio generation, and RSS distribution, allowing the user to listen to their reading list in any standard podcast player.

## **2\. Technical Stack**

- **Database:** Supabase (connecting to existing Stash tables).
- **LLM (Scriptwriting):**
  - **Primary (Low Cost):** **Gemini 2.5 Flash-Lite** (Optimized for speed and minimal token cost).
  - **Alternative:** **GPT-4o-mini** (High-quality synthesis at a competitive price point).
- **TTS:** OpenAI TTS (shimmer and alloy voices) OR **Qwen3-TTS** (Open-Source fallback for local/self-hosting).
- **Storage:** Supabase Storage (for hosting MP3 files).
- **Hosting:** Vercel (Next.js/Node.js) to serve the RSS XML.
- **Trigger:** GitHub Actions or a Vercel Cron Job.

## **3\. Functional Requirements**

### **Phase 1: Data Extraction**

- Connect to the Supabase database used by the **Stash** installation.
- Query the articles table for entries where created_at is within the configured lookback period (default 7 days) AND archived is false.
- Extract the title, source_url, and content (plain text) for each article.

### **Phase 2: AI Scriptwriting (The "Vibe" Engine)**

- Pass the aggregated text to the selected low-cost LLM with a specific system prompt:
  - **Persona:** Two hosts, "Alex" and "Taylor," who are witty, insightful, and casual.
  - **Format:** A dialogue summarizing themes, highlighting 3–5 key articles, and connecting the dots between them.
  - **Output:** A structured JSON or tagged text format separating Alex’s lines from Taylor’s lines.

### **Phase 3: Audio Generation & Assembly**

- Send lines to audio API (OpenAI or local Qwen3-TTS instance).
- **Voice Selection:** \* If OpenAI: Assign shimmer voice to Alex and alloy voice to Taylor.
  - If Qwen3-TTS: Use the VoiceDesign capability to define Alex as a "confident, fast-talking male" and Taylor as a "curious, witty female."
- Stitch the audio segments into a single MP3 file (using ffmpeg or a similar library).
- **Metadata:** Add ID3 tags (Title: "Listen Later \-![][image1]  
  ", Artist: "Listen Later").

### **Phase 4: Storage & Distribution**

- Upload the final MP3 to a public Supabase Storage bucket.
- Update/Generate an rss.xml file following the iTunes/Podcast RSS standard.
- The rss.xml must include:
  - \<title\>: Listen Later
  - \<enclosure\>: Public URL of the MP3.
  - \<pubDate\>: Current timestamp.
- Serve the rss.xml via a public route (e.g., /api/podcast/rss).

## **4\. User Experience (The "One-Time" Setup)**

1. User provides Supabase URL/Key and AI API Key.
2. User copies the generated RSS URL.
3. User pastes the URL into their podcast app (e.g., Pocket Casts).
4. The podcast app automatically updates with new episodes based on the trigger frequency.

## **5\. Scriptwriting Prompt (Logic)**

"You are the writers for a tech-savvy, conversational podcast. Review the following articles saved recently. Create a script where two hosts discuss these topics. Don't just read summaries; analyze why I might have saved these and how they relate to each other. Keep the tone 'Hard Fork-esque'—smart but accessible."

## **6\. Future Iterations**

- **Daily Frequency:** Shift from a weekly trigger to a daily "Morning Brief" by adjusting the cron schedule and lookback window.
- **On-Demand Generation:** Integrate a "Generate Podcast Now" button directly within the Stash UI to trigger the pipeline for the current queue immediately.
- **Custom Personalities:** Allow the user to define specific host "vibes" or topics of interest via a simple settings panel.
- **Interactive RSS:** Support for "chapters" in the MP3 so the user can skip to specific articles mentioned in the audio.
- **E2E Testing**: Set up automated end-to-end testing for the extension using Playwright.

## **7\. Success Metrics**

- RSS Feed validates correctly in standard podcast validators.

[image1]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAmwAAAA1CAYAAAD8i7czAAACCUlEQVR4Xu3cMYsTQRQH8BMrK7HRItnN7AbUykYQRCzE72EhwjWCX8DKwsbSQr+BlYUgaqeFlc2VloKNiK2CgqBvYCcOw4XbA68Qfz8Y8t6bt0n7h5Ds7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8I9arVZ34/wqfUrpfO7jfK33DtJ13bqdAQDwF0Qw+xDn7T7zTYib47D7AADMlIPWcrk80c5TSu/ibq+db3FMYAMAOCLbglbf9x/j7mc9m74q/TwMw6V4fV3NNqfZ34vzKc6Peg4AwEwRvM60IavI8whtj3I9juPZem8KZy+b/mnpy6zu473u1z0AADNEiHocwep7O18sFst9AlrbX677CH8XSh+Ol/34jItRf6vuAACYawpe17bMN1+H5j6ltFv3pd7SP4nzvp4BAHBIEcBSG7Sm+bOYv6hn9V7Ut+K8yXXf92PUt+M8n+7uTa/5r0Ielmem3et1DwDAASJAvaqD2Hq9Pp2DV5wv9V6W9+K+K3U8e2cYhtXUP8ghbqo3vyptQt7NHBBLDwDAEcg/UBjH8WSuu667GqHtVLmL+krcn/uzvZnfaGcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/63fF+JogThXwdQAAAAASUVORK5CYII=
