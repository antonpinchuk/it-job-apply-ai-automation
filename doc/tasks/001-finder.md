# 001 — Finder: referrer search at a company

## Goal

Find employees at a company via Apollo.io and filter those who:
- have a Ukrainian or Russian name (priority 1)
- work or have worked at a UA/RU IT company (confirmed UA/RU)
- or have a matching role/title (fallback if no UA/RU found)

Return up to 5 LinkedIn URLs sorted by LLM confidence.

---

## Files

- `src/finder.js` — `findPeople(apolloPage, orgId, opts)` + helpers
- `src/llm.js` — `classifyPerson`, `isUkrOrRusEmployer`
- `src/apollo.js` — `fetchContactsPage(apolloPage, orgId, pageNum, location)`
- `src/find.js` — standalone CLI to run without main.js

---

## Apollo.io — fetching contacts

`fetchContactsPage(apolloPage, orgId, pageNum, location)`:

- Makes a POST request to the Apollo API via `apolloPage.evaluate()` (to use the browser's auth session)
- URL: `https://app.apollo.io/api/v1/mixed_people/search`
- Params: `organization_ids`, `person_locations`, `page`, `per_page: 25`
- Returns `{ contacts, totalPages }` where each contact is: `{ name, title, linkedinUrl, employment[] }`
- `employment` — array of company names where the person has worked (from the Apollo profile)

---

## LLM classification

### `classifyPerson(name, title, role)` → single LLM call for two tasks

**Task 1 — name origin:**
- `nameOrigin`: `"ukrainian"` | `"russian"` | `"other"`
- `nameConfidence`: `"high"` | `"medium"` | `"low"`

**Task 2 — role match:**
- `roleMatch`: `true` | `false` — whether `title` matches the target `role` (or a closely related area)
- `roleConfidence`: `"high"` | `"medium"` | `"low"`

One LLM call per person instead of two — fewer tokens, faster.

Returns:
```js
{ isUkrOrRus: boolean, nameConfidence, roleMatch: boolean, roleConfidence }
```

### `isUkrOrRusEmployer(employers[], name)` → boolean

- Takes an array of company names (up to 8 from employment)
- Asks LLM: whether any of them are UA/RU IT companies (Intellias, EPAM, SoftServe, Ciklum, N-iX, Luxoft, Sigma, Infopulse, etc.)
- Returns `true` / `false`

---

## `findPeople(apolloPage, orgId, opts)` — main function

### `opts` parameters:
```js
{
  location: 'Canada',   // Apollo location filter
  maxResults: 5,        // stop after N confirmed UA/RU
  role: 'DevOps',       // target role for roleMatch
}
```

### Algorithm (per Apollo page):

```
for each Apollo page:
  1. fetchContactsPage → contacts[]

  2. classifyPerson for ALL contacts in parallel (concurrency=3)
     → classified[]: { contact, isUkrOrRus, nameConfidence, roleMatch, roleConfidence }

  3. nameMatches = classified.filter(r => r.isUkrOrRus)
     isUkrOrRusEmployer for each nameMatch (in parallel, concurrency=3)
     → withEmployer[]: { ...r, empMatch: boolean }

  4. For each withEmployer:
     - if empMatch   → results[] (confirmed UA/RU)
     - otherwise     → maybes[]  (UA/RU name, but employer not confirmed)
     - if results.length >= maxResults → stop pagination (break outer)

  5. byRole cache: classified where !isUkrOrRus && roleMatch
     → collected alongside results/maybes, without stopping

  next page (with 500-1000ms delay for anti-bot)
```

### Returns:
```js
{
  results: [{ name, linkedinUrl, confidence }],  // confirmed UA/RU, sorted by confidence
  maybes:  [{ name, linkedinUrl, confidence }],  // UA/RU name without confirmed employer
  byRole:  [{ name, linkedinUrl, confidence }],  // role-match, not UA/RU (cache for phases 3-4)
}
```

All three arrays are sorted `high → medium → low` by `nameConfidence` / `roleConfidence`.

---

## Cascade search — `cascadeSearch(apolloPage, orgId, role)` in main.js

```
Phase 1: findPeople({ location: 'Canada', maxResults: 5, role })
  → if results > 0 or maybes > 0 → stop (skip phases 2-4)

Phase 2: findPeople({ location: 'United States', maxResults: 5, role })
  → only if Phase 1 is empty
  → if results > 0 or maybes > 0 → stop

Phase 3: ca.byRole (already collected in Phase 1, no new Apollo requests)
  → only if Phase 2 is empty

Phase 4: us.byRole (already collected in Phase 2, no new Apollo requests)
  → only if Phase 3 is empty
```

Phases 3-4 use `byRole` from already-executed phases — no new Apollo requests.

### Building the list of tabs to open:
```js
toOpen = [
  ...allResults.slice(0, 5),              // confirmed UA/RU first
  ...allMaybes
    .sort(high → medium → low)
    .slice(0, 5 - allResults.length)      // fill up to 5
    .map(m => m.linkedinUrl)
]
```

---

## Standalone CLI — `src/find.js`

```bash
npm run find -- --name "Sony Interactive Entertainment"
npm run find -- --id 5f3a1b2c3d4e5f6a7b8c9d0e
npm run find -- "https://app.apollo.io/#/companies/..."
npm run find -- --name "Shopify" --role Backend --location Canada --maxresults 10
```

- Launches headless Apollo browser (no window)
- Prints results to console (LinkedIn URLs + confidence)
- Does not write to Google Sheets

---

## Concurrency

```js
const LLM_CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '3', 10);

async function mapConcurrent(items, concurrency, fn) {
  // worker pool: N parallel tasks over items array
}
```

`classifyPerson` and `isUkrOrRusEmployer` run N at a time in parallel.
On 429 (rate limit) — `llm.js` pauses all requests for 61 seconds automatically.
