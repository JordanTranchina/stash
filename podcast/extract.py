import os
import requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") # Use service role key for backend extraction
USER_ID = os.getenv("USER_ID")

def get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json"
    }

def clean_text(text):
    """Basic cleaning of article content."""
    import re
    if not text:
        return ""
    # Remove excessive newlines
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Remove common artifacts if any (can be expanded)
    return text.strip()

def fetch_recent_articles(days=7, limit=5):
    """Fetch unarchived articles from the last X days."""
    lookback_date = (datetime.now() - timedelta(days=days)).isoformat()
    
    url = f"{SUPABASE_URL}/rest/v1/saves"
    params = {
        "select": "id,title,content,excerpt,site_name,created_at",
        "user_id": f"eq.{USER_ID}",
        "is_archived": "eq.false",
        "created_at": f"gt.{lookback_date}",
        "order": "created_at.desc",
        "limit": limit
    }
    
    response = requests.get(url, headers=get_headers(), params=params)
    
    if response.status_code != 200:
        print(f"Error fetching articles: {response.status_code} - {response.text}")
        return []
    
    articles = response.json()
    formatted_articles = []
    
    for article in articles:
        content = article.get("content") or article.get("excerpt") or ""
        formatted_articles.append({
            "id": article["id"],
            "title": article["title"],
            "site_name": article.get("site_name") or "Unknown",
            "content": clean_text(content[:5000]), # Limit to 5k chars per article for context window
            "created_at": article["created_at"]
        })
        
    return formatted_articles

if __name__ == "__main__":
    if not all([SUPABASE_URL, SUPABASE_KEY, USER_ID]):
        print("Error: Missing environment variables. Please check podcast/.env")
        exit(1)
        
    articles = fetch_recent_articles()
    print(f"Found {len(articles)} articles:")
    for i, article in enumerate(articles, 1):
        print(f"{i}. {article['title']} ({article['site_name']})")
        # print(f"   Content preview: {article['content'][:100]}...")
