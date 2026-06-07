/**
 * CLI entry point for the people finder.
 * Usage: node src/find.js [<linkedin_url>] [--id <apollo_id>] [--name "Company"] [--location "Canada"] [--maxresults 5]
 */
import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { applySession, saveSession } from './session.js';
import { isLoggedOut } from './auth.js';
import { resolveOrgId } from './apollo.js';
import { findPeople } from './finder.js';

chromium.use(StealthPlugin());

const APOLLO_URL = 'https://app.apollo.io';

function parseArgs() {
  const args = process.argv.slice(2);
  let linkedinUrl = null, location = 'Canada', maxResults = 5, name = null, id = null, role = 'DevOps';
  for (let i = 0; i < args.length; i++) {
    const eq = args[i].match(/^--(\w+)=(.+)$/);
    if (eq) {
      const [, key, val] = eq;
      if (key === 'location') location = val;
      else if (key === 'maxresults') maxResults = parseInt(val, 10);
      else if (key === 'name') name = val;
      else if (key === 'id') id = val;
      else if (key === 'role') role = val;
    } else if (args[i] === '--location'   && args[i + 1]) location   = args[++i];
    else if   (args[i] === '--maxresults' && args[i + 1]) maxResults = parseInt(args[++i], 10);
    else if   (args[i] === '--name'       && args[i + 1]) name       = args[++i];
    else if   (args[i] === '--id'         && args[i + 1]) id         = args[++i];
    else if   (args[i] === '--role'       && args[i + 1]) role       = args[++i];
    else if (!args[i].startsWith('--')) linkedinUrl = args[i];
  }
  return { linkedinUrl, location, maxResults, name, id, role };
}

async function main() {
  const { linkedinUrl, location, maxResults, name, id, role } = parseArgs();
  if (!linkedinUrl && !id && !name) {
    console.error('Usage: node src/find.js [<linkedin_url>] [--id <id>] [--name "Company"] [--location "Canada"] [--role "DevOps"] [--maxresults 5]');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();

  await applySession('apollo', context, page);
  await page.goto(APOLLO_URL, { waitUntil: 'domcontentloaded' });

  if (await isLoggedOut(page)) {
    console.error('[find] Not logged in to Apollo. Run: npm run auth -- --site apollo');
    await browser.close();
    process.exit(1);
  }

  try {
    const { id: orgId, name: orgName } = await resolveOrgId(page, linkedinUrl, { id, name });
    console.log(`\n[find] Scanning "${orgName}" in "${location}", role "${role}", max ${maxResults}\n`);

    const { results, maybes, byRole } = await findPeople(page, orgId, { location, maxResults, role });
    await saveSession('apollo', context, page);

    console.log('\n=== RESULTS (confirmed UA/RU) ===');
    console.log(results.length ? results.map(r => r.linkedinUrl ?? r).join('\n') : 'None.');

    if (maybes.length) {
      console.log('\n=== MAYBE (name match, no UA/RU employer) ===');
      console.log(maybes.map(m => `[${m.confidence}] ${m.linkedinUrl}  ${m.name}`).join('\n'));
    }

    if (byRole.length) {
      console.log('\n=== BY ROLE (role match, not UA/RU) ===');
      console.log(byRole.map(r => `[${r.confidence}] ${r.linkedinUrl}  ${r.name}`).join('\n'));
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error('[find] Fatal:', err); process.exit(1); });
