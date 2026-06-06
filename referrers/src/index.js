import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { applySession, saveSession } from './session.js';
import { isLoggedOut } from './auth.js';
import { isUkrOrRusName, isUkrOrRusEmployer } from './llm.js';
import { resolveOrgId, fetchContactsPage } from './apollo.js';

chromium.use(StealthPlugin());

const APOLLO_URL = 'https://app.apollo.io';
const LLM_CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '3', 10);

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let linkedinUrl = null;
  let location = 'Canada';
  let maxResults = 5;

  let name = null;
  let id = null;

  for (let i = 0; i < args.length; i++) {
    const eqMatch = args[i].match(/^--(\w+)=(.+)$/);
    if (eqMatch) {
      const [, key, val] = eqMatch;
      if (key === 'location') location = val;
      else if (key === 'maxresults') maxResults = parseInt(val, 10);
      else if (key === 'name') name = val;
      else if (key === 'id') id = val;
    } else if (args[i] === '--location' && args[i + 1]) location = args[++i];
    else if (args[i] === '--maxresults' && args[i + 1]) maxResults = parseInt(args[++i], 10);
    else if (args[i] === '--name' && args[i + 1]) name = args[++i];
    else if (args[i] === '--id' && args[i + 1]) id = args[++i];
    else if (!args[i].startsWith('--')) linkedinUrl = args[i];
  }

  return { linkedinUrl, location, maxResults, name, id };
}

async function main() {
  const { linkedinUrl, location, maxResults, name, id } = parseArgs();
  if (!linkedinUrl && !id && !name) {
    console.error('Usage: node src/index.js [<linkedin_url>] [--id <apollo_id>] [--name "Company"] [--location "United States"] [--maxresults 10]');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();

  await applySession(context, page);
  await page.goto(APOLLO_URL, { waitUntil: 'domcontentloaded' });

  if (await isLoggedOut(page)) {
    console.error('[main] Not logged in. Run: npm run auth');
    await browser.close();
    process.exit(1);
  }

  try {
    const { id: orgId, name: orgName } = await resolveOrgId(page, linkedinUrl, { id, name });
    console.log(`\n[main] Scanning "${orgName}" engineers in "${location}", stopping after ${maxResults} matches\n`);

    const results = [];
    const maybes = []; // name matched but employer didn't
    let pageNum = 1;

    outer: while (true) {
      const { contacts, totalPages } = await fetchContactsPage(page, orgId, pageNum, location);

      // Check all names concurrently (limited)
      const nameResults = await mapConcurrent(contacts, LLM_CONCURRENCY,
        c => isUkrOrRusName(c.name).then(match => ({ contact: c, match }))
      );

      // Check employers concurrently for name matches only
      const nameMatches = nameResults.filter(r => r.match).map(r => r.contact);
      const employerResults = await mapConcurrent(nameMatches, LLM_CONCURRENCY,
        c => isUkrOrRusEmployer(c.employment, c.name).then(match => ({ contact: c, match }))
      );

      for (const { contact, match } of employerResults) {
        if (match) {
          console.log(`[main] ✓ Found: ${contact.name} | ${contact.linkedinUrl}`);
          if (contact.linkedinUrl) results.push(contact.linkedinUrl);
        } else {
          if (contact.linkedinUrl) maybes.push(contact.linkedinUrl);
        }
      }

      if (results.length >= maxResults) break outer;

      if (pageNum >= totalPages) break;
      pageNum++;
      await page.waitForTimeout(500 + Math.floor(Math.random() * 500));
    }

    await saveSession(context, page);

    console.log('\n=== RESULTS ===');
    console.log(results.length ? results.join('\n') : 'No matching contacts found.');

    if (maybes.length) {
      console.log('\n=== MAYBE (name match, no UA/RU employer) ===');
      console.log(maybes.join('\n'));
    }
    return results;
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
