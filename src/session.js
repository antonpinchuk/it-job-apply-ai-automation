import fs from 'fs';

const CONFIGS = {
  apollo: {
    file: '.session/apollo.json',
    origin: 'https://app.apollo.io',
  },
  linkedin: {
    file: '.session/linkedin.json',
    origin: 'https://www.linkedin.com',
  },
  jobright: {
    file: '.session/jobright.json',
    origin: 'https://api.jobright.ai',
  },
};

export function sessionExists(site) {
  return fs.existsSync(CONFIGS[site].file);
}

function loadSession(site) {
  const { file } = CONFIGS[site];
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

/**
 * Apply saved session to browser context.
 * Adds cookies always. If page is provided, navigates to origin to inject localStorage.
 * @param {string} site - 'apollo' | 'linkedin'
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} [page]
 */
export async function applySession(site, context, page = null) {
  const session = loadSession(site);
  if (!session) return false;

  if (session.cookies?.length) {
    await context.addCookies(session.cookies);
  }

  if (page && session.localStorage && Object.keys(session.localStorage).length) {
    await page.goto(CONFIGS[site].origin, { waitUntil: 'domcontentloaded' });
    await page.evaluate(ls => {
      for (const [k, v] of Object.entries(ls)) {
        try { localStorage.setItem(k, v); } catch {}
      }
    }, session.localStorage);
  }

  return true;
}

/**
 * Save cookies + localStorage to session file.
 */
export async function saveSession(site, context, page) {
  const { file, origin } = CONFIGS[site];
  const cookies = await context.cookies([origin]);
  const localStorage = await page.evaluate(() => {
    const data = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      data[key] = window.localStorage.getItem(key);
    }
    return data;
  });

  fs.mkdirSync('.session', { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ cookies, localStorage }, null, 2));
  fs.renameSync(tmp, file);
  console.log(`[session] Saved ${site} session → ${file}`);
}
