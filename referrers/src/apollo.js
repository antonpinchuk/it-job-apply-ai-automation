/**
 * Apollo.io API client — all calls via page.evaluate(fetch(...)) to leverage
 * the browser session (needed for Cloudflare cf_clearance bypass).
 * No UI interaction at all.
 */

// Cached auth (CSRF token + owner ID), fetched once per session
let _auth = null;

async function getAuth(page) {
  if (_auth) return _auth;
  _auth = await page.evaluate(async () => {
    const csrf = document.cookie.split(';').map(c => c.trim())
      .find(c => c.startsWith('X-CSRF-TOKEN='))?.split('=').slice(1).join('=') || '';
    const res = await fetch('/api/v1/users/current', {
      headers: { 'x-csrf-token': csrf, 'x-accept-language': 'en' },
    });
    const data = await res.json();
    return { csrf, ownerId: data.user?.id || '' };
  });
  return _auth;
}

async function apolloFetch(page, path, body) {
  const { csrf } = await getAuth(page);
  return page.evaluate(
    async ({ path, body, csrf }) => {
      const res = await fetch(`https://app.apollo.io${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          'x-accept-language': 'en',
        },
        body: JSON.stringify(body),
      });
      return res.json();
    },
    { path, body, csrf }
  );
}

/**
 * Resolves a LinkedIn company URL to an Apollo organization ID.
 * @param {import('playwright').Page} page
 * @param {string} linkedinUrl  e.g. https://www.linkedin.com/company/beyondtrust
 * @returns {Promise<string>} Apollo org ID
 */
export async function resolveOrgId(page, linkedinUrl, { id, name } = {}) {
  const { csrf } = await getAuth(page);

  if (id) {
    const data = await page.evaluate(
      async ({ id, csrf }) => {
        const res = await fetch(`/api/v1/organizations/${id}`, {
          headers: { 'x-csrf-token': csrf, 'x-accept-language': 'en' },
        });
        return res.json();
      },
      { id, csrf }
    );
    const orgName = data.organization?.name || id;
    console.log(`[apollo] Using org: "${orgName}" → ${id}`);
    return { id, name: orgName };
  }

  const slug = linkedinUrl ? linkedinUrl.replace(/\/$/, '').split('/').pop().toLowerCase() : null;
  const query = name || (slug && slug.replace(/-/g, ' '));
  if (!query) throw new Error('[apollo] Provide <linkedin_url> or --name or --id');
  console.log(`[apollo] Searching org: "${query}"`);

  const data = await page.evaluate(
    async ({ query, csrf }) => {
      const res = await fetch(
        `/api/v1/organizations/search?q_organization_fuzzy_name=${encodeURIComponent(query)}&display_mode=fuzzy_select_mode&per_page=25`,
        { headers: { 'x-csrf-token': csrf, 'x-accept-language': 'en' } }
      );
      return res.json();
    },
    { query, csrf }
  );

  const orgs = data.organizations || [];
  if (!orgs.length) throw new Error(`[apollo] Company not found. Try --name="Company Name" or --id=<apollo_id>`);

  for (const o of orgs) {
    console.log(`[apollo]   "${o.name}" (${o.id})`);
  }

  // organizations/search doesn't return linkedin_url — fetch full details for top candidates
  const candidates = orgs.slice(0, 3);
  const details = await Promise.all(candidates.map(o =>
    page.evaluate(
      async ({ id, csrf }) => {
        const r = await fetch(`/api/v1/organizations/${id}`, {
          headers: { 'x-csrf-token': csrf, 'x-accept-language': 'en' },
        });
        const d = await r.json();
        return d.organization || null;
      },
      { id: o.id, csrf }
    )
  ));

  const byUrl = slug && details.find(o =>
    o?.linkedin_url && o.linkedin_url.replace(/\/$/, '').split('/').pop().toLowerCase() === slug
  );
  const org = byUrl || details[0] || orgs[0];
  const matched = byUrl ? ' ✓ URL match' : ' (first result)';
  console.log(`[apollo] Using org: "${org.name}" → ${org.id}${matched}`);
  return { id: org.id, name: org.name };
}

/**
 * Fetches one page of engineering contacts for an org.
 * @param {import('playwright').Page} page
 * @param {string} orgId
 * @param {number} pageNum
 * @param {string} location  e.g. "Canada"
 * @returns {Promise<{ contacts: Array, totalPages: number, totalEntries: number }>}
 */
const IT_DEPARTMENTS = [
  // Information Technology (top-level)
  'master_information_technology',
  // Engineering & Technical — IT-specific subdepartments only
  'software_development',
  'devops',
  'cloud_mobility',
  'data_science',
  'artificial_intelligence_machine_learning',
  'web_development',
  'mobile_development',
  'test_quality_assurance',
  'ui_ux',
  'technology_operations',
  'digital_transformation',
  'emerging_technology_innovation',
  'business_intelligence',
  'scrum_master_agile_coach',
  'project_management',
  'support_technical_services',
];

export async function fetchContactsPage(page, orgId, pageNum, location) {
  const data = await apolloFetch(page, '/api/v1/mixed_people/search', {
    organization_ids: [orgId],
    person_department_or_subdepartments: IT_DEPARTMENTS,
    person_locations: [location],
    page: pageNum,
    per_page: 25,
    display_mode: 'explorer_mode',
  });

  const people = data.people || [];
  const pg = data.pagination || {};

  const contacts = people.map(p => ({
    id: p.id,
    name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
    linkedinUrl: p.linkedin_url || null,
    employment: extractEmploymentOrgs(p),
  }));

  console.log(`[apollo] Page ${pageNum}/${pg.total_pages || '?'} — ${people.length} people`);

  return { contacts, totalPages: pg.total_pages || 1, totalEntries: pg.total_entries || 0 };
}

function extractEmploymentOrgs(person) {
  return (person.employment_history || [])
    .map(e => e?.organization_name)
    .filter(Boolean);
}
