# Brag Me — Reference

The script produces evidence; this file is how you turn it into honest bullets. The rule under everything: a resume bullet a candidate can't defend in an interview is worse than no bullet. Every number here is traceable or labeled self-reported.

Inspired by Julia Evans' "brag document" idea ([jvns.ca/blog/brag-documents](https://jvns.ca/blog/brag-documents/)); the git/gh/baseline automation is this repo's part.

---

## 1. `brag-facts.json` shape

```json
{
  "author": "you@example.com",
  "since": "2025-01-01",
  "commits": { "total": 214, "byType": { "feature": 90, "bugfix": 61, "tests": 24, "refactor": 18, "performance": 7, "other": 14 }, "firstDate": "2025-01-06", "lastDate": "2025-11-20" },
  "diff": { "filesTouched": 340, "linesAdded": 21877, "linesDeleted": 9002 },
  "pullRequests": { "count": 88, "prs": [{ "number": 412, "title": "Add idempotent webhook retries", "mergedAt": "2025-06-02" }] },
  "baselineTrend": { "fromDate": "2025-01-06", "toDate": "2025-11-20", "deltas": { "coverage": { "from": 7, "to": 42, "change": 35 }, "duplication": { "from": 4.1, "to": 1.3, "change": -2.8 } } }
}
```

`null` fields mean the source was unavailable (no `gh`, no committed `baseline.json`) — treat as absent, never guess.

---

## 2. Turning facts into bullets (XYZ)

Google's formula: **"Accomplished X, measured by Y, by doing Z."** Lead with impact, back it with a number, name the method.

| Fact in json | Weak bullet | Strong bullet (XYZ) |
|---|---|---|
| `byType.feature: 90`, PR titles | "Implemented features" | "Shipped 90+ features incl. idempotent webhook retries (PR #412), cutting duplicate charges" |
| `baselineTrend.coverage 7→42` | "Improved testing" | "Raised test coverage from 7% to 42% by adding integration tests to untested payment paths" |
| `baselineTrend.duplication 4.1→1.3` | "Refactored code" | "Cut code duplication 4.1%→1.3% by extracting shared modules across services" |
| `byType.bugfix: 61` | "Fixed bugs" | "Resolved 61 production bugs, incl. a race condition double-charging users at checkout" |

Rules while distilling:
- A count (`90 features`, `61 bugfixes`) is measured — safe to state.
- A **metric delta** (`coverage 7→42`) is the strongest evidence — always prefer it over adjectives.
- The *specific* example in a bullet (which feature, which bug) comes from PR titles / commit subjects, not imagination.
- If two facts describe the same work, merge them; don't pad the count.

---

## 3. Interview — what git can't see

Ask only for impact the evidence lacks, and label answers self-reported:

- **Business outcome** — did a feature move a number (revenue, signups, churn, support tickets)?
- **Scale** — requests/day, users, data size, team size you coordinated.
- **Performance** — before/after latency, cost, build time (git rarely records these).
- **Ownership** — did you lead, design, mentor, or set direction vs. implement to spec?
- **Stack** — languages/frameworks worth naming for keyword matching.

Never convert a self-reported guess into a hard number in `resume.md`. "~30% fewer support tickets (self-reported)" is honest; "reduced tickets 30%" as if measured is not.

---

## 4. Sanitization

`resume.md` is generic by default. Replace before writing, and list what you changed so the user can selectively restore:

| Real | Generic |
|---|---|
| Employer / client / product name | "a fintech", "a payments gateway", "an internal admin tool" |
| Teammate names, internal service names | role or function ("the billing service") |
| Proprietary metrics, revenue figures | keep only if the user confirms they're shareable |
| Repo URLs, ticket ids, hostnames | drop |

`brag.md` (private memory) may keep real names and links — it's not for distribution.

---

## 5. Templates

**`brag.md`** (private — evidence attached):
```md
# Brag — <Project> (<firstDate>–<lastDate>)

## Features
- Idempotent webhook retries — PR #412, commits abc123, def456

## Testing
- Coverage 7% → 42% — baseline.json trend 2025-01→2025-11

## Bugs
- Fixed checkout double-charge race — PR #380

## Performance / Scale (self-reported)
- p95 checkout 800ms → 210ms — from load test, not in git
```

**`resume.md`** (distilled, sanitized, XYZ):
```md
## Software Engineer — a fintech (2025)
- Raised test coverage 7%→42% by adding integration tests to untested payment paths
- Shipped idempotent webhook retries, eliminating duplicate charges at scale
- Cut code duplication 4.1%→1.3% by extracting shared service modules
- Resolved 61 production bugs incl. a checkout race condition double-charging users
```

---

## 6. Script usage

```bash
node brag-me.mjs collect --author="you@example.com"            # current repo
node brag-me.mjs collect --author="Your Name" --since=2025-01-01 --repo=../app --baseline=baseline.json
node brag-me.mjs --selftest
```

Flags: `--author` (required — git name or email), `--since` (YYYY-MM-DD), `--repo` (default `.`), `--baseline` (path to a committed `baseline.json`, default `baseline.json`). Writes `brag-facts.json`. `pullRequests` needs `gh` authed on a GitHub repo; `baselineTrend` needs a `baseline.json` with history (produced by the [quality-gate](../quality-gate/SKILL.md) skill). Both degrade to `null` when absent.
