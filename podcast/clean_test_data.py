import os
import requests
import json
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

def get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json"
    }

def list_all_articles():
    url = f"{SUPABASE_URL}/rest/v1/saves"
    params = {
        "select": "*",
        "order": "created_at.desc"
    }
    
    response = requests.get(url, headers=get_headers(), params=params)
    if response.status_code == 200:
        data = response.json()
        with open("articles.json", "w") as f:
            json.dump(data, f, indent=2)
        print(f"Saved {len(data)} articles to articles.json")
    else:
        print(f"Error: {response.status_code} - {response.text}")

if __name__ == "__main__":
    list_all_articles()
