import { classifyPerson, isUkrOrRusEmployer } from './llm.js';
import { fetchContactsPage } from './apollo.js';

const LLM_CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '3', 10);
const CONFIDENCE_ORDER = ['high', 'medium', 'low'];

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

function byConfidence(a, b) {
  return CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence);
}

/**
 * Find engineers at a company via Apollo.io.
 *
 * Each person is classified in a single LLM call:
 *   - name origin (UA/RU vs other)
 *   - role relevance (matches target role)
 *
 * Returns three arrays (all sorted by confidence high→low):
 *   results  — confirmed UA/RU (name + employer match)
 *   maybes   — UA/RU name but employer not confirmed
 *   byRole   — role match, not UA/RU (used as fallback in phases 3-4)
 *
 * @param {import('playwright').Page} apolloPage
 * @param {string} orgId
 * @param {{
 *   location?: string,
 *   maxResults?: number,
 *   role?: string,
 * }} opts
 * @returns {Promise<{
 *   results: { name: string, linkedinUrl: string, confidence: string }[],
 *   maybes:  { name: string, linkedinUrl: string, confidence: string }[],
 *   byRole:  { name: string, linkedinUrl: string, confidence: string }[]
 * }>}
 */
export async function findPeople(apolloPage, orgId, {
  location = 'Canada',
  maxResults = 5,
  role = 'DevOps',
} = {}) {
  const results = [];
  const maybes  = [];
  const byRole  = [];
  let pageNum = 1;

  outer: while (true) {
    const { contacts, totalPages } = await fetchContactsPage(apolloPage, orgId, pageNum, location);

    // Single LLM call per person: name origin + role match
    const classified = await mapConcurrent(contacts, LLM_CONCURRENCY, c =>
      classifyPerson(c.name, c.title, role).then(r => {
        if (c.linkedinUrl) console.log(c.linkedinUrl);
        return { contact: c, ...r };
      })
    );

    // Check employer for UA/RU name matches
    const nameMatches = classified.filter(r => r.isUkrOrRus);
    const withEmployer = await mapConcurrent(nameMatches, LLM_CONCURRENCY, r =>
      isUkrOrRusEmployer(r.contact.employment, r.contact.name)
        .then(empMatch => ({ ...r, empMatch }))
    );

    for (const r of withEmployer) {
      if (!r.contact.linkedinUrl) continue;
      if (r.empMatch) {
        results.push({ name: r.contact.name, linkedinUrl: r.contact.linkedinUrl, confidence: r.nameConfidence });
        if (results.length >= maxResults) break outer;
      } else {
        maybes.push({ name: r.contact.name, linkedinUrl: r.contact.linkedinUrl, confidence: r.nameConfidence });
      }
    }

    // Collect role matches for non-UA/RU people (phases 3-4 cache)
    for (const r of classified) {
      if (!r.contact.linkedinUrl) continue;
      if (!r.isUkrOrRus && r.roleMatch) {
        byRole.push({ name: r.contact.name, linkedinUrl: r.contact.linkedinUrl, confidence: r.roleConfidence });
      }
    }

    if (pageNum >= totalPages) break;
    pageNum++;
    await apolloPage.waitForTimeout(500 + Math.floor(Math.random() * 500));
  }

  results.sort(byConfidence);
  maybes.sort(byConfidence);
  byRole.sort(byConfidence);

  return { results, maybes, byRole };
}
