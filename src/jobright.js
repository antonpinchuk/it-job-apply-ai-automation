import fs from 'fs';

const SESSION_FILE = '.session/jobright.json';
const API = 'https://api.jobright.ai/swan';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function getSessionId() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    return session.cookies?.find(c => c.name === 'SESSION_ID')?.value ?? null;
  } catch { return null; }
}

async function apiFetch(path, sessionId) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      'accept': '*/*',
      'cookie': `SESSION_ID=${sessionId}`,
      'user-agent': UA,
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'sec-fetch-storage-access': 'active',
    },
  });
  if (!res.ok) throw new Error(`Jobright ${res.status}: ${path}`);
  return res.json();
}

async function fetchBanner(jobId, sessionId) {
  const banner = await apiFetch(`/share/job/banner/${jobId}`, sessionId);
  const jobTitle = banner?.result?.jobResult?.jobTitle;
  const companyName = banner?.result?.companyResult?.companyName;
  const companyCategories = banner?.result?.companyResult?.companyCategories ?? null;
  if (!companyName || !jobTitle) {
    console.log('[jobright] Banner missing company/title, got:', JSON.stringify(banner?.result).slice(0, 200));
    return null;
  }
  console.log(`[jobright] "${companyName}" / "${jobTitle}" [${companyCategories}]`);
  return { companyName, jobTitle, jobId, companyCategories };
}

/**
 * Resolve job page URL → { companyName, jobTitle, jobId }
 * If URL contains ?jr_id=..., skips lookup and fetches banner directly.
 * Returns null if URL not found or session missing.
 */
export async function lookupJob(jobUrl) {
  const sessionId = getSessionId();
  if (!sessionId) {
    console.log('[jobright] No session — run: npm run auth -- --site jobright');
    return null;
  }

  try {
    // Fast path: jr_id already in URL — skip lookup
    const jrId = new URL(jobUrl).searchParams.get('jr_id');
    if (jrId) {
      console.log(`[jobright] jr_id in URL: ${jrId}`);
      return await fetchBanner(jrId, sessionId);
    }

    // Slow path: resolve URL → jobId via lookup
    const lookup = await apiFetch(`/autofill/lookup-by-url?url=${encodeURIComponent(jobUrl)}`, sessionId);
    const jobId = lookup?.result ?? lookup?.data?.id ?? lookup?.data?.jobId;
    if (!jobId) {
      console.log('[jobright] URL not in Jobright database');
      return null;
    }

    return await fetchBanner(jobId, sessionId);
  } catch (err) {
    console.warn(`[jobright] ${err.message}`);
    return null;
  }
}
