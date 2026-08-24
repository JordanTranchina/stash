# Stash iOS Shortcut

Save pages to Stash from your iPhone's share sheet.

## Use the PWA share target instead, if you can

For most people this Shortcut is the wrong tool. Stash is a PWA and registers
itself as a share target: add the web app to your home screen, sign in once,
and "Save to Stash" appears in the normal iOS share sheet with no setup and no
tokens to manage.

The Shortcut is worth the trouble only if you specifically want the save to
happen without a browser window opening — and it comes with a real caveat.
Saves now have to be authenticated, and the Shortcuts app can't run a Google
sign-in flow. The only way to authenticate a Shortcut is to paste in an access
token by hand, and Supabase access tokens expire (an hour by default), so you
would be re-pasting a fresh token regularly. If you signed up with Google and
have no password, you can't get a token this way at all.

If that's still what you want, here's the setup.

## Setup

1. Open the Shortcuts app on your iPhone
2. Tap + to create a new shortcut
3. Add these actions:

### Action 1: Receive input
- Type: **Receive** what's passed to the shortcut
- Accept: **URLs** and **Safari web pages**

### Action 2: Get URL
- **Get URLs from** Shortcut Input

### Action 3: Get contents of URL (this saves to Stash)
- URL: `https://YOUR_PROJECT_ID.supabase.co/functions/v1/save-page`
- Method: **POST**
- Headers:
  - `Authorization`: `Bearer YOUR_ACCESS_TOKEN`
  - `apikey`: `YOUR_SUPABASE_ANON_KEY`
  - `Content-Type`: `application/json`
- Request Body: **JSON**
  ```
  {
    "url": [URLs variable],
    "title": "Saved from iPhone",
    "source": "ios-shortcut"
  }
  ```

There is no `user_id` field any more. `save-page` reads the user from the
`Authorization` header and returns 401 without one.

### Action 4: Show notification
- "Saved to Stash!"

## Getting an access token

You need an email/password account for this — an account created through
Google has no password to exchange for a token.

On a computer, sign in to the Stash web app and copy the `access_token` from
the Supabase session in local storage (Developer Tools > Application > Local
Storage). Or request one directly:

```bash
curl -X POST 'https://YOUR_PROJECT_ID.supabase.co/auth/v1/token?grant_type=password' \
  -H 'apikey: YOUR_SUPABASE_ANON_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'
```

The `access_token` in the response goes in the `Authorization` header. When it
expires the Shortcut will start failing with a 401 and you'll need to repeat
this.

## Add to Share Sheet

1. Tap the shortcut name at the top
2. Tap the (i) info icon
3. Enable "Show in Share Sheet"
4. Name it "Save to Stash"

Now when you're in Safari (or any app), tap Share → Save to Stash!
