import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import readline from 'readline';
import http from 'http';
import { exec } from 'child_process';
import { saveSession } from './session.js';

chromium.use(StealthPlugin());

const SITE_URLS = {
  apollo: 'https://app.apollo.io',
  linkedin: 'https://www.linkedin.com',
  jobright: 'https://jobright.ai',
};

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function authBrowser(site) {
  console.log(`[auth] Opening browser for ${site} login...`);
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(SITE_URLS[site]);
  await waitForEnter(`\n[auth] Log in to ${site} in the browser, then press Enter here...\n`);
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

  (site === 'google' ? authGoogle() : authBrowser(site)).catch(err => {
    console.error('[auth] Error:', err.message);
    process.exit(1);
  });
}
