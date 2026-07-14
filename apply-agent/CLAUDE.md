# Job Application Automation

## Command: apply

**Trigger:** when the user types `apply "Candidate Name - Role"` (no slash needed), execute the following workflow.

### Step 1 — Duplicate check

Read `.memory/applied/<candidate>.yaml`.
If the current page URL already appears in the `applied` list — warn the user and stop.

### Step 2 — Load candidate profile

- Candidate YAML: `.memory/<candidate>.yaml` (e.g. `.memory/Anton Pinchuk - DevOps.yaml`)
- CV PDF: `.memory/<candidate>.pdf` — use only if a field is not answerable from the YAML.

### Step 3 — Record application immediately

**Before filling anything**, append to `.memory/applied/<candidate>.yaml`:
```yaml
- url: <full page URL>
  company: <company name>
  title: <job title if visible>
  date: <today's date YYYY-MM-DD>
```
This ensures the record exists even if filling fails or is interrupted.

### Step 4 — Detect site

1. ToolSearch: `select:mcp__claude-in-chrome__tabs_context_mcp`
2. Call `tabs_context_mcp` to get the active tab URL.

Extract hostname key (e.g. `wd3.myworkdayjobs.com` → `workday`, `job-boards.greenhouse.io` → `greenhouse`).

Check if `.memory/sites/<key>.yaml` exists:
- **Yes** → Step 6 (known site)
- **No** → Step 5 (new site)

### Step 5 — New site: analyze and fill

1. ToolSearch + call `read_page` with `filter: "interactive"` to get form fields.
2. Fill all fields in **one or two batch JS calls** (see Filling rules below).
3. Save selector/field mappings to `.memory/sites/<key>.yaml`.

### Step 6 — Known site: fill from cache

Read `.memory/sites/<key>.yaml`. Fill all fields using the cached selectors in batch.
If a selector fails → fall back to `read_page` for that field only, then update cache.

### Step 7 — Hand off to user

Tell the user: "Form filled. Please review and click Submit."

---

## Filling rules (speed & token efficiency)

### 1. DOM only — no screenshots
- **Never** use `mcp__claude-in-chrome__computer` unless a dropdown/button cannot be triggered any other way.
- **Never** take screenshots proactively. Only take one if JS interaction fails after 2 attempts.

### 2. Skip optional fields
- Only fill fields marked required (`*` in label, or `required` attribute).
- Skip: Website, Preferred Name, Cover Letter (unless explicitly in the site cache as required).

### 3. Batch-fill text inputs in one JS call
Instead of multiple `form_input` calls, use a single `javascript_tool` call:
```javascript
const fill = (sel, val) => {
  const el = document.querySelector(sel);
  if (!el) return;
  const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  nativeInput.set.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
fill('input[name="first_name"]', 'Anton');
fill('input[name="last_name"]', 'Pinchuk');
fill('input[type="email"]', 'antony.pinchuk@gmail.com');
// etc.
```
This fires React/Vue synthetic events and commits values properly.

### 4. Dropdowns via JS click — no mouse
Open custom dropdowns by calling `.click()` on the trigger element, then click the option after a `setTimeout`:
```javascript
const btn = document.querySelector('button[aria-label="Which country"]');
btn.click();
setTimeout(() => {
  const opt = Array.from(document.querySelectorAll('[role="option"], li')).find(o => o.textContent.trim() === 'Canada');
  if (opt) opt.click();
}, 400);
```
Only fall back to `computer` tool mouse clicks if JS `.click()` fails.

### 5. Read page once — act immediately
- Call `read_page` once with `filter: "interactive"` to get refs.
- Fill everything from that single read. Do not re-read unless a field is missing.
- Use `read_console_messages` (with a specific pattern) to debug JS errors instead of re-reading the page.

### 6. Unknown fields
If a field label is not in the candidate YAML and not answerable from context, ask the user once (batching all unknown fields together):
```
Fields not found in memory:
- "Field label 1" — what should I enter?
- "Field label 2" — what should I enter?
```
After user answers → fill AND append to candidate YAML.

---

## Browser tools reference (claude-in-chrome)

Always load each tool via ToolSearch before calling it:

| Task | ToolSearch query | Tool |
|------|-----------------|------|
| Get active tab / URL | `select:mcp__claude-in-chrome__tabs_context_mcp` | `tabs_context_mcp` |
| Read page DOM | `select:mcp__claude-in-chrome__read_page` | `read_page` |
| Fill text input | `select:mcp__claude-in-chrome__form_input` | `form_input` |
| Batch JS / dropdowns | `select:mcp__claude-in-chrome__javascript_tool` | `javascript_tool` |
| Debug console | `select:mcp__claude-in-chrome__read_console_messages` | `read_console_messages` |
| Mouse click (last resort) | `select:mcp__claude-in-chrome__computer` | `computer` |

---

## Site selector cache format

`.memory/sites/<key>.yaml`:
```yaml
# Site: <hostname>
# Last updated: <date>
fields:
  - label: "First Name"
    selector: "input[name='firstName']"
    fill_method: form_input   # form_input | javascript_tool | js_click
    candidate_key: personal.first_name
```

---

## File layout

```
.memory/
  Anton Pinchuk - DevOps.yaml     # candidate profile
  Anton Pinchuk - DevOps.pdf      # CV file
  sites/
    workday.yaml
    greenhouse.yaml
    sapsf.yaml
    ...
  applied/
    Anton Pinchuk - DevOps.yaml   # log of applied jobs
```

---

## Adding a new candidate

1. Drop their CV PDF into `.memory/`
2. Copy `.memory/Anton Pinchuk - DevOps.yaml` → new candidate YAML and fill in details
3. Create `.memory/applied/<Name>.yaml` with `applied: []`
4. Run: `apply "Name - Role.pdf"`

## Account login / registration flow

When a site requires an account before filling the form:

1. **Try login first** — look for a login button in the form itself or in the page header. Use `account.email` + `account.password` from the candidate YAML.
2. **If login fails** — attempt to create a new account with the same credentials.
   - If registration requires an email confirmation code — stop and tell the user: "Registration requires email confirmation. Please verify and re-run apply."
   - (Future: Gmail MCP will handle this automatically.)
3. **If registration fails** — stop and report the error to the user. Do not proceed.

---

## Rules

- Always use `mcp__claude-in-chrome__*` tools — the tab is already open and authenticated.
- Always load tools via ToolSearch before calling them.
- **Never click Submit** — leave that to the user.
- Multi-step forms: fill one step at a time, tell user "Page filled — please click Next."
- Prefer batch JS over multiple individual tool calls.
- No screenshots unless JS interaction fails twice.
