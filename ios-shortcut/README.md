# Stash iOS / iPadOS Shortcut

Save pages to Stash from the **native share sheet** on iPhone and iPad —
from Safari, Chrome, or any other app.

## Why a Shortcut, and not the PWA

On iOS and iPadOS, a web app cannot register itself into the share sheet.
Android supports this through the `share_target` entry in `web/manifest.json`.
Apple's WebKit does not support this feature. An installed Stash PWA will
never appear in the iPhone or iPad share sheet, no matter how it was added to
the Home Screen. (Note: on iOS, only Safari installs a real PWA. Chrome's
"Add to Home Screen" only creates a bookmark.)

The Apple-supported way to add a custom action to the share sheet is a
**Shortcut**. This guide sets one up. It works the same way on iPhone and
iPad.

## What you get

This Shortcut sends the shared link to the same `save-page` server function
that the Chrome extension and the Android share flow use. Stash scrapes the
full article on the server — title, content, excerpt, and image — not just
the bare URL.

Setup takes about two minutes and you do it once. The Shortcut authenticates
with a save token from your Stash account. This token does not expire on its
own, so the Shortcut keeps working without any upkeep.

## Setup

### Step 1: Get your save token

1. Open the Stash web app and sign in.
2. Go to **Settings**.
3. Under **iOS Share Sheet**, tap **Set Up Share Sheet Save**.
4. Tap **Copy** to copy your save token.

Keep this token private. Anyone who has it can save pages to your library.
If it leaks, tap **Regenerate Token** in the same screen to replace it — this
also breaks the old token, so update your Shortcut with the new one.

You also need your Supabase project URL and anon key. These are the same
values in `web/config.js`:

| Placeholder | Where it comes from | This project's value |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase → Project Settings → API | `https://jntnmvxkirrosxjquuoy.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API (publishable key) | `sb_publishable_56A0I5tN0tvybD2yJ81UKQ_Fn2ibI1s` |
| `SAVE_TOKEN` | Settings → iOS Share Sheet → Set Up Share Sheet Save | (yours — copy it in step 1 above) |

### Step 2: Build the Shortcut

1. Open the **Shortcuts** app (built in on iPhone and iPad).
2. Tap **+** to create a new shortcut.
3. Add the actions below, in order.

#### Action 1 — Receive input

- Search for **"Receive input from Share Sheet"**.
- Set **Receive** to accept **URLs** and **Safari web pages**.

#### Action 2 — Get URLs from Input

- Add **"Get URLs from Input"** and point it at **Shortcut Input**.
- This pulls a clean URL out of whatever the app shared.

#### Action 3 — Get Contents of URL (this is the save)

- Add **"Get Contents of URL"**.
- **URL:** `https://jntnmvxkirrosxjquuoy.supabase.co/functions/v1/save-page`
- Tap **Show More**, then set **Method** to **POST**.
- **Headers:**
  - `apikey` : `sb_publishable_56A0I5tN0tvybD2yJ81UKQ_Fn2ibI1s`
  - `X-Stash-Save-Token` : `YOUR_SAVE_TOKEN`
  - `Content-Type` : `application/json`
- **Request Body:** **JSON**
  ```json
  {
    "url": "URLs",
    "source": "ios-shortcut"
  }
  ```
  For the `"url"` value, delete the placeholder text and insert the **URLs**
  variable from Action 2 (tap the field, then **Select Variable**, then
  **URLs**). The server reads the user from the save token, so only the URL
  is required — it scrapes the title, content, image, and site name itself.

#### Action 4 — Show notification (optional)

- Add **"Show Notification"** with the text **"Saved to Stash!"** for
  confirmation.

### Step 3: Add it to the share sheet

1. Tap the shortcut's name at the top, then tap the **ⓘ** button (or the
   settings toggle).
2. Turn on **Show in Share Sheet**.
3. Under **Share Sheet Types**, confirm **URLs** and **Safari web pages** are
   on.
4. Name it **"Save to Stash"**.

Now, from Safari or Chrome on your iPhone or iPad: tap **Share**, then tap
**Save to Stash**. The article is scraped and saved. It appears in the Stash
web app moments later.

### Step 4: Turn it into a one-tap template for friends (optional)

Do this once, as the instance owner. Everyone you invite to your Stash
instance shares the same `SUPABASE_URL` and `SUPABASE_ANON_KEY`, so those
two values can stay baked into the Shortcut. Only the save token differs
per person. Apple's Shortcuts app has a built-in way to ask for just that
one value when someone else adds your Shortcut: an **import question**.

1. Open the "Save to Stash" Shortcut in the Shortcuts editor.
2. Tap the **ⓘ** button at the top.
3. Tap **Customize Shortcut…**.
4. Tap **Add Question**.
5. On the canvas, tap the `X-Stash-Save-Token` header value in Action 3
   (the one currently set to your own save token).
6. Set the prompt text to something like "Paste your Stash save token".
   Leave **Default Value** blank.
7. Tap **Done**, then tap **Done** again to close the customize screen.

Now share it:

1. Tap the **Share** icon (a square with an arrow pointing up).
2. Tap **Copy iCloud Link**.
3. Send that link to anyone using your Stash instance. When they tap it,
   Shortcuts asks them to paste their own save token, then adds "Save to
   Stash" straight to their library — no manual action-building.
4. Paste the link into `IOS_SHORTCUT_URL` in `web/config.js`. Once set,
   Settings → iOS Share Sheet shows a **Get the Shortcut** button instead of
   the manual build steps.

If you change the Shortcut's actions later, generate a new iCloud link and
update `IOS_SHORTCUT_URL` — an old link keeps pointing at the old version.

## Troubleshooting

- **Tapping the iCloud link shows a review screen listing the Shortcut's
  actions, not the save-token prompt.** This is normal for any Shortcut
  added from a link rather than the App Store. Tap **Add Untrusted
  Shortcut** (or **Add Shortcut**) to continue — the save-token prompt
  appears right after.
- **Don't see it in the share sheet?** Scroll to the bottom of the share
  sheet and tap **Edit Actions…**. Turn on "Save to Stash" and drag it up.
  Also confirm **Show in Share Sheet** is on and the accepted types include
  URLs.
- **Sharing from Chrome shows nothing saved?** Chrome shares a plain URL,
  which Action 2 handles. Confirm Action 3's body `url` field uses the
  **URLs** variable, not the shared *text*.
- **Getting an error notification?** Add a temporary **"Show Notification"**
  action with the **Contents of URL** output right after Action 3, to see
  the server's response.
  - A `401` means the `X-Stash-Save-Token` header is wrong, or the token was
    regenerated in Settings. Copy the current token from Settings and update
    the Shortcut.
  - A `400` means the `url` field didn't come through. Check that Action 3's
    body uses the **URLs** variable from Action 2.
