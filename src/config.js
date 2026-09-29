/**
 * Stack label examples extracted from existing applications in the Google Sheet.
 * Used as few-shot examples in the LLM prompt for generateStackLabel().
 * Add new values here as the sheet grows.
 */
export const ROLE_OPTIONS = ['Lead', 'Architect', 'Developer', 'DevOps', 'MLOps', 'Director'];

/**
 * Unified job title used in the LinkedIn outreach message ("your company is
 * hiring a ${outreachTitle}"). Deliberately separate from ROLE_OPTIONS (which
 * is a coarse category for the Sheets row) — this needs to actually read like
 * a real job title to the recipient.
 */
export const OUTREACH_TITLE_OPTIONS = [
  'Backend Developer', 'AI Developer', 'Lead Developer', 'ML Engineer', 'DevOps',
  'Data Engineer', 'QA Engineer', 'Security Engineer',
];

export const DOMAIN_EXAMPLES = [
  'fintech', 'healthcare', 'AI', 'gaming', 'SaaS', 'enterprise', 'ecommerce',
  'media', 'telecom', 'cloud', 'cybersecurity', 'edtech', 'logistics', 'real estate',
  'consulting', 'IoT', 'energy', 'government',
  'automotive', 'marketing', 'recruitment', 'vendor', 'tools', 'opensource',
  'games', 'apps', 'social media',
];

export const STACK_EXAMPLES = [
  'Cloud DevOps', 'AI', 'Backend Telemetry', 'DevOps', 'Platform', 'SRE', 'AWS',
  'ML', 'AI/ML', 'Platform, ML', 'Backend', 'Infrastructure', 'AI Platform',
  'Legacy Migration', 'JS full-stack', 'SRE, AI', 'AI hardware', 'Improve SDLC',
  'PHP', 'Reverse Engineering', 'SAP', 'Java', 'Big Data', 'SRE, Streaming',
  'AIops', 'ML, Data', 'Cloud, AI', 'Node', 'RoR', 'Architect',
];
