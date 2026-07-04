# Stash iOS / iPadOS Shortcut

Save pages to Stash from the **native share sheet** on iPhone and iPad —
from Safari, Chrome, or any other app.

## Why a Shortcut (and not the PWA)?

On iOS/iPadOS, web apps **cannot** register themselves into the share sheet.
The `share_target` entry in `web/manifest.json` is what makes Stash appear as a
share destination on **Android**, but Apple's WebKit does not implement the Web
Share Target API — so an installed Stash PWA will never show up in the iPad/iPhone
share sheet no matter how it was added to the Home Screen. (Note too that on iOS
only **Safari** installs a real PWA; Chrome's "Add to Home Screen" just makes a
bookmark.)

The Apple-blessed way to add a custom share-sheet action is a **Shortcut**, which
is exactly what this sets up. It works identically on iPhone and iPad.

## What you get

This Shortcut posts to the same `save-page` Edge Function the Chrome extension and
Android share flow use, so shared links are **fully scraped server-side** — you
get the whole article (title, content, excerpt, image), not just a bare URL.

## Setup

You need three values. They're the same ones in your `extension/config.js` /
`web/config.js`:

| Placeholder | Where it comes from | This project's value |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase → Project Settings → API | `https://jntnmvxkirrosxjquuoy.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API (publishable key) | `sb_publishable_56A0I5tN0tvybD2yJ81UKQ_Fn2ibI1s` |
| `USER_ID` | Supabase → Authentication → Users | `6c7a3a96-16cd-4702-ac7b-0c7a4a81346d` |

1. Open the **Shortcuts** app (built in on iPhone/iPad).
2. Tap **+** to create a new shortcut.
3. Add these actions in order:

### Action 1 — Receive input
- Search for **"Receive input from Share Sheet"** (or open the shortcut settings
  and enable **Show in Share Sheet** — see the last section).
- Set **Receive** to accept **URLs** and **Safari web pages**.

### Action 2 — Get URLs from Input
- Add **"Get URLs from Input"** and point it at **Shortcut Input**.
- This pulls a clean URL out of whatever the app shared (a page, a link, etc.).

### Action 3 — Get Contents of URL  *(this is the save)*
- Add **"Get Contents of URL"**.
- **URL:** `https://jntnmvxkirrosxjquuoy.supabase.co/functions/v1/save-page`
- Tap **Show More**, set **Method** to **POST**.
- **Headers:**
  - `apikey` : `sb_publishable_56A0I5tN0tvybD2yJ81UKQ_Fn2ibI1s`
  - `Authorization` : `Bearer sb_publishable_56A0I5tN0tvybD2yJ81UKQ_Fn2ibI1s`
  - `Content-Type` : `application/json`
- **Request Body:** **JSON**
  ```json
  {
    "url": "URLs",
    "user_id": "6c7a3a96-16cd-4702-ac7b-0c7a4a81346d",
    "source": "ios-shortcut"
  }
  ```
  For the `"url"` value, delete the placeholder text and insert the **URLs**
  variable from Action 2 (tap the field → Select Variable → *URLs*). Only the URL
  is required — the server scrapes the title, content, image and site name itself.

### Action 4 — Show notification (optional)
- Add **"Show Notification"** with text **"Saved to Stash!"** so you get
  confirmation.

## Add it to the Share Sheet

1. Tap the shortcut's name at the top, then the **ⓘ** (or the settings toggle).
2. Enable **Show in Share Sheet**.
3. Under **Share Sheet Types**, make sure **URLs** and **Safari web pages** are on.
4. Name it **"Save to Stash"**.

Now, from Safari or Chrome on your iPad/iPhone: **Share → Save to Stash**. The
article is scraped and saved, and appears in the Stash web app moments later.

## Troubleshooting

- **Don't see it in the share sheet?** Scroll to the bottom of the share sheet and
  tap **Edit Actions…** — enable "Save to Stash" and drag it up. Also confirm
  *Show in Share Sheet* is on and the accepted types include URLs.
- **Sharing from Chrome shows nothing saved?** Chrome shares a plain URL, which
  Action 2 handles — make sure Action 3's body `url` uses the **URLs** variable,
  not the shared *text*.
- **Getting an error notification?** Add a temporary **"Show Notification"** with
  the **Contents of URL** output right after Action 3 to see the server's
  response — a `401` means the `apikey`/`Authorization` headers are wrong; a `400`
  means `url`/`user_id` didn't come through.
