# 002 — Orchestration: full application flow

## Goal

Wire all components into a single script:
- fetch job data (Jobright API)
- LLM classification of role, stack, domain, location
- referrer search (finder, task 001)
- open browser for the user
- write a row to Google Sheets

Input: job posting URL.
Pauses: 2 (tab review + sheet confirmation).

---

## Incremental implementation

### Step 1 — Session management (`src/session.js`)

Saves and restores browser cookie sessions between runs.

```js
const CONFIGS = {
  linkedin: { file: '.linkedin-session.json', origin: 'https://www.linkedin.com' },
  apollo:   { file: '.apollo-session.json',   origin: 'https://app.apollo.io' },
  jobright: { file: '.jobright-session.json', origin: 'https://api.jobright.ai' },
};

sessionExists(site)               // check if file exists
applySession(site, ctx, page?)    // load cookies into browserContext
saveSession(site, ctx, page?)     // save current cookies to file
```

Apollo session is saved after every run (cookies are refreshed).
LinkedIn and Jobright — only on `npm run auth`.

---

### Step 2 — Auth CLI (`src/auth.js`)

```bash
npm run auth -- --site linkedin   # or apollo | jobright | google
```

**linkedin / apollo / jobright:**
1. `chromium.launch({ headless: false, channel: 'chrome' })` + stealth
2. Navigate to the site, wait for `Press Enter after login...`
3. `saveSession(site, ctx)`

**google:**
1. Read `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` from env
2. Generate OAuth URL (scope: `https://www.googleapis.com/auth/spreadsheets`)
3. Open in browser via `child_process.exec('start <url>')`
4. HTTP server at `localhost:3000/callback` → exchange code → tokens
5. Save to `.google-token.json`
6. `process.exit(0)` — required, otherwise the server hangs

**Key:** `isLoggedOut(apolloPage)` — checks Apollo login state (used in main.js).

**env:**
```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_SPREADSHEET_ID=1ZK40F0AT1APCz6cLap3K16lseTjRZPYMLqCrU8yOrio
GOOGLE_SHEET_GID=1374814009
```

---

### Step 3 — Jobright API (`src/jobright.js`)

Fetches company name and job title from a job posting URL.

**Auth:** `SESSION_ID` cookie from `.jobright-session.json`.

**Two endpoints:**
```
GET https://www.jobright.ai/swan/autofill/lookup-by-url?url=<encoded>
  → { result: "jobId" }

GET https://www.jobright.ai/swan/share/job/banner/<jobId>
  → { result: { jobResult: { jobTitle }, companyResult: { companyName, companyCategories } } }
```

**Required header:** `sec-fetch-storage-access: active` — without it the API returns null.

**Optimization:** if the URL contains `?jr_id=<id>`, skip lookup and call banner directly.

```js
export async function lookupJob(jobUrl) {
  // → { companyName, jobTitle, companyCategories } or null
}
```

`companyCategories` — comma-separated string (e.g. `"Gaming,Video Games,Consumer Goods"`), used for LLM domain generation.

If Jobright returns null (URL not in database or SESSION_ID expired) → main.js prompts for data manually.

---

### Step 4 — LLM classification (`src/llm.js` + `src/config.js`)

All functions go through `ask(prompt)` — Azure OpenAI, `response_format: json_object`, `temperature: 0`.
On 429 — pause 61 seconds, auto-retry.

#### `classifyTitleRoleStack(title, roleOpts, stackExamples)` → `{ role, stack }`

Single LLM call — classifies both role and stack.

`role` — strictly one of: `Lead | Architect | Developer | DevOps | MLOps | Director`
`stack` — 1-3 words, technical focus (does not duplicate the role)

Few-shot examples in the prompt:
```
"Team Lead - Cloud DevOps Engineer" → { role: "Lead",      stack: "Cloud DevOps" }
"Senior Technical Architect"        → { role: "Architect",  stack: "Architect" }
"Staff Machine Learning Platform"   → { role: "Lead",       stack: "Platform, ML" }
"Site Reliability Engineer"         → { role: "DevOps",     stack: "SRE" }
```

`ROLE_OPTIONS` and `STACK_EXAMPLES` — from `src/config.js`, add new examples to `STACK_EXAMPLES` as they accumulate.

#### `generateDomainLabel(categories, examples)` → `string`

Takes `companyCategories` from Jobright. Returns 1 word (or a short phrase).
`DOMAIN_EXAMPLES` from config.js — few-shot for style (`fintech`, `gaming`, `HR tech`, etc.).

#### `normalizeLocation(raw)` → `string`

Normalizes raw location text from the LinkedIn company page:
- large city → city (`"Toronto"`)
- smaller city in USA/Canada → state/province (`"BC"`, `"TX"`)
- outside USA/Canada → country (`"Germany"`)
- Remote → `"Remote"`

---

### Step 5 — Google Sheets (`src/sheets.js`)

#### OAuth

`getOAuth2Client()` → reads `.google-token.json`, auto-refreshes via googleapis.

#### `appendApplication(data)` → `rowNum`

Writes one row, structure (A–P, 16 columns):

| Col | # | Value |
|-----|---|-------|
| A | 0 | `today()` — `DD/MM/YYYY` |
| B | 1 | `"Applied"` |
| C | 2 | `jobRole` (Lead/DevOps/etc) |
| D | 3 | `=HYPERLINK("jobUrl";"stack label")` |
| E | 4 | `=HYPERLINK("linkedinCompanyUrl";"companyName")` |
| F | 5 | `domain` |
| G | 6 | `loc` |
| H–K | 7–10 | empty (Contact, Recruiter, Salary, Rate) |
| L–O | 11–14 | LinkedIn URLs of referrers (up to 4) |
| P | 15 | empty (Notes) |

**HYPERLINK formula:** separator `;` (not `,`) — for European locale Google Sheets.

**Cell notes:** after the append API call — a separate `batchUpdate` adds the note `"Connection sent"` to each non-empty referrer cell (L–O).

`getSheetTitle(sheetsApi)` — resolves GID to sheet tab title via `spreadsheets.get`, cached for the duration of the run.

---

### Step 6 — Apollo integration (`src/apollo.js`)

#### `resolveOrgId(apolloPage, linkedinUrl?, { name?, id? })` → `{ id, name, linkedinUrl }`

Searches for a company in Apollo. Options:
- by `id` (24-char hex) — direct GET `/api/v1/organizations/<id>`
- by `name` — POST `/api/v1/mixed_companies/search`
- by LinkedIn URL — same search with URL filter

All requests go through `apolloPage.evaluate(fetch, ...)` — uses the browser's auth cookies.

#### `fetchContactsPage(apolloPage, orgId, pageNum, location)` → `{ contacts, totalPages }`

POST `/api/v1/mixed_people/search`:
- `organization_ids: [orgId]`
- `person_locations: [location]` (e.g. `"Canada"` or `"United States"`)
- `page: pageNum`, `per_page: 25`

Each contact: `{ name, title, linkedinUrl, employment[] }`.

---

### Step 7 — Main orchestration (`src/main.js`)

#### CLI:
```bash
npm run start -- <job-page-url> [--role DevOps]
```

#### Two browsers:
```
headful Chrome  — LinkedIn (user sees this)
  ctx: LinkedIn session
  tabs: job page, company page, profile tabs

headless Chrome — Apollo (background)
  ctx: Apollo session
  1 tab: app.apollo.io
```

Stealth plugin (`puppeteer-extra-plugin-stealth`) on both.

#### Full flow:

```
1. parseArgs → { jobUrl, role }
2. Check sessionExists('linkedin') and sessionExists('apollo') and sessionExists('jobright') and sessionExists('google')

3. Launch headful + headless browsers
   headless → applySession('apollo') → goto apollo.io → check isLoggedOut

4. Open jobUrl in headful browser (new tab)

5. lookupJob(jobUrl) → { companyName, fullJobTitle, companyCategories }
   if null → ask('Company name: ') + ask('Full job title: ')

6. classifyTitleRoleStack(fullJobTitle) → { role: jobRole, stack: jobTitle }

7. resolveOrgId(apolloPage, { name: companyName }) → { orgId, orgName, linkedinCompanyUrl }
   loop: if not found → ask("Enter different name, Apollo ID, or blank to skip")
   supports direct 24-char hex input → resolveOrgId({ id })
   if linkedinCompanyUrl is empty → generate from orgName

8. Open linkedinCompanyUrl in headful browser (new tab = coPage)

9. search for people: cascadeSearch(apolloPage, orgId, role) → { toOpen, allResults, allMaybes }

10. Open each URL from toOpen as a new tab in headful browser

11. ask("Review tabs. Close unwanted. Press Enter...") - user reviews profiles, closes unwanted ones, opens interesting ones from the log (new tabs in the playwright browser)

12. Collect open tabs from headful ctx:
    linkedinCtx.pages()
      .filter(p => p.url().includes('linkedin.com/in/'))
      .slice(0, 4)
      .map(p => p.url())
    → referrers[]

13. company domain:
    if companyCategories → generateDomainLabel(companyCategories, DOMAIN_EXAMPLES)
    otherwise → ask('Domain: ')

14. company headquarters location
    rawLoc from coPage:
    Primary: find <dt> with text "Headquarters", take <dd>.textContent
    Fallback: .org-top-card-summary-info-list__info-item, exclude /follower|employee|\d+|remote/i
    → normalizeLocation(rawLoc) or ask('Location: ')

15. write row to Google Sheet
    appendApplication({ jobUrl, jobTitle, jobRole, companyName: orgName,
                        linkedinCompanyUrl, domain, loc, referrers })

16. saveSession('apollo', apolloCtx, apolloPage)

17. ask("Entry added. Verify sheet, then press Enter to close...")

18. linkedinBrowser.close() + apolloBrowser.close()
```

---

## Google Sheet

**Spreadsheet ID:** `1ZK40F0AT1APCz6cLap3K16lseTjRZPYMLqCrU8yOrio`
**Sheet GID:** `1374814009`

---

## env.example (full list)

```
AZURE_OPENAI_KEY=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_DEPLOYMENT=
AZURE_OPENAI_API_VERSION=2024-08-01-preview

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_SPREADSHEET_ID=1ZK40F0AT1APCz6cLap3K16lseTjRZPYMLqCrU8yOrio
GOOGLE_SHEET_GID=1374814009
```
