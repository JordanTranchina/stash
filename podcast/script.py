import os
import json
import requests
import google.generativeai as genai
import asyncio
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv
import edge_tts
from extract import fetch_recent_articles

# Load environment variables
load_dotenv()

# Supabase configuration
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
USER_ID = os.getenv("USER_ID")

# System prompt for Alex and Taylor
SYSTEM_PROMPT = """
You are the witty, insightful, and casual producers and hosts of "Listen Later," a personalized daily podcast. 
Your goal is to summarize a set of articles stashed by the user.

PERSONAS:
- ALEX: Confident, tech-savvy, fast-talking, slightly cynical but enthusiastic about good ideas. 
- TAYLOR: Curious, witty, plays the "straight man" to Alex's intensity, focuses on the "why this matters" and human impact.

TONE:
- "Hard Fork-esque" (smart, accessible, conversational).
- Don't just read summaries; analyze why the user might have saved these and how they relate to each other.
- Use natural transitions between articles.
- Avoid sounding like a dry news report. Use "Alex:" and "Taylor:" prefixes for dialogue.

OUTPUT FORMAT:
Return a JSON array of objects. Each object must have a "speaker" (Alex or Taylor) and "text" (their dialogue line).
Example:
[
  { "speaker": "Alex", "text": "Taylor, did you see this piece on local-first software?" },
  { "speaker": "Taylor", "text": "I did! It's such a shift from the last decade of cloud-only thinking." }
]

Do not include any other text, markdown, or explanations. Only return the raw JSON array.
"""

def generate_script(articles):
    """Generate a conversational script based on the provided articles."""
    gemini_api_key = os.getenv("GEMINI_API_KEY")
    if not gemini_api_key:
        print("Error: GEMINI_API_KEY not found. Please set it in your environment.")
        return None

    if not articles:
        print("No articles to summarize.")
        return None

    genai.configure(api_key=gemini_api_key)
    
    # Using Gemini Flash for reliability and speed
    model = genai.GenerativeModel(
        model_name="gemini-flash-latest",
        system_instruction=SYSTEM_PROMPT
    )

    # Prepare article content for the prompt
    articles_payload = []
    for art in articles:
        articles_payload.append({
            "title": art["title"],
            "site": art["site_name"],
            "content": art["content"]
        })

    prompt = f"Here are the articles to discuss today:\n\n{json.dumps(articles_payload, indent=2)}"

    try:
        response = model.generate_content(prompt)
        
        # Clean up the response text in case Gemini adds markdown code blocks
        content = response.text.strip()
        if content.startswith("```json"):
            content = content[7:]
        if content.endswith("```"):
            content = content[:-3]
        
        script = json.loads(content)
        return script
    except Exception as e:
        print(f"Error generating script: {e}")
        return None

async def generate_audio(script, output_dir="podcast/temp_audio"):
    """Generate audio files for each line of the script using edge-tts."""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    audio_files = []
    
    print(f"Generating audio for {len(script)} lines...")
    
    for i, line in enumerate(script):
        speaker = line.get("speaker", "Alex")
        text = line.get("text", "")
        
        # Select voice based on speaker
        # Alex: Andrew (Male), Taylor: Ava (Female)
        voice = "en-US-AndrewNeural" if speaker == "Alex" else "en-US-AvaNeural"
        
        filename = output_path / f"line_{i:03d}.mp3"
        communicate = edge_tts.Communicate(text, voice)
        
        try:
            await communicate.save(str(filename))
            audio_files.append(str(filename))
        except Exception as e:
            print(f"Error generating audio for line {i}: {e}")
    
    print(f"Generated {len(audio_files)} audio clips in {output_dir}")
    return audio_files

def save_to_supabase(script, articles):
    """Save the generated script and metadata to Supabase."""
    if not all([SUPABASE_URL, SUPABASE_KEY, USER_ID]):
        print("Error: Missing Supabase credentials. Skipping Supabase save.")
        return None

    url = f"{SUPABASE_URL}/rest/v1/podcast_episodes"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }

    # Generate metadata
    article_ids = [art["id"] for art in articles]
    date_str = datetime.now().strftime("%B %d, %Y")
    title = f"Listen Later: {date_str}"
    
    # Simple description based on article titles
    description = "Discussing: " + ", ".join([art["title"] for art in articles])

    payload = {
        "user_id": USER_ID,
        "title": title,
        "description": description,
        "related_article_ids": article_ids,
        "script_json": script
    }

    try:
        response = requests.post(url, headers=headers, json=payload)
        if response.status_code in [201, 200]:
            created_episode = response.json()[0]
            print(f"Episode saved to Supabase (ID: {created_episode['id']})")
            return created_episode["id"]
        else:
            print(f"Error saving to Supabase: {response.status_code} - {response.text}")
            return None
    except Exception as e:
        print(f"Error saving to Supabase: {e}")
        return None

def save_script_locally(script, filename="podcast/script.json"):
    """Save the generated script to a local file."""
    with open(filename, "w") as f:
        json.dump(script, f, indent=2)
    print(f"Script saved locally to {filename}")

    print(f"Script saved locally to {filename}")

async def main():
    # Integration test: Fetch articles and generate script
    print("Fetching articles...")
    articles = fetch_recent_articles(limit=3) # Limit to 3 for testing
    
    if articles:
        print(f"Generating script for {len(articles)} articles...")
        script = generate_script(articles)
        
        if script:
            save_script_locally(script)
            save_to_supabase(script, articles)
            
            print("\nPreview of first 3 lines:")
            for line in script[:3]:
                print(f"{line['speaker']}: {line['text']}")
                
            # Generate Audio
            await generate_audio(script)
            
        else:
            print("Failed to generate script.")
    else:
        print("No recent articles found to process.")

if __name__ == "__main__":
    asyncio.run(main())
