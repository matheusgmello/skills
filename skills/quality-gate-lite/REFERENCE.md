# Quality Gate (Lite) — Reference

The ratchet is stack-agnostic — the comparator only reads numbers. What differs per stack is **collection**: how you produce the reports the script reads. This lite skill covers the five fundamentals; for complexity, circular dependencies, and mutation score, use the full [quality-gate](../quality-gate/REFERENCE.md).

---

## 1. `baseline.json` schema

`collect` writes `metrics.json` in this shape; committing it makes it the `baseline.json`.

```json
{
  "updatedAt": "2026-08-11T00:00:00.000Z",
  "metrics": {
    "coverage": 7,
    "duplication": 2.2,
    "lint": 483,
    "largeFiles": 19,
    "security": { "critical": 0, "high": 0 }
  }
}
```

Directions are fixed in the script: `coverage` higher-is-better; `duplication`, `lint`, `largeFiles` lower-is-better; `security.critical` blocks, `security.high` warns. A metric set to `null` (no report found) is skipped — never a regression, never an improvement.

---

## 2. Collection per stack

The script collects `duplication` (jscpd) and `largeFiles` (line count) itself. For `coverage`, `lint`, and `security` it reads a report file set in `reports.*`. Generate those before `collect`.

### Node

```bash
# coverage → coverage/coverage-summary.json  (reports.coverage)
npx jest --coverage --coverageReporters=json-summary
# or vitest: npx vitest run --coverage  (coverage.reporter: ['json-summary'])

# lint → reports/eslint.json  (reports.lint)
npx eslint . -f json -o reports/eslint.json || true

# security → reports/npm-audit.json  (reports.audit)
npm audit --json > reports/npm-audit.json || true
```

### Java / Maven

```bash
# coverage → jacoco CSV  (reports.coverage: "target/site/jacoco/jacoco.csv")
mvn -B test jacoco:report

# lint → checkstyle XML  (reports.lint: "target/checkstyle-result.xml")
mvn -B checkstyle:checkstyle
```

`reports.coverage` takes a `.json` (jest) or `.csv` (jacoco); `reports.lint` a `.json` (eslint) or `.xml` (checkstyle) — auto-detected by extension. `security` is npm-audit-only; drop it from `metrics` on non-Node projects.

### Other stacks

The comparator is agnostic — produce a coverage number and lint count however your stack does and point `reports.*` at the output. `duplication` and `largeFiles` already work everywhere.

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

      - run: npm ci
      - run: npx jest --coverage --coverageReporters=json-summary
      - run: npx eslint . -f json -o reports/eslint.json || true
      - run: npm audit --json > reports/npm-audit.json || true

      - run: node quality-gate.mjs collect
      - run: node quality-gate.mjs check              # exit 1 blocks the PR

      - if: always()
        run: cat quality-gate-summary.md >> "$GITHUB_STEP_SUMMARY"

      - if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        run: |
          node quality-gate.mjs update
          git config user.name  github-actions
          git config user.email github-actions@github.com
          git commit -am "chore: advance quality-gate baseline" && git push
```

Add `quality-gate` to the branch's required status checks so the block is enforced.

---

## 4. Babysitting playbook

Loop until CI is green and the gate passes:

```bash
gh pr checks <pr>                         # wait for CI; see which checks fail
gh pr view <pr> --json comments,reviews   # read reviewer + gate feedback
git commit -am "fix: address gate/review" && git push
```

Resolve threads after fixing (GraphQL — REST can't resolve threads):

```bash
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<threadId>
```

**Stop rules:** never edit `baseline.json` to pass; never force-merge; if a metric genuinely must move the wrong way, stop and ask the human; if the fix loops ~3 rounds without converging, stop and report.

---

## 5. Script usage

```bash
node quality-gate.mjs collect   # → metrics.json
node quality-gate.mjs check     # compare vs baseline.json → summary + exit 1 on regression
node quality-gate.mjs update    # advance baseline.json to improved values
node quality-gate.mjs --selftest
node quality-gate.mjs check --config=path/to/qualitygate.config.json
```

`check` writes the Markdown summary to `summaryFile` (default `quality-gate-summary.md`). Config fields: `root`, `maxFileLines`, `metrics` (active list), `includeExt`, `exclude`, `reports.{coverage,lint,audit}`, `summaryFile`. The bundled script is the same engine as the full skill, so setting extra metrics in `metrics` works if you ever add the matching reports — but for complexity/dependencies/mutation, install [quality-gate](../quality-gate/SKILL.md) and follow its recipes.
