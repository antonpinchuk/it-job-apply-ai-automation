import fs from 'fs';

const SESSION_FILE = '.apollo-session.json';
const APOLLO_ORIGIN = 'https://app.apollo.io';

export function sessionExists() {
  return fs.existsSync(SESSION_FILE);
}

export function loadSession() {
  if (!sessionExists()) return null;
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export async function applySession(context, page) {
  const session = loadSession();
  if (!session) return false;

  if (session.cookies?.length) {
    await context.addCookies(session.cookies);
  }

  if (session.localStorage && Object.keys(session.localStorage).length) {
    // Navigate to origin first so localStorage is scoped correctly
    await page.goto(APOLLO_ORIGIN, { waitUntil: 'domcontentloaded' });
    await page.evaluate((ls) => {
      for (const [k, v] of Object.entries(ls)) {
        try { localStorage.setItem(k, v); } catch {}
      }
    }, session.localStorage);
  }

  return true;
}

export async function saveSession(context, page) {
  const cookies = await context.cookies([APOLLO_ORIGIN]);
  const localStorage = await page.evaluate(() => {
    const data = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      data[key] = window.localStorage.getItem(key);
    }
    return data;
  });

  const tmp = SESSION_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ cookies, localStorage }, null, 2));
  fs.renameSync(tmp, SESSION_FILE);
  console.log('[session] Session saved to', SESSION_FILE);
}
