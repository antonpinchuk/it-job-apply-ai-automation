import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(StealthPlugin());
import readline from 'readline';
import { saveSession } from './session.js';

const APOLLO_URL = 'https://app.apollo.io';

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Standalone auth flow: opens browser, lets user log in, saves session.
 * Run with: npm run auth
 */
export async function runAuthFlow() {
  console.log('[auth] Opening browser for manual login...');
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(APOLLO_URL);

  await waitForEnter('\n[auth] Log in to Apollo in the browser, then press Enter here to save session...\n');

  await saveSession(context, page);
  await browser.close();
  console.log('[auth] Done. You can now run: npm start <linkedin_url>');
}

/**
 * Check if Apollo is showing a login/401 page.
 */
export async function isLoggedOut(page) {
  const url = page.url();
  if (url.includes('/login') || url.includes('/sign_in')) return true;

  // Check for login form or 401 indicators
  const hasLoginForm = await page
    .locator('input[type="password"], [data-cy="login-button"], text=Sign in to Apollo')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  return hasLoginForm;
}

// If run directly
if (process.argv[1].endsWith('auth.js')) {
  runAuthFlow().catch(console.error);
}
