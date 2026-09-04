# Publishing the extension (Chrome Web Store & Firefox Add-ons)

Tracks [#96](https://github.com/JordanTranchina/stash/issues/96). This
document has everything needed to file both store listings: the listing copy,
the permission/privacy answers each store's submission form asks for, and the
step-by-step runbook. No code changes are required — `extension/` and
`extension-firefox/` already target MV3 on both browsers.

**This is a manual, human-gated process.** Both stores require a developer
account tied to a real person (Chrome: Google account + one-time $5 fee;
Firefox: a free Mozilla account) and, for Chrome, payment and identity
details that can't be filed by an automated agent. The sections below prepare
everything so that whoever holds those accounts can complete the submission
in one sitting.

## Visibility: unlisted, not public

Recommendation: publish both listings as **unlisted** (Chrome: "Unlisted" in
the dashboard's visibility setting; Firefox: "On your own" / self-distributed
via AMO rather than "Recommended"/promoted placement). Unlisted means
install-by-link only — no store search or directory presence.

This matches Stash's friends-and-family scope (see
`documentation/DISTRIBUTION_READINESS.md`): there's no benefit to public
discoverability for an invite-only app, and unlisted listings generally get
lighter review scrutiny than ones seeking public search placement.

## Packaging

```bash
npm run sync:firefox-extension   # if extension/ changed since the last sync
npm run package:extensions       # writes dist/stash-chrome-vX.Y.Z.zip and dist/stash-firefox-vX.Y.Z.zip
```

`scripts/package-extension.js` reads the version from each `manifest.json` and
zips the respective directory, excluding the dev-only `icons/create-icons.html`
helper page. `dist/` and `*.zip` are gitignored — these archives are release
artifacts, not checked-in files.

Before packaging a release, bump `"version"` in **both**
`extension/manifest.json` and `extension-firefox/manifest.json` (they must
match; there's no automated version sync between them).

## Listing copy (both stores)

**Name:** Stash

**Summary / short description** (Chrome: 132 chars max):
> Save articles and highlights to your own self-hosted read-it-later library.

**Detailed description:**
> Stash is a self-hosted read-it-later app — save articles, highlights, and
> bookmarks from any page to your own private library, backed by your own
> Supabase project. There's no subscription and no third-party account: your
> saves live in a database you control.
>
> This extension adds a one-click "Save to Stash" button and a right-click
> context menu entry to save the current page, using Mozilla's Readability
> library to extract clean article text directly in your browser.
>
> Stash is invite-only — you'll need an account on a Stash instance (your own,
> or one a friend set up) to sign in. See the project's setup guide:
> https://github.com/JordanTranchina/stash

**Category:** Productivity

**Single purpose statement** (Chrome requires this): *Save the current page's
content to the user's Stash read-it-later account.*

**Privacy policy URL:** link to `documentation/PRIVACY_POLICY.md` on GitHub,
e.g. `https://github.com/JordanTranchina/stash/blob/main/documentation/PRIVACY_POLICY.md`

**Icon:** `extension/icons/icon128.png` (already produced by
`generate_icons.py`)

**Screenshots:** reuse or crop from `documentation/screenshots/` (the popup
itself isn't currently screenshotted — capture `extension/popup.html` open on
a real page before submitting, since store listings expect at least one
extension-specific screenshot rather than only web-app screens).

## Chrome Web Store — submission steps

1. Register as a Chrome Web Store developer (one-time $5 fee):
   https://chrome.google.com/webstore/devconsole
2. "New item" → upload `dist/stash-chrome-vX.Y.Z.zip`.
3. Fill in the **Store listing** tab with the copy above.
4. **Privacy practices** tab — this is where the `<all_urls>` host permission
   and `scripting`/`activeTab` usage need justifying:
   - Single purpose: paste the single purpose statement above.
   - Permission justifications: use the table in `PRIVACY_POLICY.md`'s
     "Permissions justification" section, one sentence per permission.
   - Data usage: declare that the extension handles "Website content" (the
     saved page's URL/title/text) and "Personal communications" is **not**
     collected; check "This item does not collect or use user data" only if
     analytics (`POSTHOG_API_KEY`)/error reporting (`SENTRY_DSN`) are left
     blank in the build being submitted — otherwise disclose usage analytics
     and declare the PostHog/Sentry endpoints as remote services contacted.
   - Paste the privacy policy URL.
5. Set **Visibility** to "Unlisted" under the Distribution tab.
6. Submit for review. Expect hours to a few days; Google's docs cite up to
   ~30 days worst case, and the broad host permission increases the odds of a
   manual (rather than automated) review pass.
7. Once approved, record the store URL in `README.md` / `SETUP.md` (see
   "After publishing" below).

## Firefox Add-ons (AMO) — submission steps

1. Create/sign in to a Firefox Add-on Developer account (free):
   https://addons.mozilla.org/developers/
2. "Submit a New Add-on" → choose **"On your own"** distribution (not
   "On this site", which is the public-listing/promoted path) — this is AMO's
   equivalent of unlisted.
3. Upload `dist/stash-firefox-vX.Y.Z.zip`. Automated validation + signing is
   near-instant for self-distributed add-ons; human review happens
   post-publish and does not block the signed build being usable.
4. Fill in the listing form with the same copy as above, and link the same
   privacy policy URL.
5. Download the signed `.xpi` AMO produces — this, not the raw zip, is what
   gets distributed to install-by-link users (self-distributed Firefox
   add-ons are installed from the signed `.xpi` file directly, since they
   don't appear in AMO's public search).

## After publishing

- Update `README.md`'s "A note on the extension" section and
  `documentation/SETUP.md`'s extension-loading steps with the real store/AMO
  links, and keep the unpacked "Load unpacked" instructions as a fallback for
  contributors running from source.
- Update `documentation/DISTRIBUTION_READINESS.md` B6 to mark the store
  publication as done.
- Future releases: bump both manifest versions, re-run
  `npm run package:extensions`, and re-upload through each dashboard. Chrome
  re-reviews every update that touches permissions; Firefox re-validates
  every upload automatically.
