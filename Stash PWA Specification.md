# **Product & Technical Spec: Stash Offline PWA**

## **1. Product Overview**

**Stash** is a digital bookmarking and reading app. The goal of this PWA transformation is to provide a "Native App" experience on Android and ensure that saved articles are fully readable without an internet connection (e.g., Airplane Mode).

### **Core User Stories**

- **Installable:** As a user, I can add Stash to my Android home screen with a custom icon.
- **Offline Shell:** As a user, I can open the app while offline and see my list of saved articles.
- **Offline Reading:** As a user, I can read the full text of articles I stashed earlier while on an airplane.
- **Sync on Reconnect:** As a user, any changes I make while offline (archiving, deleting) sync back to Supabase once I have a signal.
- **Share to Stash:** As a user, I can share a link directly from Chrome (or any Android app) to Stash to save it instantly.

## **2. Technical Stack**

- **Framework:** **Vanilla HTML, CSS, JavaScript** (No build steps, no frameworks)
- **Deployment:** Vercel (Static Site)
- **Database/Auth:** Supabase (via CDN SDK)
- **PWA Management:** Manual `manifest.json` & `sw.js`
- **Offline Data:** **IndexedDB** (using raw API or lightweight wrapper like `idb-keyval`)

## **3. Technical Implementation Details**

### **A. Web App Manifest & Share Target**

Located at `web/manifest.json`. Defines the look and feel and the share integration.

- **Display:** `standalone` (removes browser UI).
- **Icons:** Must include maskable icons (any size) and standard 192/512 sizes.
- **Share Target:** Add the `share_target` object to register the app in the Android share sheet.
  ```json
  "share_target": {
    "action": "/save.html",
    "method": "GET",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url"
    }
  }
  ```
  _Note: Since this is a vanilla app, we will use a dedicated `/save.html` page to handle incoming shares, which is simpler than handling it in the single page app logic._

### **B. Service Worker Strategy (`sw.js`)**

We will use a **Network-First** strategy for HTML/Data and **Stale-While-Revalidate** for static assets.

- **Static Assets (CSS/JS/Icons):** Cache on install. Serve from cache if available, update in background.
- **Navigation Preload:** Enable if possible to speed up initial load.
- **Offline Fallback:**
  - If simple navigation fails (offline), serve the cached `index.html` (the App Shell).
  - If `/save.html` is visited offline, serve it (or a fallback) so the user sees "Saved for later sync" (advanced).

### **C. The "Airplane Mode" Logic (The Data)**

To ensure articles are readable offline, we cannot rely on Supabase connectivity.

1.  **Storage (`app.js` + IndexedDB):**
    - We will introduce a simple IndexedDB layer.
    - On startup (online), fetch the latest articles from Supabase and **write them to IndexedDB**.
    - Whenever an article is "Read" (opened), force a fetch of its full content and update IndexedDB.
2.  **Hydration:**
    - `app.js` will attempt to load data from Supabase first.
    - If Supabase fetch fails (caught error), it will automatically query **IndexedDB** and render the list from there.
    - **UI Indicator:** Show a "Offline Mode" badge when serving from IndexedDB.

## **4. UI/UX Requirements (Android Focused)**

### **Adaptive Iconry**

- Provide maskable icons in `manifest.json`. This ensures Android can wrap your icon in a circle, square, or "squircle" based on the system theme.

### **Share Handling Page (`save.html`)**

- Existing `save.html` needs to be enhanced.
- It currently parses query params. It should:
  1.  Extract URL/Title.
  2.  Attempt to save to Supabase.
  3.  **NEW:** If offline, save to a "Pending Sync" queue in IndexedDB/LocalStorage.
  4.  Redirect to `index.html`.

### **Install Prompt**

- Since we are pure web, listen for the `beforeinstallprompt` event in `app.js`.
- Show a custom "Install App" button in the Sidebar or Settings that triggers this prompt.

## **5. Success Metrics**

- **Lighthouse PWA Score:** > 90.
- **Time to Interactive (Offline):** < 1.0 seconds (since it's vanilla, it should be blazing fast).
- **Persistence:** The last 50 articles should be available offline automatically.

## **6. Future Upgrades**

- **Background Sync API:** Use the Service Worker `sync` event to automatically retry failed saves when connectivity returns. (Requires more advanced SW logic).
