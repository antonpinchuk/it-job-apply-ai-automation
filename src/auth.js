import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import readline from 'readline';
import http from 'http';
import { exec } from 'child_process';
import { applySession, saveSession, sessionExists } from './session.js';

chromium.use(StealthPlugin());

const SITE_URLS = {
  apollo: 'https://app.apollo.io',
  linkedin: 'https://www.linkedin.com',
  jobright: 'https://jobright.ai',
};

// Sites that use a persistent on-disk Chrome profile instead of cookie/localStorage
// snapshots in .session/*.json. A real profile directory keeps httpOnly cookies
// (including Cloudflare's clearance cookie) exactly like a normal browser would,
// which a cookie-copy approach cannot reproduce. See PROFILE_DIRS export usage
// in main.js.
export const PROFILE_DIRS = {
  apollo: '.apollo-profile',
};

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function authPersistent(site) {
  const dir = PROFILE_DIRS[site];
  console.log(`[auth] Opening persistent Chrome profile for ${site} at ${dir}...`);
  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    channel: 'chrome',
    ignoreDefaultArgs: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(SITE_URLS[site]);

  await waitForEnter(
    `\n[auth] Log in to ${site} if needed, then click around for a bit — open People search, ` +
    `browse a page or two, scroll a list. This leaves a session with real human activity behind ` +
    `it (Cloudflare trusts that more than a session that's only ever been driven by a script).\n` +
    `       When you're done, press Enter here to close and save the profile...\n`
  );

  await context.close();
  console.log(`[auth] Done. Profile saved to ${dir}/ (this directory IS the session — nothing else to save).`);
}

async function authBrowser(site) {
  const hadSession = sessionExists(site);
  console.log(`[auth] Opening browser for ${site}${hadSession ? ' (reusing existing session)' : ' login'}...`);
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();

  // Load the existing session first (if any) so Cloudflare sees a continuation
  // of an already-trusted session rather than a brand-new browser.
  if (hadSession) await applySession(site, context);

  const page = await context.newPage();
  await page.goto(SITE_URLS[site]);

  if (!hadSession) {
    await waitForEnter(`\n[auth] Log in to ${site} in the browser, then press Enter here...\n`);
  }

  await saveSession(site, context, page);
  await browser.close();
  console.log(`[auth] Done. Session saved to .session/${site}.json`);
}

async function authGoogle() {
  const { google } = await import('googleapis');
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('[auth] GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
    console.error('       See: https://console.cloud.google.com/ → APIs → Credentials → OAuth 2.0');
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/callback');
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/spreadsheets'],
    prompt: 'consent',
  });

  console.log('[auth] Opening browser for Google OAuth...');
  const cmd = process.platform === 'win32'
    ? `start "" "${authUrl}"`
    : process.platform === 'darwin'
      ? `open "${authUrl}"`
      : `xdg-open "${authUrl}"`;
  exec(cmd);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:3000');
      const code = url.searchParams.get('code');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="font-family:sans-serif">Done! You can close this tab.</h2>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end('No code received');
        server.close();
        reject(new Error('No code in OAuth callback'));
      }
    });
    server.listen(3000, () => console.log('[auth] Waiting for Google OAuth callback on http://localhost:3000 ...'));
    server.on('error', reject);
  });

  const { tokens } = await oauth2.getToken(code);
  const fs = await import('fs');
  fs.default.mkdirSync('.session', { recursive: true });
  fs.default.writeFileSync('.session/google.json', JSON.stringify(tokens, null, 2));
  console.log('[auth] Google tokens saved to .session/google.json');
  console.log('[auth] Refresh token will auto-renew — no need to re-auth unless revoked.');
  process.exit(0);
}

/**
 * Check if Apollo page is showing a login/401 screen.
 */
export async function isLoggedOut(page) {
  const url = page.url();
  if (url.includes('/login') || url.includes('/sign_in')) return true;
  return page
    .locator('input[type="password"], [data-cy="login-button"], text=Sign in to Apollo')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
}

// ── CLI entry point ──────────────────────────────────────────────────────────
if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/auth.js')) {
  const args = process.argv.slice(2);
  const siteIdx = args.indexOf('--site');
  const site = siteIdx >= 0
    ? args[siteIdx + 1]
    : args.find(a => ['apollo', 'linkedin', 'google'].includes(a));

  if (!site || !['apollo', 'linkedin', 'jobright', 'google'].includes(site)) {
    console.error('Usage: node src/auth.js --site apollo|linkedin|jobright|google');
    process.exit(1);
  }

  const run = site === 'google' ? authGoogle() : PROFILE_DIRS[site] ? authPersistent(site) : authBrowser(site);
  run.catch(err => {
    console.error('[auth] Error:', err.message);
    process.exit(1);
  });
}
