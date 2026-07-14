# Job Application Automation

With this tool I can make **30-50** applications per day.

Unfortunately, AI keeps taking over many IT jobs. These days, around 400 candidates apply for a single position, and often recruiters don't even open your CV. To increase my chances of getting an interview with a good company, I'm looking for referrals from people who share a similar technical background and speak the same language as me.  

Automates steps 5–7 of the job application process: finds referrers at a company via Apollo.io, generates personalized LinkedIn connection messages, and logs the application to Google Sheets.

## Application workflow

Manual process (full flow):

1. Search for jobs on LinkedIn or Jobright
2. Open the job posting page (Greenhouse, Workday, custom page, or LinkedIn Easy Apply)
3. Jobright plugin fills out the application (semi-manual if not LinkedIn)
4. **Run this script** to find referrers at the company:
   - Priority: Ukrainians/Russians in Canada and the US
   - Fallback: people with a matching role (if no UA/RU found)
5. **Script opens** the LinkedIn company page + up to 5 profiles of found people
6. **Script generates** a personalized connection message for each profile and pre-fills the Connect dialog (user reviews and sends manually)
7. **Script logs** the application to Google Sheets: date, status, role, stack, company, domain, location, 4 referrers with "Connection sent" notes

## What the script does

```
1.  Fetches company name and job title via Jobright API (or prompts manually)
2.  LLM classifies the job → Role + Stack (1 call)
3.  Resolves company in Apollo.io
4.  Opens the LinkedIn company page
5.  Cascade referrer search (press Enter to stop early and continue with open tabs):
      Phase 1: Canada (UA/RU name + employer)
      Phase 2: USA   (UA/RU, only if Phase 1 empty)
      Phase 3: Canada by role (cache, no new Apollo requests)
      Phase 4: USA   by role  (cache, only if Phase 3 empty)
      — Enter stops search (plz wait for batch calls finished)
6.  Opens up to 5 LinkedIn profiles for review
7.  Pauses: user closes unwanted tabs, keeps up to 4 → press Enter
8.  LLM determines Domain + isMedtech flag (from Jobright categories)
    Normalizes Loc from LinkedIn company /about/ page
9.  For each open profile tab:
      a. Scrolls profile to load Education / Languages / Experience sections
      b. Scrapes: university, location, about, job description, language flags
      c. Classifies university location + person location + title match (3 parallel LLM calls)
      d. Determines message language:
           Ukrainian university → Ukrainian
           Russian university   → Russian
           Ukrainian in Languages section → Ukrainian
           Russian in Languages section  → Russian
           default              → English
      e. Generates personalized message (~300 chars, gpt-4.1):
           picks 1 customization — tech overlaps (medtech, gamedev, IoT, mobile, DevOps)
           take priority over location hints (Toronto coffee, US company, Ottawa, etc.)
      f. Opens Connect dialog → "Add a note" → pre-fills textarea (does NOT send)
10. Writes a row to Google Sheets + cell notes "Connection sent"
```

## Requirements

- Node.js 18+
- Chrome installed
- Accounts: LinkedIn, Apollo.io, Jobright, Google

## Setup

```bash
npm install
npx playwright install chromium
cp env.example .env
```

Fill in `.env`:

| Variable | Description |
|----------|-------------|
| `AZURE_OPENAI_KEY` | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment name (e.g. `gpt-4.1-mini`) |
| `AZURE_OPENAI_API_VERSION` | API version (default: `2024-08-01-preview`) |
| `GOOGLE_CLIENT_ID` | OAuth Client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth Client Secret |
| `GOOGLE_SPREADSHEET_ID` | Google Sheet ID |
| `GOOGLE_SHEET_GID` | Sheet tab GID |

## Authentication (one-time)

```bash
npm run auth -- --site linkedin   # opens Chrome, log in manually → Enter
npm run auth -- --site apollo     # same
npm run auth -- --site jobright   # same
npm run auth -- --site google     # Account selection and OAuth consent in browser
```

Sessions are saved to `.session/`:

| File | Used for | Renewed |
|------|----------|---------|
| `.session/linkedin.json` | opening LinkedIn profiles | manually (rarely) |
| `.session/apollo.json` | Apollo people search API | auto after each run |
| `.session/jobright.json` | Jobright lookup API (`SESSION_ID` cookie) | manually when expired |
| `.session/google.json` | Google Sheets write | auto (refresh token) |

### Google OAuth (one-time setup)

1. [Google Cloud Console](https://console.cloud.google.com/)  create a project
2. Enable the **Google Sheets API**
3. Credentials → OAuth 2.0 Client ID → **Desktop App** → copy to `.env`
4. OAuth consent screen - **Test Users** - add your email
5. `npm run auth -- --site google`

## Usage

```bash
npm run start -- <job-page-url> [--role DevOps]
```

```bash
npm run start -- "https://job-boards.greenhouse.io/sony/jobs/123"
npm run start -- "https://boards.greenhouse.io/example/jobs/456" --role Backend
```

The script pauses twice:
1. After opening profiles — close unwanted tabs, keep up to 4, press Enter
2. After writing to the sheet — verify the row, press Enter to close browsers

**Tip:** during the referrer search (Phase 1–4), press **Enter** to stop early and continue with whatever profiles are already open. The current LLM batch will finish first, then the search stops. Stdin is flushed after the search so any extra keypresses don't leak into the next prompt.

### Standalone search (no Sheets logging)

```bash
npm run find -- --name "Sony Interactive Entertainment"
npm run find -- --id 5f3a1b2c3d4e5f6a7b8c9d0e
npm run find -- "https://app.apollo.io/#/companies/..."
npm run find -- --name "Shopify" --role Backend --location "Canada" --maxresults 10
```

## File structure

```
src/
├── main.js       — orchestration (main script)
├── auth.js       — authentication (linkedin / apollo / jobright / google)
├── session.js    — browser session save/restore
├── find.js       — standalone search (CLI without Sheets)
├── finder.js     — referrer search logic (cascadeSearch → findPeople)
├── apollo.js     — Apollo.io API via browser session
├── jobright.js   — Jobright API (HTTP, SESSION_ID cookie)
├── llm.js        — Azure OpenAI: name/role/domain/location/message generation
├── linkedin.js   — LinkedIn profile scraping + Connect dialog filling
├── sheets.js     — Google Sheets writer
└── config.js     — role options and Stack/Domain examples for LLM few-shot
```
