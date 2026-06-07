/**
 * Main orchestration script.
 * Usage: node src/main.js <job-page-url>
 */
import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import readline from 'readline';
import { applySession, saveSession, sessionExists } from './session.js';
import { isLoggedOut } from './auth.js';
import { resolveOrgId } from './apollo.js';
import { findPeople } from './finder.js';
import { appendApplication } from './sheets.js';
import { classifyTitleRoleStack, generateDomainLabel, normalizeLocation } from './llm.js';
import { STACK_EXAMPLES, DOMAIN_EXAMPLES, ROLE_OPTIONS } from './config.js';
import { lookupJob } from './jobright.js';

chromium.use(StealthPlugin());

const APOLLO_URL = 'https://app.apollo.io';
const TABS_TO_OPEN = 5;

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); }));
}

function parseArgs() {
  const args = process.argv.slice(2);
  let jobUrl = null, role = 'DevOps';
  for (let i = 0; i < args.length; i++) {
    const eq = args[i].match(/^--role=(.+)$/);
    if (eq) { role = eq[1]; }
    else if (args[i] === '--role' && args[i + 1]) { role = args[++i]; }
    else if (!args[i].startsWith('--')) { jobUrl = args[i]; }
  }
  return { jobUrl, role };
}

/**
 * Cascade location search.
 *
 * Phase 1: Canada     — UA/RU (name + employer)
 * Phase 2: US         — UA/RU              (only if phase 1 found nothing)
 * Phase 3: Canada     — role match cache   (only if phase 2 found nothing, no new Apollo calls)
 * Phase 4: US         — role match cache   (only if phase 3 found nothing)
 *
 * Phases 3-4 reuse byRole results already fetched in phases 1-2 — no extra Apollo requests.
 *
 * Returns up to TABS_TO_OPEN URLs: confirmed first, then top maybes by LLM confidence.
 */
async function cascadeSearch(apolloPage, orgId, role) {
  const ORDER = ['high', 'medium', 'low'];
  const resort = arr => arr.sort((a, b) => ORDER.indexOf(a.confidence) - ORDER.indexOf(b.confidence));

  let allResults = [];
  let allMaybes  = [];
  const hasAny   = () => allResults.length > 0 || allMaybes.length > 0;

  // Phase 1: Canada — UA/RU
  console.log('\n[search] Phase 1: Canada (UA/RU)...');
  const ca = await findPeople(apolloPage, orgId, { location: 'Canada', maxResults: TABS_TO_OPEN, role });
  allResults.push(...ca.results);
  allMaybes.push(...ca.maybes);

  let us = null;
  if (!hasAny()) {
    // Phase 2: US — UA/RU
    console.log('[search] Phase 2: United States (UA/RU)...');
    us = await findPeople(apolloPage, orgId, { location: 'United States', maxResults: TABS_TO_OPEN, role });
    allResults.push(...us.results);
    allMaybes.push(...us.maybes);
  }

  if (!hasAny()) {
    // Phase 3: Canada byRole cache (already fetched, no new Apollo calls)
    console.log('[search] Phase 3: Canada role-match cache...');
    allMaybes.push(...ca.byRole);
  }

  if (!hasAny() && us) {
    // Phase 4: US byRole cache
    console.log('[search] Phase 4: US role-match cache...');
    allMaybes.push(...us.byRole);
  }

  resort(allMaybes);

  const needed = Math.max(0, TABS_TO_OPEN - allResults.length);
  const toOpen = [
    ...allResults.slice(0, TABS_TO_OPEN).map(r => r.linkedinUrl ?? r),
    ...allMaybes.slice(0, needed).map(m => m.linkedinUrl),
  ];

  return { toOpen, allResults, allMaybes };
}

async function main() {
  const { jobUrl, role } = parseArgs();
  if (!jobUrl) {
    console.error('Usage: npm run start -- <job-page-url>');
    process.exit(1);
  }

  if (!sessionExists('linkedin')) {
    console.error('[main] No LinkedIn session. Run: npm run auth -- --site linkedin');
    process.exit(1);
  }
  if (!sessionExists('apollo')) {
    console.error('[main] No Apollo session. Run: npm run auth -- --site apollo');
    process.exit(1);
  }

  // ── STEP 1: Open two browsers ────────────────────────────────────
  console.log('[main] Starting browsers...');

  // Headful: for LinkedIn tabs (user sees this)
  const linkedinBrowser = await chromium.launch({ headless: false, channel: 'chrome' });
  const linkedinCtx = await linkedinBrowser.newContext();
  await applySession('linkedin', linkedinCtx);

  // Headless: for Apollo API (hidden from user)
  const apolloBrowser = await chromium.launch({ headless: true, channel: 'chrome' });
  const apolloCtx = await apolloBrowser.newContext();
  const apolloPage = await apolloCtx.newPage();
  await applySession('apollo', apolloCtx, apolloPage);
  await apolloPage.goto(APOLLO_URL, { waitUntil: 'domcontentloaded' });

  if (await isLoggedOut(apolloPage)) {
    console.error('[main] Not logged in to Apollo. Run: npm run auth -- --site apollo');
    await linkedinBrowser.close();
    await apolloBrowser.close();
    process.exit(1);
  }

  // ── STEP 2: Open job page ────────────────────────────────────────
  const jobPage = await linkedinCtx.newPage();
  await jobPage.goto(jobUrl, { waitUntil: 'domcontentloaded' });
  console.log(`[main] Opened job page: ${jobUrl}`);

  // ── STEP 3: Lookup job info via Jobright API ─────────────────────
  const jobrightData = await lookupJob(jobUrl);

  let companyName, fullJobTitle, companyCategories;
  if (jobrightData) {
    companyName       = jobrightData.companyName;
    fullJobTitle      = jobrightData.jobTitle;
    companyCategories = jobrightData.companyCategories;
  } else {
    console.log('[main] Jobright lookup failed — enter manually:');
    companyName  = await ask('Company name: ');
    fullJobTitle = await ask('Full job title: ');
  }

  // Classify role + stack via LLM in one call
  const { role: jobRole, stack: jobTitle } = await classifyTitleRoleStack(fullJobTitle, ROLE_OPTIONS, STACK_EXAMPLES);

  // ── STEP 4: Find company in Apollo ──────────────────────────────
  let orgId, orgName, linkedinCompanyUrl;
  let searchName = companyName;
  while (true) {
    try {
      const org = await resolveOrgId(apolloPage, null, { name: searchName });
      orgId = org.id;
      orgName = org.name;
      linkedinCompanyUrl = org.linkedinUrl;
      break;
    } catch {
      const retry = await ask(
        `[main] Apollo: "${searchName}" not found.\n` +
        `       Enter different company name, Apollo org ID, or leave blank to skip: `
      );
      if (!retry) { await linkedinBrowser.close(); await apolloBrowser.close(); process.exit(0); }
      // Support direct ID input (24-char hex)
      if (/^[a-f0-9]{24}$/i.test(retry)) {
        try {
          const org = await resolveOrgId(apolloPage, null, { id: retry });
          orgId = org.id; orgName = org.name; linkedinCompanyUrl = org.linkedinUrl;
          break;
        } catch { /* fall through to retry loop */ }
      }
      searchName = retry;
    }
  }

  if (!linkedinCompanyUrl) {
    linkedinCompanyUrl = `https://www.linkedin.com/company/${orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    console.log(`[main] Apollo had no LinkedIn URL, using: ${linkedinCompanyUrl}`);
  }

  // ── STEP 5: Open LinkedIn company page ──────────────────────────
  const coPage = await linkedinCtx.newPage();
  await coPage.goto(linkedinCompanyUrl, { waitUntil: 'domcontentloaded' });
  console.log(`[main] Opened company page: ${linkedinCompanyUrl}`);

  // ── STEP 6: Cascade search ───────────────────────────────────────
  console.log(`\n[main] Searching "${orgName}" (role: ${role})...`);
  const { toOpen, allResults, allMaybes } = await cascadeSearch(apolloPage, orgId, role);

  if (!toOpen.length) {
    console.log('[main] No people found at all. Continuing without referrers.');
  }

  // ── STEP 7: Open up to 5 LinkedIn tabs ──────────────────────────
  for (const url of toOpen) {
    const tab = await linkedinCtx.newPage();
    await tab.goto(url, { waitUntil: 'domcontentloaded' });
  }
  console.log(`\n[main] Opened ${toOpen.length} tabs (${allResults.length} confirmed, ${Math.min(allMaybes.length, TABS_TO_OPEN - allResults.length)} maybes)`);

  // ── STEP 8: User reviews and closes unwanted tabs ────────────────
  await ask(
    `\n[main] Review the tabs. Close profiles you don't want to message.\n` +
    `       Keep up to 4 LinkedIn profile tabs.\n` +
    `       Press Enter when ready...\n`
  );

  // ── STEP 9: Collect remaining LinkedIn profile tabs ──────────────
  const allPages = linkedinCtx.pages();
  const refPages = allPages.filter(p => p.url().includes('linkedin.com/in/'));
  const referrers = refPages.slice(0, 4).map(p => p.url());
  console.log(`[main] Collected ${referrers.length} referrer(s):`);
  referrers.forEach(u => console.log('  ' + u));

  // ── STEP 10: Domain + location ───────────────────────────────────
  const domain = companyCategories
    ? await generateDomainLabel(companyCategories, DOMAIN_EXAMPLES)
    : await ask('Domain (1 word, e.g. fintech, healthcare, AI): ');

  // Navigate to /about/ — the only page that has structured Headquarters data
  const aboutUrl = linkedinCompanyUrl.replace(/\/?$/, '') + '/about/';
  await coPage.goto(aboutUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const rawLoc = await coPage.evaluate(() => {
    for (const dt of document.querySelectorAll('dt')) {
      if (/^\s*headquarters\s*$/i.test(dt.textContent)) {
        const dd = dt.nextElementSibling;
        if (dd?.textContent?.trim()) return dd.textContent.trim();
      }
    }
    return null;
  }).catch(() => null);
  console.log(`[main] Raw location: ${rawLoc ?? '(not found)'}`);
  const loc = rawLoc
    ? await normalizeLocation(rawLoc)
    : await ask('Location (e.g. Toronto, US, Vancouver): ');

  // ── STEP 11: Write to Google Sheet ──────────────────────────────
  console.log('[main] Sheet data:', { jobTitle, jobRole, companyName: orgName, domain, loc, referrers });
  await appendApplication({
    jobUrl,
    jobTitle,
    jobRole,
    companyName: orgName,
    linkedinCompanyUrl,
    domain,
    loc,
    referrers,
  });

  await saveSession('apollo', apolloCtx, apolloPage);

  // ── STEP 12: Final confirmation ──────────────────────────────────
  await ask('\n[main] Entry added to sheet. Verify it, then press Enter to close...\n');

  await linkedinBrowser.close();
  await apolloBrowser.close();
  console.log('[main] Done.');
}

main().catch(err => { console.error('[main] Fatal:', err); process.exit(1); });
