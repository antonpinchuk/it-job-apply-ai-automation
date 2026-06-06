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
      try {
        return JSON.parse(raw);
      } catch {
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
 * Returns true if the name is likely Ukrainian or Russian origin.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function isUkrOrRusName(name) {
  if (!name?.trim()) return false;

  const result = await ask(`
Determine if the following person's name is of Ukrainian or Russian origin.
Name: "${name}"
Answer in JSON: {"origin": "ukrainian" | "russian" | "other", "confidence": "high" | "medium" | "low"}
Only JSON, no explanation.
  `.trim());

  const isMatch = result.origin === 'ukrainian' || result.origin === 'russian';
  console.log(`[llm] Name "${name}" -> ${result.origin} (${result.confidence})`);
  return isMatch;
}

/**
 * Returns true if any of the employer companies are Ukrainian or Russian.
 * Used because Apollo API does not return education data.
 * @param {string[]} employers - list of organization names from employment_history
 * @returns {Promise<boolean>}
 */
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
 * Returns true if the university is located in Ukraine or Russia.
 * @param {string} university
 * @returns {Promise<boolean>}
 */
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
