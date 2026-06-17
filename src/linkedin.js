/**
 * Scrapes data from an open LinkedIn profile page (person profile, not company).
 * Scrolls the page to trigger lazy-loaded sections before reading.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{location:string|null, about:string|null, university:string|null, currentJobDesc:string|null}|null>}
 */
export async function scrapeProfileData(page) {
  // Scroll gradually to trigger lazy-loaded Education / Experience sections,
  // stopping as soon as Education appears in the DOM.
  for (let i = 1; i <= 8; i++) {
    await page.evaluate(step => window.scrollTo(0, step * 600), i).catch(() => {});
    await page.waitForTimeout(300);
    const hasEdu = await page.evaluate(() =>
      [...document.querySelectorAll('section')].some(s =>
        /education/i.test(s.querySelector('h2')?.textContent?.trim() || '')
      ) || /\bEducation\b/.test(document.body.innerText)
    ).catch(() => false);
    if (hasEdu) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(200);

  const data = await page.evaluate(() => {
    const text = el => el?.textContent?.trim() || null;

    // ── Top card: the first section that contains the person's name heading ───
    // Location and university are both shown here in LinkedIn's current layout,
    // even when the full Education section isn't lazy-loaded yet.
    const topCard = (() => {
      for (const s of document.querySelectorAll('section')) {
        // Top card always has an h2 with the person's name AND a Connect/Message button
        if (s.querySelector('a[href*="messaging/compose"], a[href*="custom-invite"]')) return s;
      }
      return null;
    })();

    // ── Location ─────────────────────────────────────────────────────────────
    // LinkedIn shows location as plain text in the top card, e.g.
    // "Vancouver, British Columbia, Canada" or "Toronto, Ontario, Canada"
    // Match it from the full page text using a geo pattern.
    let location = null;
    const bodyText = document.body.innerText;
    // Pattern: "City, Province/State" or "City, Province, Country" on its own line
    const locMatch = bodyText.match(
      /[\n·]\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-\.]{2,40},\s*(?:British Columbia|Ontario|Alberta|Quebec|Manitoba|Saskatchewan|Nova Scotia|New Brunswick|Newfoundland|Northwest Territories|Yukon|Nunavut|California|New York|Texas|Washington|Illinois|Georgia|Florida|Massachusetts|Colorado|Oregon|Ohio|Michigan|Virginia|Pennsylvania|Arizona|Minnesota|Nevada|Utah|Tennessee|Indiana|Wisconsin|Connecticut|Maryland|Missouri|[A-Z]{2})[^.\n]{0,50})\s*[\n·]/
    );
    if (locMatch) location = locMatch[1].trim().split('\n').pop().trim();

    // ── University ────────────────────────────────────────────────────────────
    // Strategy 1: top card shows the most recent school as a plain span (no href).
    // It appears between the company link and the connections count.
    // We identify it by looking for known university keywords.
    let university = null;
    if (topCard) {
      const spans = [...topCard.querySelectorAll('span')].filter(s => s.children.length === 0);
      for (const s of spans) {
        const t = s.textContent.trim();
        if (t.length > 5 && t.length < 120 &&
            /university|institute|college|school|academy|polytechnic|університет|інститут|коледж|академія/i.test(t)) {
          university = t;
          break;
        }
      }
    }

    // Strategy 2: dedicated Education section (loaded on profiles with more content)
    if (!university) {
      for (const section of document.querySelectorAll('section')) {
        if (!/education/i.test(section.querySelector('h2')?.textContent?.trim() || '')) continue;
        const bold = section.querySelector('span.t-bold span[aria-hidden="true"]');
        if (bold) { university = text(bold); break; }
        const boldLi = section.querySelector('li span.t-bold');
        if (boldLi) { university = text(boldLi); break; }
        const schoolLink = section.querySelector('a[href*="/school/"]');
        if (schoolLink) { university = schoolLink.textContent.trim() || null; break; }
        const firstLi = section.querySelector('li');
        if (firstLi) {
          const heading = firstLi.querySelector('h3, strong, [class*="title"]');
          if (heading) { university = text(heading); break; }
        }
      }
    }

    // Strategy 3: body text — "Education" heading followed by institution name
    if (!university) {
      const bodyText = document.body.innerText;
      const eduMatch = bodyText.match(/\bEducation\b[\s\S]{0,20}?\n([\w\s''`\-–—,().]+(?:University|Institute|College|School|Academy|Polytechnic|Університет|Інститут)[^\n]{0,60})/i);
      if (eduMatch) university = eduMatch[1].trim();
    }

    // ── About section ─────────────────────────────────────────────────────────
    let about = null;
    for (const section of document.querySelectorAll('section')) {
      if (!/^about$/i.test(section.querySelector('h2')?.textContent?.trim() || '')) continue;
      const expandable = section.querySelector('[data-testid="expandable-text-box"], span[tabindex="-1"]');
      if (expandable) { about = expandable.textContent.trim() || null; break; }
      const p = section.querySelector('p');
      if (p) { about = p.textContent.trim() || null; break; }
    }

    // ── Experience — title and description from the most recent role ─────────
    let currentJobDesc = null;
    let currentCompanyTitle = null;
    for (const section of document.querySelectorAll('section')) {
      if (!/experience/i.test(section.querySelector('h2')?.textContent?.trim() || '')) continue;
      const firstLi = section.querySelector('li');
      if (firstLi) {
        // Job title: first bold/heading span in the list item
        const titleEl = firstLi.querySelector(
          'span.t-bold span[aria-hidden="true"], span[aria-hidden="true"], h3'
        );
        if (titleEl) currentCompanyTitle = titleEl.textContent.trim() || null;
        // Description
        const descEl = firstLi.querySelector(
          '[data-testid="expandable-text-box"], span[tabindex="-1"], .visually-hidden'
        );
        if (descEl) currentJobDesc = descEl.textContent.trim() || null;
      }
      break;
    }

    // Fallback: parse title from body text Experience block
    if (!currentCompanyTitle) {
      const expMatch = bodyText.match(/\bExperience\b[\s\S]{0,10}?\n([^\n]{5,80})\n/);
      if (expMatch) currentCompanyTitle = expMatch[1].trim();
    }

    // ── Languages ─────────────────────────────────────────────────────────────
    // Check if Ukrainian or Russian is listed in Languages section or body text
    let hasUkrainian = false;
    let hasRussian = false;
    const langSectionText = (() => {
      for (const section of document.querySelectorAll('section')) {
        if (/^languages?$/i.test(section.querySelector('h2')?.textContent?.trim() || ''))
          return section.innerText;
      }
      // Fallback: look for Languages block in body text
      const m = bodyText.match(/\bLanguages?\b([\s\S]{0,400}?)(?:\n\n[A-Z]|\nSkills|\nInterests|\nRecommendations|$)/i);
      return m ? m[1] : '';
    })();
    if (langSectionText) {
      hasUkrainian = /ukrainian|украї?нська/i.test(langSectionText);
      hasRussian   = /russian|русский|русська/i.test(langSectionText);
    }

    return { location, about, university, currentJobDesc, currentCompanyTitle, hasUkrainian, hasRussian };
  }).catch(() => null);

  console.log(`[linkedin] Scraped: university=${JSON.stringify(data?.university)} location=${JSON.stringify(data?.location)}`);
  return data;
}

/**
 * Clicks Connect on an open LinkedIn profile page and fills in the note textarea.
 *
 * Two cases:
 *   1. Connect is a direct link in the actions row (alongside Message + "...")
 *   2. Connect is inside the "..." (More) dropdown next to Message
 *
 * Flow: Connect → "Add a note" → fill textarea.
 * Does NOT send (does not click Send).
 *
 * @param {import('playwright').Page} page
 * @param {string} message
 * @returns {Promise<'filled'|'no_connect'|'no_dialog'|'no_textarea'>}
 */
export async function fillConnectNote(page, message) {
  // ── Step 1: click Connect ──────────────────────────────────────────────────
  const connectResult = await page.evaluate(() => {
    // Find the Message link to locate the profile actions container
    const messageLink = [...document.querySelectorAll('a')].find(a =>
      a.textContent.trim() === 'Message' && a.href?.includes('messaging/compose')
    );
    if (!messageLink) return 'no_message';

    // Walk up to the container that has the More ("...") button
    let container = messageLink.parentElement;
    for (let i = 0; i < 6; i++) {
      if (container?.querySelector('button[aria-label="More"]')) {
        // Case 1: Connect link is directly in this container
        const directConnect = container.querySelector('a[href*="custom-invite"]');
        if (directConnect) { directConnect.click(); return 'direct_clicked'; }

        // Case 2: Connect is hidden in the "..." dropdown — open it
        container.querySelector('button[aria-label="More"]').click();
        return 'dropdown_opened';
      }
      container = container?.parentElement;
      if (!container) break;
    }
    return 'no_container';
  });

  if (connectResult === 'no_message' || connectResult === 'no_container') return 'no_connect';

  if (connectResult === 'dropdown_opened') {
    // Wait for dropdown items, then click Connect
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);

    const connectInMenu = await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(el =>
        /^connect$/i.test(el.textContent.trim())
      );
      if (item) { item.click(); return true; }
      return false;
    });

    if (!connectInMenu) return 'no_connect';
  }

  // ── Step 2: wait for "Add a note" button and click it ─────────────────────
  try {
    await page.getByRole('button', { name: 'Add a note' }).waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    return 'no_dialog';
  }
  await page.getByRole('button', { name: 'Add a note' }).click();

  // ── Step 3: fill the textarea (it lives in a shadow DOM — div.theme--light) ─
  await page.waitForTimeout(400);

  const filled = await page.evaluate((msg) => {
    // The textarea is inside a shadow root
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
    return false;
  }, message);

  return filled ? 'filled' : 'no_textarea';
}
