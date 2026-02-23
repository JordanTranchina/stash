import os
from supabase import create_client

def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    supabase = create_client(url, key)

    # Get all tables
    res = supabase.rpc("get_tables").execute()
    # Actually, rpc get_tables might not exist. 
    # Let's use the list from previous list_tables call.
    tables = [
        "saves", "folders", "podcast_episodes", "users" # Add more if needed
    ]

    for table in tables:
        print(f"Searching in {table}...")
        try:
            # Simple select everything and check in python to avoids complex ILIKE for all columns
            res = supabase.table(table).select("*").execute()
            for row in res.data:
                row_str = str(row)
                if "Stealth" in row_str:
                    print(f"Found match in {table}: {row}")
        except Exception as e:
            print(f"Error searching {table}: {e}")

if __name__ == "__main__":
    main()
