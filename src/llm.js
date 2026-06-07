import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview' },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_KEY },
});

let _pauseUntil = 0;

async function ask(prompt) {
  for (;;) {
    const wait = _pauseUntil - Date.now();
    if (wait > 0) {
      console.warn(`[llm] Rate limited — waiting ${Math.ceil(wait / 1000)}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
    try {
      const response = await client.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 100,
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
 *   roleConfidence: 'high'|'medium'|'low'
 * }}
 */
export async function classifyPerson(name, title, role) {
  if (!name?.trim()) {
    return { isUkrOrRus: false, nameConfidence: 'low', roleMatch: false, roleConfidence: 'low' };
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
  "roleConfidence": "high" | "medium" | "low"
}

nameOrigin: Is the name of Ukrainian or Russian origin?
roleMatch: Does their title suggest they work in ${role} or a closely related area (same technical domain)?
Only JSON, no explanation.
  `.trim());

  const isUkrOrRus = result.nameOrigin === 'ukrainian' || result.nameOrigin === 'russian';
  const nameConfidence = result.nameConfidence || 'low';
  const roleMatch = result.roleMatch === true;
  const roleConfidence = result.roleConfidence || 'low';
  console.log(`[llm] "${name}" (${title || '?'}) → origin=${result.nameOrigin}(${nameConfidence}) role=${roleMatch}(${roleConfidence})`);
  return { isUkrOrRus, nameConfidence, roleMatch, roleConfidence };
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
 * @param {string} categories  e.g. "Consumer Goods,Gaming,Video Games"
 * @param {string[]} examples  existing domain values from config.js
 * @returns {Promise<string>}
 */
export async function generateDomainLabel(categories, examples) {
  const result = await ask(`
Classify this company into a 1-word industry domain label.

Company categories from Jobright: "${categories}"

Examples of labels from previous applications (match this style):
${examples.join(', ')}

Rules:
- Exactly 1 word (or short phrase if truly necessary, e.g. "HR tech")
- Prefer reusing an existing example if it fits well
- Otherwise create a new label in the same style

Return only JSON: {"label": "..."}
  `.trim());
  const label = result.label?.trim() || categories.split(',')[0].trim().toLowerCase();
  console.log(`[llm] Domain label: "${label}" (from: "${categories}")`);
  return label;
}

export async function isUkrOrRusUniversity(university) {
  if (!university?.trim()) return false;
  const result = await ask(`
Determine if the following university or educational institution is located in Ukraine or Russia.
University: "${university}"
Answer in JSON: {"country": "ukraine" | "russia" | "other", "confidence": "high" | "medium" | "low"}
Only JSON, no explanation.
  `.trim());
  const isMatch = result.country === 'ukraine' || result.country === 'russia';
  console.log(`[llm] University "${university}" -> ${result.country} (${result.confidence})`);
  return isMatch;
}
