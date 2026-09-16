import OpenAI from 'openai';

function makeClient(deployment) {
  return new OpenAI({
    apiKey: process.env.AZURE_OPENAI_KEY,
    baseURL: `${process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/openai/deployments/${deployment}`,
    defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview' },
    defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_KEY },
  });
}

const client       = makeClient(process.env.AZURE_OPENAI_DEPLOYMENT);
const clientStrong = makeClient(process.env.AZURE_OPENAI_DEPLOYMENT_STRONG || 'gpt-4.1');

let _pauseUntil = 0;

async function ask(prompt, { strong = false, maxTokens = 100 } = {}) {
  const c   = strong ? clientStrong : client;
  const dep = strong
    ? (process.env.AZURE_OPENAI_DEPLOYMENT_STRONG || 'gpt-4.1')
    : process.env.AZURE_OPENAI_DEPLOYMENT;
  for (;;) {
    const wait = _pauseUntil - Date.now();
    if (wait > 0) {
      console.warn(`[llm] Rate limited — waiting ${Math.ceil(wait / 1000)}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
    try {
      const response = await c.chat.completions.create({
        model: dep,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      });
      const raw = response.choices[0].message.content;
      try { return JSON.parse(raw); } catch {
        console.warn(`[llm] Bad JSON: ${raw}`);
        return {};
      }
    } catch (err) {
      if (err?.status === 429) {
        _pauseUntil = Date.now() + 61_000;
        console.warn('[llm] 429 Too Many Requests — pausing 61s');
        continue;
      }
      throw err;
    }
  }
}

/**
 * Single LLM call that classifies both name origin and role relevance.
 *
 * @param {string} name
 * @param {string} title  - person's current job title (from Apollo)
 * @param {string} role   - target role to match against (e.g. "DevOps")
 * @returns {{
 *   isUkrOrRus: boolean,
 *   nameConfidence: 'high'|'medium'|'low',
 *   roleMatch: boolean,
 *   roleConfidence: 'high'|'medium'|'low',
 *   gender: 'male'|'female'|'unknown'
 * }}
 */
export async function classifyPerson(name, title, role) {
  if (!name?.trim()) {
    return { isUkrOrRus: false, nameConfidence: 'low', roleMatch: false, roleConfidence: 'low', gender: 'unknown' };
  }
  const result = await ask(`
Analyze this person for a referral opportunity on a ${role} team.
Name: "${name}"
Current title: "${title || 'unknown'}"
Target role: "${role}"

Answer in JSON:
{
  "nameOrigin": "ukrainian" | "russian" | "other",
  "nameConfidence": "high" | "medium" | "low",
  "roleMatch": true | false,
  "roleConfidence": "high" | "medium" | "low",
  "gender": "male" | "female" | "unknown"
}

nameOrigin: Is the name of Ukrainian or Russian origin?
roleMatch + roleConfidence: Does their title suggest they are a hands-on IC on the ${role} team specifically (same team/specialization AND same individual-contributor level)?
- Titles that are CLEARLY a different specialization (e.g. for target "DevOps": QA Engineer, Backend Engineer, Mobile Engineer, MLOps Engineer, Data Engineer, Frontend Engineer) → roleMatch=false, roleConfidence=high.
- Management, director/VP, or recruiting/talent-acquisition titles (e.g. Engineering Manager, Director of Engineering, VP Engineering, Head of X, Technical Recruiter, Talent Acquisition) → roleMatch=false, roleConfidence=high, REGARDLESS of domain — they are not "on the team" as a peer even if they oversee or hire for it.
- Titles that clearly match the specialization AND are hands-on IC roles (e.g. for "DevOps": Site Reliability Engineer, Cloud Engineer, Platform Engineer, Infrastructure Engineer, DevOps Engineer) → roleMatch=true, roleConfidence=high.
- Generic/ambiguous IC titles that don't reveal a specialization (e.g. "Software Engineer", "Engineer", "SWE", "Senior Engineer" with no other signal) → roleMatch=true, roleConfidence=low. Do NOT treat a generic title as a mismatch — it might well be the same specialization, we just can't tell from the title alone.
gender: Infer from the first name. If genuinely ambiguous or unknown, use "unknown".
Only JSON, no explanation.
  `.trim());

  const nameOrigin = result.nameOrigin || 'other';
  const isUkrOrRus = nameOrigin === 'ukrainian' || nameOrigin === 'russian';
  const nameConfidence = result.nameConfidence || 'low';
  const roleMatch = result.roleMatch === true;
  const roleConfidence = result.roleConfidence || 'low';
  const gender = result.gender || 'unknown';
  console.log(`[llm] "${name}" (${title || '?'}) → origin=${nameOrigin}(${nameConfidence}) role=${roleMatch}(${roleConfidence}) gender=${gender}`);
  return { nameOrigin, isUkrOrRus, nameConfidence, roleMatch, roleConfidence, gender };
}

export async function isUkrOrRusEmployer(employers, name) {
  if (!employers?.length) return false;
  const list = employers.slice(0, 8).join(', ');
  const result = await ask(`
Given this list of companies where a person has worked: "${list}"
Do any of these companies primarily operate in Ukraine or Russia (e.g. Intellias, Edvantis, SoftServe, EPAM, Ciklum, GlobalLogic, N-iX, Luxoft, Sigma, Infopulse, or other UA/RU IT companies)?
Answer in JSON: {"match": true | false, "reason": "short explanation"}
Only JSON, no explanation outside JSON.
  `.trim());
  console.log(`[llm] ${name ? `"${name}" ` : ''}employers "${list}" -> match=${result.match} (${result.reason})`);
  return result.match === true;
}

/**
 * Extract company name and job title from a job page's title + H1 text.
 * Returns null for either field if the LLM can't determine it.
 * @param {string} pageTitle  document.title
 * @param {string} h1         first H1 text on the page
 * @returns {Promise<{companyName: string|null, jobTitle: string|null}>}
 */
export async function extractJobInfoFromPage(pageTitle, h1) {
  const result = await ask(`
Extract the job title and company name from this job posting page.

Page title: "${pageTitle}"
H1 heading: "${h1}"

Return only JSON: {"jobTitle": "...", "companyName": "..."}

Rules:
- jobTitle: the exact job role being advertised (e.g. "Software Engineer, Infrastructure")
- companyName: the hiring company (e.g. "Airbnb"). Do not include Inc/Corp/Ltd suffixes.
- If you cannot determine a field with confidence, set it to null.
  `.trim());
  const jobTitle    = result.jobTitle?.trim()    || null;
  const companyName = result.companyName?.trim() || null;
  console.log(`[llm] Page extract → company="${companyName}" title="${jobTitle}"`);
  return { companyName, jobTitle };
}

/**
 * Classify job title into Role + Stack in one LLM call.
 *
 * @param {string} title       full job title
 * @param {string[]} roleOpts  allowed role values
 * @param {string[]} stackExamples  existing stack labels for few-shot
 * @returns {Promise<{role: string, stack: string}>}
 */
export async function classifyTitleRoleStack(title, roleOpts, stackExamples) {
  const result = await ask(`
Classify this job title into Role and Stack for a job tracker spreadsheet.

Job title: "${title}"

Role must be exactly one of: ${roleOpts.join(', ')}
Role meanings:
- Lead = manages a team (Team Lead, Staff, Principal, Manager, Head of, Director of Eng)
- Architect = designs systems/solutions
- Developer = individual contributor, non-DevOps (Backend, Frontend, Full-stack, Mobile)
- DevOps = infrastructure, CI/CD, SRE, Cloud, Platform Engineer
- MLOps = ML platform, ML infrastructure, AI/ML ops
- Director = Director, VP, C-level

Stack = 1-3 words describing the specific tech/domain focus (NOT duplicating the role word).
Stack examples from previous applications: ${stackExamples.join(', ')}

Few-shot examples:
- "Team Lead - Cloud DevOps Engineer" → {"role":"Lead","stack":"Cloud DevOps"}
- "AI Engineer/Developer" → {"role":"Developer","stack":"AI"}
- "Staff Backend Engineer - Adaptive Telemetry | USA | Remote" → {"role":"Lead","stack":"Backend Telemetry"}
- "Enterprise Application DevOps Engineer" → {"role":"DevOps","stack":"DevOps"}
- "Senior Software Engineer-DevOps" → {"role":"DevOps","stack":"DevOps"}
- "DevOps & Platform Solution Engineer" → {"role":"DevOps","stack":"Platform"}
- "Site Reliability Engineer" → {"role":"DevOps","stack":"SRE"}
- "AWS Infrastructure Developer" → {"role":"DevOps","stack":"AWS"}
- "Developer Experience Engineer" → {"role":"DevOps","stack":"DevEx"}
- "Software Engineer, Developer Experience" → {"role":"DevOps","stack":"DevEx"}
- "Engineering Manager - Machine Learning" → {"role":"Lead","stack":"ML"}
- "AI/ML Engineer" → {"role":"Developer","stack":"AI/ML"}
- "Staff Cloud Engineer, Site Reliability Engineering" → {"role":"Lead","stack":"DevOps"}
- "Staff Machine Learning Platform Engineer" → {"role":"Lead","stack":"Platform, ML"}
- "Senior Technical Architect (Healthcare)" → {"role":"Architect","stack":"Architect"}

Return only JSON: {"role": "...", "stack": "..."}
  `.trim());
  const role  = result.role?.trim()  || 'DevOps';
  const stack = result.stack?.trim() || title;
  console.log(`[llm] Role: "${role}"  Stack: "${stack}"  (from: "${title}")`);
  return { role, stack };
}

/**
 * Normalize a raw location string from LinkedIn to a short display value.
 * @param {string} raw  e.g. "San Mateo, CA, United States"
 * @returns {Promise<string>}  e.g. "San Mateo" / "ON" / "Germany"
 */
export async function normalizeLocation(raw) {
  const result = await ask(`
Normalize this location to a short display value for a job tracker.

Raw location: "${raw}"

Rules:
- Well-known large city (Toronto, Vancouver, San Francisco, New York, Seattle, Austin, etc.) → just city
- Smaller city in US or Canada → state/province (e.g. "BC", "ON", "TX", "WA")
- Outside US and Canada → country name
- "Remote" or "Anywhere" → "Remote"
- US, no specific city → "US"
- Canada, no specific city → "Canada"

Return only JSON: {"location": "..."}
  `.trim());
  const loc = result.location?.trim() || raw;
  console.log(`[llm] Location: "${loc}" (from: "${raw}")`);
  return loc;
}

/**
 * Generate a 1-word domain label from Jobright company categories.
 * Also returns isMedtech flag for connect message personalization.
 * @param {string} categories  e.g. "Consumer Goods,Gaming,Video Games"
 * @param {string[]} examples  existing domain values from config.js
 * @returns {Promise<{label: string, isMedtech: boolean}>}
 */
export async function generateDomainLabel(categories, examples) {
  const result = await ask(`
Classify this company into a 1-word industry domain label.

Input company categories from Jobright: "${categories}"

Examples of labels from previous applications (match this style):
${examples.join(', ')}

Rules:
- Exactly 1 word (or short phrase if truly necessary, e.g. "HR tech")
- Prefer reusing an existing example if it fits well ("HR" -> recruiting, "dating app" -> social media) 
- Otherwise create a new label in the same style (low case)
- isMedtech: true if the company is in healthcare, medical devices, telehealth, pharma, hospital tech, or medical SaaS

Return only JSON: {"label": "...", "isMedtech": true | false}
  `.trim());
  const label = result.label?.trim() || categories.split(',')[0].trim().toLowerCase();
  const isMedtech = result.isMedtech === true;
  console.log(`[llm] Domain label: "${label}" isMedtech=${isMedtech} (from: "${categories}")`);
  return { label, isMedtech };
}

/**
 * Classify a university location for connect message personalization.
 * @param {string} university
 * @returns {Promise<'Kropyvnytskyi'|'Ukraine'|'Russia'|'Other'>}
 */
export async function classifyUniversityLocation(university) {
  if (!university?.trim()) return 'Other';
  const result = await ask(`
Where is this university located? "${university}"

Return JSON: {"location": "Kropyvnytskyi" | "Ukraine" | "Russia" | "Other"}

Rules:
- "Kropyvnytskyi" — if in Kropyvnytskyi / Kirovograd / Кропивницький / Кіровоград, Ukraine
- "Ukraine" — any other Ukrainian university
- "Russia" — any Russian university
- "Other" — everything else (US, Canada, EU, etc.)

Only JSON.
  `.trim());
  const loc = result.location || 'Other';
  console.log(`[llm] University "${university}" location → ${loc}`);
  return loc;
}

/**
 * Classify a person's location for connect message personalization.
 * @param {string} rawLocation  — scraped from LinkedIn profile page
 * @returns {Promise<'Toronto'|'Ottawa'|'Canada'|'US'|'Other'>}
 */
export async function classifyPersonLocation(rawLocation) {
  if (!rawLocation?.trim()) return 'Other';
  const result = await ask(`
Classify this person's location for a job referral tool.

Location: "${rawLocation}"

Return JSON: {"location": "Toronto" | "Ottawa" | "Canada" | "US" | "Other"}

Rules:
- "Toronto" — Toronto, Mississauga, Brampton, Oakville, Burlington, Hamilton, Markham, Vaughan, Richmond Hill, Newmarket, Pickering, Ajax, Whitby, Oshawa, Scarborough, North York, Etobicoke, GTA
- "Ottawa" — Ottawa, Kanata, Nepean, Gloucester, Orleans, Gatineau
- "Canada" — anywhere else in Canada
- "US" — anywhere in the United States
- "Other" — outside Canada and US

Only JSON.
  `.trim());
  const loc = result.location || 'Other';
  console.log(`[llm] Person location "${rawLocation}" → ${loc}`);
  return loc;
}

/**
 * LLM-based title match: does recipient's title suggest the SAME specialization as the vacancy?
 * Used only as a fallback when no Apollo-derived roleMatch/roleConfidence is available.
 * @param {string} recipientTitle
 * @param {string} jobRole  e.g. "DevOps"
 * @returns {Promise<{match: boolean, confidence: 'high'|'medium'|'low'}>}
 */
async function titleMatchesJobRole(recipientTitle, jobRole) {
  if (!recipientTitle?.trim() || !jobRole?.trim()) return { match: false, confidence: 'low' };
  const result = await ask(`
Does this person's job title suggest they are a hands-on IC on the ${jobRole} team specifically (same team/specialization AND same individual-contributor level), not just a broader engineering department?

Person's title: "${recipientTitle}"
Hiring role: "${jobRole}"

- Titles that are CLEARLY a different specialization (e.g. for target "DevOps": QA Engineer, Backend Engineer, Mobile Engineer, MLOps Engineer, Data Engineer, Frontend Engineer) → match=false, confidence=high.
- Management, director/VP, or recruiting/talent-acquisition titles (e.g. Engineering Manager, Director of Engineering, VP Engineering, Head of X, Technical Recruiter, Talent Acquisition) → match=false, confidence=high, REGARDLESS of domain — they are not "on the team" as a peer even if they oversee or hire for it.
- Titles that clearly match the specialization AND are hands-on IC roles (e.g. for "DevOps": Site Reliability Engineer, Cloud Engineer, Platform Engineer, Infrastructure Engineer, DevOps Engineer) → match=true, confidence=high.
- Generic/ambiguous IC titles that don't reveal a specialization (e.g. "Software Engineer", "Engineer", "SWE") → match=true, confidence=low. Do NOT treat a generic title as a mismatch.

Return JSON: {"match": true | false, "confidence": "high" | "medium" | "low"}
  `.trim());
  return { match: result.match === true, confidence: result.confidence || 'low' };
}

/**
 * Generate a personalized LinkedIn connection message.
 *
 * @param {{
 *   name: string,
 *   title: string,
 *   companyName: string,
 *   jobTitle: string,
 *   jobRole: string,
 *   nameOrigin: 'ukrainian'|'russian'|'other',
 *   university: string|null,
 *   location: string|null,
 *   profileAbout: string|null,
 *   currentJobDesc: string|null,
 *   isMedtech?: boolean,
 *   isUSCompany?: boolean,
 *   hasUkrainian?: boolean,
 *   hasRussian?: boolean,
 *   gender?: 'male'|'female'|'unknown',
 *   roleMatch?: boolean,
 *   roleConfidence?: 'high'|'medium'|'low',
 * }} data
 * @returns {Promise<string>}  The message text (~300 chars)
 */
export async function generateConnectMessage(data) {
  const {
    name, title, companyName, jobTitle, jobRole,
    nameOrigin, university, location, profileAbout, currentJobDesc,
    isMedtech = false, isUSCompany = false,
    hasUkrainian = false, hasRussian = false,
    gender = 'unknown', roleMatch: apolloRoleMatch, roleConfidence: apolloRoleConfidence,
  } = data;

  // ── Parallel: university location + person location + title match ─────────
  // Prefer the roleMatch/roleConfidence already computed from Apollo (finder.js) —
  // only fall back to a fresh LLM call when the recipient wasn't Apollo-classified
  // (e.g. a profile tab opened manually).
  const [uniLoc, personLoc, titleMatchResult] = await Promise.all([
    university ? classifyUniversityLocation(university) : Promise.resolve('Other'),
    location   ? classifyPersonLocation(location)       : Promise.resolve('Other'),
    apolloRoleMatch !== undefined
      ? Promise.resolve({ match: apolloRoleMatch, confidence: apolloRoleConfidence || 'low' })
      : title ? titleMatchesJobRole(title, jobRole) : Promise.resolve({ match: false, confidence: 'low' }),
  ]);
  // Only use the "possibly even your team" personalization when we're confident.
  const titleMatch = titleMatchResult.match && titleMatchResult.confidence === 'high';

  // Language: university location is primary signal.
  // If uni is unknown (Other), fall back to Languages section on their profile.
  const lang = (uniLoc === 'Ukraine' || uniLoc === 'Kropyvnytskyi') ? 'Ukrainian'
    : uniLoc === 'Russia' ? 'Russian'
    : hasUkrainian ? 'Ukrainian'
    : hasRussian   ? 'Russian'
    : 'English';

  // ── Profile overlap hints (regex — fast, no extra LLM call) ───────────────
  const profileText     = [profileAbout, currentJobDesc, title].filter(Boolean).join(' ');
  const currentRoleText = [currentJobDesc, title].filter(Boolean).join(' ');
  const hasGamedev  = /game|unity|unreal|gamedev/i.test(profileText);
  const hasIoT      = /iot|embedded|device|firmware|hardware/i.test(profileText);
  // Mobile/DevOps overlap only counts if it's their CURRENT role — mentioning
  // "I was also in mobile for 10 years" is odd if they moved to backend since.
  const hasMobile   = /mobile|android|ios|swift|kotlin/i.test(currentRoleText);
  const hasDevOps   = /devops|ci[\/ ]?cd|kubernetes|jenkins|pipeline|terraform/i.test(currentRoleText);

  // ── Customization hints (0-1 chosen by LLM) ───────────────────────────────
  const customizations = [
    titleMatch
      ? (lang === 'Ukrainian' ? `Посада контакта схожа з вакансією — встав "можливо навіть в твою команду" після назви ролі`
        : lang === 'Russian'  ? `Должность контакта совпадает — вставь "возможно даже в твою команду"`
        : `Their title matches the role — insert "possibly even your team" after mentioning the role`)
      : null,
    isUSCompany && (personLoc === 'Canada' || personLoc === 'Toronto' || personLoc === 'Ottawa')
      ? (lang === 'Ukrainian' ? `Компанія US, контакт в Канаді — додай "Бачу що ти з Канади працюєш на велику US компанію"`
        : lang === 'Russian'  ? `Компания в US, контакт в Канаде — добавь "вижу ты из Канады работаешь на большую US компанию"`
        : `US company with Canadian employee — add "I see you're in Canada working for a big US company"`)
      : null,
    personLoc === 'Toronto' && gender === 'male'
      ? (lang === 'Ukrainian' ? `Живе в GTA — запропонуй "буду радий навіть зустрітись на каву в даунтауні"`
        : lang === 'Russian'  ? `Живёт в GTA — предложи встретиться на кофе`
        : `Lives in Toronto/GTA — offer to meet for coffee downtown`)
      : null,
    personLoc === 'Ottawa'
      ? (lang === 'Ukrainian' ? `Живе в Оттаві — додай "в мене є друзі в Оттаві"`
        : lang === 'Russian'  ? `Живёт в Оттаве — упомяни "у меня есть знакомые в Оттаве"`
        : `Lives in Ottawa — mention "I have friends in Ottawa"`)
      : null,
    uniLoc === 'Kropyvnytskyi'
      ? (lang === 'Ukrainian' ? `Університет з Кропивницького — додай "якщо ти з Кропивницького, можливо чув про мене"`
        : `University from Kropyvnytskyi — mention they might have heard of you`)
      : null,
    isMedtech
      ? (lang === 'Ukrainian' ? `Медтех компанія — додай "давно хотів перейти назад з фінтеху в медтех"`
        : lang === 'Russian'  ? `Медтех компания — добавь "давно хотел вернуться из финтеха в медтех"`
        : `Medtech company — mention "I've been wanting to move back from fintech to medtech"`)
      : null,
    hasGamedev
      ? (lang === 'Ukrainian' ? `Є gamedev досвід — додай "я теж по фану пилю проект на Unreal"`
        : lang === 'Russian'  ? `Есть gamedev опыт — добавь "я тоже по фану пилю проект на Unreal"`
        : `Has gamedev experience — mention you also do gamedev as a hobby on Unreal`)
      : null,
    hasIoT
      ? (lang === 'Ukrainian' ? `Є IoT/embedded досвід — додай "я трохи займався IoT"`
        : lang === 'Russian'  ? `Есть IoT опыт — добавь "я немного занимался IoT"`
        : `Has IoT/embedded experience — mention you also dabbled in IoT`)
      : null,
    hasMobile
      ? (lang === 'Ukrainian' ? `Є мобайл досвід — додай "я 10+ років був в мобайлі"`
        : lang === 'Russian'  ? `Есть мобильный опыт — добавь "я 10+ лет был в мобайле"`
        : `Has mobile experience — mention you spent 10+ years in mobile`)
      : null,
    hasDevOps && !titleMatch
      ? (lang === 'Ukrainian' ? `Є DevOps/CI/CD скіли — додай "бачу багато спільного в скіллах"`
        : lang === 'Russian'  ? `Есть DevOps скиллы — добавь "вижу много общего в скиллах"`
        : `Has DevOps skills — mention you see many shared skills`)
      : null,
  ].filter(Boolean);

  const customizationBlock = customizations.length > 0
    ? `Pick at most ONE personalization from this list — this is the ONLY source of personalization, do not invent others from the About excerpt or elsewhere. Tech/interest overlaps (medtech, gamedev, IoT, mobile, DevOps, skills) are more important than location hints — prefer them when both apply. Shorten other parts to fit within 300 chars.\n${customizations.map(c => `- ${c}`).join('\n')}`
    : `No personalizations available — write the base message only. Do NOT invent a personalization from the About excerpt.`;

  const langInstruction = lang === 'Ukrainian'
    ? `Write in UKRAINIAN. Simple conversational Ukrainian. Abbreviations like "проф." are fine. Friendly/informal tone. Can be slightly dramatic.`
    : lang === 'Russian'
    ? `Write in RUSSIAN. Simple conversational Russian. Abbreviations like "проф." are fine.`
    : `Write in ENGLISH. Simple conversational English. More conservative tone.`;

  const result = await ask(`
Write a LinkedIn connection request message on behalf of Anton, a ${jobRole} engineer.
Anton sees an interesting ${jobRole} opening at ${companyName} and is looking for a referral.

Recipient: ${title || 'employee'} at ${companyName}
${university ? `Their university: ${university} (location: ${uniLoc})` : ''}
${location   ? `Their location: ${location} (classified: ${personLoc})` : ''}
${profileAbout ? `Their About (excerpt, for tone/language context ONLY — do NOT pull personalization facts from this, use only the Personalization list below): ${profileAbout.slice(0, 200)}` : ''}

${langInstruction}

Real message examples written by Anton — match this style exactly (vocabulary, tone, sentence length):
Ukrainian:
- "Привіт, я бачив вакансію DevOps в Канадський GlobalLogic. Допоможи пліз звʼязатись з місцевим рекрутером, або з керівником якщо знаєш хто наймає. Без референсу зараз навіть не відповідають. Буду радий проф. знайомству."
- "Привіт, я бачив у вас наймують DevOps-а. Можливо це навіть в твою команду. Конкуренція зараз велика. Рекрутери не відповідають. Шукаю інші шляхи презентувати себе наймаючому менеджеру. Хоча б щоб попасти на інтервʼю. Буду радий проф. знайомству."
- "Привіт, цікава ваша компанія, 20 людей працюють з Канади. Я сам цікавлюся трейдингом. Я знайшов цікаву відкриту позицію, але рекрутери часто не відповідають. Ти б міг мене зареферить? Хоча б щоб попасти на інтервʼю. Буду також радий проф. знайомству. Може навіть зустрітись на каву в даунтауні."
Russian:
- "Привет, интересна ваша компания. Увидел открытую вакансию DevOps, рекрутеры сейчас плохо отвечают. Ищу пути достучаться и попасть на интервью. Буду рад проф. знакомству. Я тоже занимался GameDev, по фану пилю проект на unreal."

Message structure (TARGET ~300 chars, HARD LIMIT 300 chars, adapt freely, stay natural):
1. Привіт / Hi / Привет  (NO name after greeting — saves space)
2. Ваша компанія наймає ${jobRole} / Your company is hiring ${jobRole}
4. Рекрутери зараз майже не відповідають / Recruiters often do not respond
5. Шукаю шляхи попасти на інтервʼю / Looking for ways to get to an interview
6. Буду радий проф. знайомству / Happy to connect professionally

${customizationBlock}

Rules:
- Target EXACTLY ~300 characters — expand base message if no personalization used, shorten if personalization is added
- NO name after "Привіт"/"Hi"/"Привет" — start directly with the company/role info
- Sound like a real human, NOT an AI template
- No emojis

Return only JSON: {"message": "..."}
  `.trim(), { strong: true, maxTokens: 350 });

  const message = result.message?.trim() || '';
  console.log(`[llm] Connect message (${lang}, uniLoc=${uniLoc}, personLoc=${personLoc}, titleMatch=${titleMatch}, ${message.length} chars): ${message}`);
  return message;
}
