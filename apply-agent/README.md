# Non-code Job Application Automation

Automated job-site form filler via Claude Code + Chrome DevTools MCP.

## Quick start

1. Open a job application form in Chrome (already logged in)
2. Open Claude Code in this directory
3. Type in chat (no slash needed):
   ```
   apply "Anton Pinchuk - DevOps"
   ```
4. Claude fills the form. Review and click **Submit** yourself.

## How it works

- Claude reads your candidate profile .md file from `.memory/<name>.yaml`
- Detects which site the form is on (Workday, Greenhouse, etc.)
- **Known site** — uses cached selectors from `.memory/sites/<site>.yaml`, fills instantly
- **New site** — analyzes the form DOM, fills each field, asks you in chat for anything unknown, then saves selectors for next time
- Unknown answers get saved back to your YAML automatically
- Every application is logged in `.memory/applied/<name>.yaml` (duplicate check on each run)

## Adding a new candidate/resume

```
.memory/
  Jane Doe - Developer.pdf        ← original CV - to be uploaded while applying
  Jane Doe - Developer.md         ← candidate's CV here (converted, compact version for agent)
  Jane Doe - Developer.yaml       ← candidate details (see example file)
  applied/
    Jane Doe - Developer.yaml     ← candidate's application history
```

Then: `apply "Jane Doe - Developer"`

## Multi-page forms

Claude fills one page at a time. After each page it will say "Page filled — please click Next." You control the flow.

## File layout

```
.memory/
  <Candidate>.yaml        candidate profile + auto-learned fields
  <Candidate>.md          CV (uploaded to form if needed)
  sites/
    workday.yaml          cached selectors (auto-created)
    greenhouse.yaml
  applied/
    <Candidate>.yaml      applied jobs log
CLAUDE.md                 full instructions for Claude
```
