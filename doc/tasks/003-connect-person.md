# 003 — Connect: personalized LinkedIn message generation

## Goal

After the user reviews and selects profile tabs (Step 8 of main flow), automatically:
1. Scrape each open LinkedIn profile for context (university, location, about, experience, languages)
2. Generate a personalized, language-aware connection message via LLM (~300 chars)
3. Open the Connect dialog and pre-fill the note — without sending
4. After all profiles are processed, continue to Google Sheets logging

---

## Files

- `src/linkedin.js` — `scrapeProfileData(page)` + `fillConnectNote(page, message)`
- `src/llm.js` — `generateConnectMessage(data)`, `classifyUniversityLocation(uni)`, `classifyPersonLocation(loc)`, `titleMatchesJobRole(title, role)`

---

## Step 9b — Scraping each LinkedIn profile

### `scrapeProfileData(page)` → `{ location, about, university, currentJobDesc, currentCompanyTitle, hasUkrainian, hasRussian }`

LinkedIn lazy-loads Education, Experience, and Languages sections. Scroll gradually before reading DOM:

```js
for (let i = 1; i <= 8; i++) {
  await page.evaluate(step => window.scrollTo(0, step * 600), i);
  await page.waitForTimeout(300);
  const hasEdu = await page.evaluate(() =>
    [...document.querySelectorAll('section')].some(s =>
      /education/i.test(s.querySelector('h2')?.textContent?.trim() || '')
    ) || /\bEducation\b/.test(document.body.innerText)
  );
  if (hasEdu) break;
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(200);
```

Then run a single `page.evaluate()` that reads all fields at once.

---

### University — 3-strategy fallback

**Strategy 1 — top card span:**
LinkedIn shows the most recent school in the top card section (identified by having a `messaging/compose` or `custom-invite` link). Look for leaf `<span>` elements matching `/university|institute|college|school|academy|polytechnic|університет|інститут|коледж|академія/i`.

**Strategy 2 — Education section:**
After scrolling, look for a `<section>` with an `<h2>` matching `/education/i`. Try in order:
- `span.t-bold span[aria-hidden="true"]`
- `li span.t-bold`
- `a[href*="/school/"]`
- first `<li>` heading

**Strategy 3 — body text regex:**
```
/\bEducation\b[\s\S]{0,20}?\n([\w\s''`\-–—,().]+(?:University|Institute|College|School|Academy|Polytechnic|Університет|Інститут)[^\n]{0,60})/i
```

---

### Location — body text regex

Do NOT use DOM span search — it catches unrelated text (programming languages, About section).

Use body text with a province/state regex:
```
/[\n·]\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-\.]{2,40},\s*(?:British Columbia|Ontario|Alberta|...|[A-Z]{2})[^.\n]{0,50})\s*[\n·]/
```

Take the last line of the match (`.split('\n').pop().trim()`) to strip any job title prefix that LinkedIn may prepend on the same line.

---

### Languages section

Check for Ukrainian and Russian in the Languages section or body text fallback:
```js
const langSectionText = (() => {
  for (const section of document.querySelectorAll('section')) {
    if (/^languages?$/i.test(section.querySelector('h2')?.textContent?.trim() || ''))
      return section.innerText;
  }
  const m = bodyText.match(/\bLanguages?\b([\s\S]{0,400}?)(?:\n\n[A-Z]|\nSkills|\nInterests|\nRecommendations|$)/i);
  return m ? m[1] : '';
})();
hasUkrainian = /ukrainian|украї?нська/i.test(langSectionText);
hasRussian   = /russian|русский|русська/i.test(langSectionText);
```

---

### Experience — current company title

From the Experience section, take the first `<li>` and extract:
- title: `span.t-bold span[aria-hidden="true"]` → `span[aria-hidden="true"]` → `h3`
- description: `[data-testid="expandable-text-box"]` → `span[tabindex="-1"]` → `.visually-hidden`

Fallback: body text `\bExperience\b[\s\S]{0,10}?\n([^\n]{5,80})\n`.

`currentCompanyTitle` takes priority over Apollo title in `main.js`:
```js
const personTitle = profileData?.currentCompanyTitle || apolloPerson?.title || '';
```

---

## Step 9c — Message generation

### `generateConnectMessage(data)` — uses `gpt-4.1` (strong model)

**Input:**
```js
{
  name, title, companyName, jobTitle, jobRole,
  nameOrigin,       // from Apollo classification
  university,       // scraped
  location,         // scraped
  profileAbout,     // scraped
  currentJobDesc,   // scraped
  isMedtech,        // from generateDomainLabel()
  isUSCompany,      // derived from normalized HQ location
  hasUkrainian,     // scraped
  hasRussian,       // scraped
}
```

**Parallel LLM calls (3 at once):**
```js
const [uniLoc, personLoc, titleMatch] = await Promise.all([
  classifyUniversityLocation(university),  // 'Kropyvnytskyi'|'Ukraine'|'Russia'|'Other'
  classifyPersonLocation(location),        // 'Toronto'|'Ottawa'|'Canada'|'US'|'Other'
  titleMatchesJobRole(title, jobRole),     // boolean
]);
```

### Language selection

University location is the primary signal. Languages section is the fallback. English is default:
```
uniLoc === 'Ukraine' || uniLoc === 'Kropyvnytskyi' → Ukrainian
uniLoc === 'Russia'                                → Russian
hasUkrainian                                       → Ukrainian
hasRussian                                         → Russian
default                                            → English
```

### Title match: LLM semantic match

`titleMatchesJobRole(recipientTitle, jobRole)` uses gpt-4.1-mini with explicit NO MATCH examples:
```
NO MATCH for DevOps: Android Developer, iOS Developer, Mobile Engineer, Backend, Frontend
MATCH: Site Reliability Engineer, Cloud Engineer, Platform Engineer, DevEx Engineer
```

### Customizations (pick at most ONE, tech overlaps > location hints)

Detected from profile text via regex:
- `hasGamedev` — `/game|unity|unreal|gamedev/i`
- `hasIoT` — `/iot|embedded|device|firmware|hardware/i`
- `hasMobile` — `/mobile|android|ios|swift|kotlin/i`
- `hasDevOps` — `/devops|ci[\/ ]?cd|kubernetes|jenkins|pipeline|terraform/i`

Customization options (in priority order — tech/interest over location):
1. `titleMatch` → "possibly even your team" / "можливо навіть в твою команду"
2. `isMedtech` → "wanting to move back from fintech to medtech"
3. `hasGamedev` → "I also do gamedev as a hobby on Unreal"
4. `hasIoT` → "I also dabbled in IoT"
5. `hasMobile` → "I spent 10+ years in mobile"
6. `hasDevOps && !titleMatch` → "I see many shared skills"
7. `isUSCompany && personLoc in Canada` → "I see you're in Canada working for a big US company"
8. `personLoc === 'Toronto'` → offer coffee downtown
9. `personLoc === 'Ottawa'` → mention friends in Ottawa
10. `uniLoc === 'Kropyvnytskyi'` → "you might have heard of me"

Instruction to LLM: *"Tech/interest overlaps (medtech, gamedev, IoT, mobile, DevOps, skills) are more important than location hints — prefer them when both apply."*

### Message structure (target ~300 chars, hard limit 300)

```
1. Привіт / Hi / Привет  (NO name after greeting)
2. Your company is hiring <jobRole>
3. I applied
4. Recruiter hasn't responded
5. Looking for ways to get to an interview
6. Happy to connect professionally
[+ 1 personalization if space permits]
```

Real examples from Anton in the prompt for style matching.

---

## Step 9c — Filling the Connect dialog

### `fillConnectNote(page, message)` → `'filled'|'no_connect'|'no_dialog'|'no_textarea'`

1. **Find the Message link** (`a[href*="messaging/compose"]`) to locate the profile actions container.
2. **Try direct Connect link** (`a[href*="custom-invite"]`) — some profiles expose it directly.
3. **Otherwise open "..." dropdown** (`button[aria-label="More"]`) and click the Connect menu item.
4. **Wait for "Add a note" button** → click it.
5. **Fill the textarea** — it lives in a shadow DOM:
```js
for (const el of document.querySelectorAll('*')) {
  if (!el.shadowRoot) continue;
  const ta = el.shadowRoot.querySelector('textarea');
  if (!ta) continue;
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, msg);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
```

Does NOT send (user reviews and sends manually).

---

## Enter — interrupt search and continue

During the cascade search phase, the user can press **Enter** to stop searching and proceed with whatever tabs are already open. Ctrl+C is not used — it conflicts with Playwright's own signal handler.

Implementation in `main.js`:
```js
// Listen for Enter in parallel with the search
const stopSearch = new Promise(resolve => {
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
});
stopSearch.then(() => {
  if (!searchAbort.signal.aborted) {
    searchAbort.abort();
    console.log('\n[search] Stopped — will continue with manually opened tabs.');
  }
});
const { toOpen, allResults, allMaybes } = await cascadeSearch(apolloPage, orgId, role);

// Flush stdin so any extra keypresses don't bleed into the next ask()
process.stdin.resume();
process.stdin.removeAllListeners('data');
await new Promise(resolve => setTimeout(resolve, 50));
process.stdin.pause();
```

In `finder.js`, check abort at two points per page loop:
```js
outer: while (true) {
  if (searchAbort.signal.aborted) break;
  const { contacts, totalPages } = await fetchContactsPage(...);
  const classified = await mapConcurrent(...);
  if (searchAbort.signal.aborted) break;  // also after LLM batch
  // ...
}
```

The current LLM batch finishes before the loop exits — no requests are cancelled mid-flight.

---

## `isUSCompany` — derived in main.js

```js
const US_LOCS_RE = /\b(US|United States|California|New York|Texas|...)\b/i;
const US_STATE_ABBR = /^(AL|AK|AZ|...|DC)$/;
const isUSCompany = US_LOCS_RE.test(loc) || US_STATE_ABBR.test(loc?.trim());
```

Computed from `loc` (normalized HQ location from LinkedIn company page `/about/`) before the connect loop.

---

## `generateDomainLabel` — returns `{ label, isMedtech }`

Extended from task 002's string-only return to also return `isMedtech`:
```js
// isMedtech: true if healthcare, medical devices, telehealth, pharma, hospital tech, or medical SaaS
return only JSON: {"label": "...", "isMedtech": true | false}
```

---

## LLM models

| Function | Model |
|---|---|
| `classifyPerson`, `isUkrOrRusEmployer`, `classifyTitleRoleStack`, `classifyUniversityLocation`, `classifyPersonLocation`, `titleMatchesJobRole` | `gpt-4.1-mini` (env: `AZURE_OPENAI_DEPLOYMENT`) |
| `generateConnectMessage` | `gpt-4.1` (env: `AZURE_OPENAI_DEPLOYMENT_STRONG`) |

Add `AZURE_OPENAI_DEPLOYMENT_STRONG=gpt-4.1` to `.env`.
