# Architecture: Playwright with session persistence and anti-detection

## Problem

Sites like LinkedIn and Apollo.io block automation via:
- **Cloudflare / bot detection** — checks JS runtime fingerprint, `navigator.webdriver` flag, missing browser APIs
- **Session requirements** — require manual 2FA / CAPTCHA login that can't be automated

The solution: user logs in **once** manually in a real Chrome window → session is saved to disk → all future runs restore the session silently.

---

## Anti-detection: playwright-extra + stealth plugin

Plain Playwright exposes `navigator.webdriver = true` and other automation markers that trigger blocks.

```js
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const browser = await chromium.launch({ headless: false, channel: 'chrome' });
```

**What the stealth plugin patches:**
- Removes `navigator.webdriver`
- Spoofs `navigator.plugins`, `navigator.languages`, Chrome runtime objects
- Fixes `window.chrome` to look like a real browser
- Patches WebGL, canvas fingerprint, `permissions.query`

`channel: 'chrome'` uses the **system-installed Chrome** (not Chromium), which has a real fingerprint, extensions, and matches expected UA strings.

---

## One-time authentication flow

```
npm run auth -- --site linkedin
```

1. Opens a **headful** Chrome window via `chromium.launch({ headless: false })`
2. Navigates to the site login page
3. User logs in manually (handles 2FA, CAPTCHA, etc.)
4. Script waits for Enter keypress
5. **Saves session** — dumps cookies + localStorage to JSON file

```js
// auth.js
const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const context = await browser.newContext();
const page    = await context.newPage();
await page.goto('https://www.linkedin.com');

await waitForEnter('Log in, then press Enter...');

await saveSession('linkedin', context, page);
await browser.close();
```

Session file example (`.linkedin-session.json`):
```json
{
  "cookies": [
    { "name": "li_at", "value": "AQE...", "domain": ".linkedin.com", ... }
  ],
  "localStorage": {
    "voyager-web:user-id": "12345678",
    ...
  }
}
```

---

## Session restore on every run

```js
// session.js — applySession()
await context.addCookies(session.cookies);

// localStorage requires navigating to the origin first
await page.goto('https://app.apollo.io', { waitUntil: 'domcontentloaded' });
await page.evaluate(ls => {
  for (const [k, v] of Object.entries(ls)) {
    localStorage.setItem(k, v);
  }
}, session.localStorage);
```

After `applySession()` the browser context is fully authenticated — no login page appears.

---

## Google OAuth (different flow — API, not browser session)

Google Sheets uses OAuth 2.0 with a **refresh token**, not a browser session.

```
npm run auth -- --site google
```

1. Generates an authorization URL and opens it in the browser
2. Starts a local HTTP server at `localhost:3000` to catch the OAuth callback
3. Exchanges the auth code for access + refresh tokens
4. Saves tokens to `.google-token.json`

On subsequent runs, the refresh token auto-renews the access token — no re-auth needed unless the token is revoked.

---

## Two-browser architecture (main.js)

```
┌─────────────────────────────┐    ┌──────────────────────────────┐
│  linkedinBrowser (headful)  │    │  apolloBrowser (headless)    │
│  channel: 'chrome'          │    │  channel: 'chrome'           │
│  + stealth plugin           │    │  + stealth plugin            │
│                             │    │                              │
│  tab: job posting page      │    │  page: Apollo API calls      │
│  tab: LinkedIn company page │    │  (hidden from user)          │
│  tabs: referrer profiles    │    │                              │
└─────────────────────────────┘    └──────────────────────────────┘
         user interacts                   automated silently
```

LinkedIn runs **headful** so the user can review profiles and close unwanted tabs.
Apollo runs **headless** — only API JSON calls, no visual interaction needed.

---

## Session file management

| File | Contents | Renewed |
|------|----------|---------|
| `.linkedin-session.json` | cookies + localStorage | manually via `npm run auth` |
| `.apollo-session.json` | cookies + localStorage | auto-saved after each run |
| `.google-token.json` | OAuth access + refresh token | auto-renewed by googleapis |

Apollo session is re-saved at the end of each `main.js` run to keep cookies fresh:
```js
await saveSession('apollo', apolloCtx, apolloPage);
```

---

## Key packages

| Package | Role |
|---------|------|
| `playwright-extra` | Playwright wrapper that supports plugins |
| `puppeteer-extra-plugin-stealth` | Patches automation markers (works with playwright-extra) |
| `playwright` | Core browser automation engine |
