# Quality Gate — Reference

The ratchet method is stack-agnostic — the comparator only reads numbers. What differs per stack is **collection**: how you produce the coverage / lint / audit reports the script reads. Recipes below cover Node and Java/Maven; jscpd and large-file counting are built into the script and work on any language.

---

## 1. `baseline.json` schema

`collect` writes `metrics.json` in this shape; committing it (via `update` or by hand) makes it the `baseline.json`.

```json
{
  "updatedAt": "2026-07-31T00:00:00.000Z",
  "metrics": {
    "coverage": 7,
    "duplication": 2.2,
    "lint": 483,
    "largeFiles": 19,
    "complexity": 12,
    "dependencies": 3,
    "security": { "critical": 0, "high": 0 }
  }
}
```

Directions are fixed in the script, not the file: `coverage` higher-is-better; `duplication`, `lint`, `largeFiles`, `complexity`, `dependencies` lower-is-better; `security.critical` blocks, `security.high` warns. `complexity` is the count of functions over the cyclomatic limit; `dependencies` is the count of circular dependency cycles. A metric set to `null` (no report found) is skipped — never a regression, never an improvement.

---

## 2. Collection per stack

The script collects `duplication` (jscpd), `largeFiles` (line count), and `dependencies` (madge) itself. For `coverage`, `lint`, `complexity`, and `security` it reads a report file whose path you set in `reports.*`. Generate those reports before running `collect`.

`complexity` reuses the **lint report** — turn the cyclomatic rule on so violations land there. In eslint: `"complexity": ["warn", 10]` in your config (the script counts messages whose `ruleId` matches `complexityRule`, default `"complexity"`). In checkstyle: the `CyclomaticComplexity` module (the script counts `<error>` whose `source` mentions `Cyclomatic`).

`dependencies` runs `npx madge --circular --json <root>` and counts the cycles — JS/TS only; it degrades to `null` elsewhere.

### Node

```bash
# coverage → coverage/coverage-summary.json  (reports.coverage)
npx jest --coverage --coverageReporters=json-summary
# or vitest: npx vitest run --coverage  (coverage.reporter: ['json-summary'])

# lint (+ complexity) → reports/eslint.json  (reports.lint)
# enable "complexity": ["warn", 10] in eslint config so complexity violations are counted
npx eslint . -f json -o reports/eslint.json || true   # || true: don't abort collect on lint errors

# security → reports/npm-audit.json  (reports.audit)
npm audit --json > reports/npm-audit.json || true

# dependencies: collected automatically via `npx madge --circular` — no report file needed
```

### Java / Maven

```bash
# coverage → jacoco CSV  (reports.coverage: "target/site/jacoco/jacoco.csv")
mvn -B test jacoco:report

# lint (+ complexity) → checkstyle XML  (reports.lint: "target/checkstyle-result.xml")
# enable the CyclomaticComplexity module in checkstyle.xml so complexity is counted
mvn -B checkstyle:checkstyle
```

Point `reports.coverage` at a `.json` (jest summary) or `.csv` (jacoco); `reports.lint` at `.json` (eslint) or `.xml` (checkstyle). The script auto-detects by extension. `security` is npm-audit-only; drop `"security"` from `metrics` on non-Node projects.

### Other stacks (Python/Ruby/…)

The comparator is agnostic — only the recipe is missing. Produce a coverage number and a lint count however your stack does (e.g. `coverage json`, `rubocop --format json`) and point `reports.*` at the output. `duplication` and `largeFiles` already work everywhere.

---

## 3. CI workflow (GitHub Actions)

`.github/workflows/quality-gate.yml` — check on PRs, advance the ratchet on merge.

```yaml
name: quality-gate
on:
  pull_request:
  push:
    branches: [main]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }

      - run: npm ci                                   # deterministic install
      - run: npx jest --coverage --coverageReporters=json-summary
      - run: npx eslint . -f json -o reports/eslint.json || true
      - run: npm audit --json > reports/npm-audit.json || true

      - run: node quality-gate.mjs collect
      - run: node quality-gate.mjs check              # exit 1 blocks the PR

      - if: always()
        run: cat quality-gate-summary.md >> "$GITHUB_STEP_SUMMARY"

      # advance the ratchet only after merge to main
      - if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        run: |
          node quality-gate.mjs update
          git config user.name  github-actions
          git config user.email github-actions@github.com
          git commit -am "chore: advance quality-gate baseline" && git push
```

`check` on the PR compares against the committed `baseline.json`; `update` runs only on the main push so a PR can never advance the ratchet on its own. Add `quality-gate` to the branch's required status checks so the block is enforced.

---

## 4. Babysitting playbook

After opening the PR, drive it to green — this is the "babysitting" half. Loop until CI is green and the gate passes:

```bash
gh pr checks <pr>                         # wait for CI; see which checks fail
gh pr view <pr> --json comments,reviews   # read reviewer + gate feedback
# ... apply the fix in code, then:
git commit -am "fix: address gate/review" && git push
```

Resolve review threads after fixing (GraphQL — REST can't resolve threads):

```bash
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<threadId>
```

Get unresolved thread ids with `gh api graphql` on `pullRequest.reviewThreads`.

**Stop rules — never break these:**
- Never edit `baseline.json` to make the gate pass. Fix the code, not the bar.
- Never force-merge or bypass required checks.
- If a metric genuinely must move the wrong way (rare, architectural), stop and ask the human — do not decide it yourself.
- If the fix loops without converging (~3 rounds), stop and report what's stuck.

---

## 5. Script usage

```bash
node quality-gate.mjs collect   # → metrics.json (+ .jscpd/ report)
node quality-gate.mjs check     # compare vs baseline.json → summary + exit 1 on regression
node quality-gate.mjs update    # advance baseline.json to improved values
node quality-gate.mjs --selftest
node quality-gate.mjs check --config=path/to/qualitygate.config.json
```

`check` writes the Markdown summary to `summaryFile` (default `quality-gate-summary.md`) — feed it to `$GITHUB_STEP_SUMMARY` or read it as the agent. Config fields: `root`, `maxFileLines`, `complexityRule` (eslint rule id, default `complexity`), `metrics` (active list), `includeExt`, `exclude`, `reports.{coverage,lint,audit}`, `summaryFile`. `--selftest` runs inline asserts (regression blocks, ratchet advances, critical blocks / high warns) and needs no config.
