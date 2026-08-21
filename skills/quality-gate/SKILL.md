---
name: quality-gate
description: Set up a ratchet-style quality gate where a PR may add code but may never regress any metric (coverage, duplication, lint, large files, vulnerabilities), plus an AI babysitting loop that drives the PR to green. Use when the user wants a quality gate, a metrics baseline, a ratchet/no-regression CI check, to stop coverage or duplication getting worse, or to babysit PRs to passing.
---

# Quality Gate

## Quick start

A ratchet: freeze the current metrics as a baseline, then block any PR that makes one worse.

1. **Baseline** — run `collect` on the current tree and commit the result as `baseline.json`.
2. **On every PR** — CI runs `collect` + `check` against `baseline.json`.
3. **Gate** — `check` exits `1` and posts a Markdown summary if any metric regressed; the merge is blocked.
4. **Ratchet** — on merge to main, `update` advances the baseline to any improved values, locking the gain.

Script + config: [scripts/quality-gate.mjs](scripts/quality-gate.mjs). Recipes, CI workflow, and the babysitting playbook: [REFERENCE.md](REFERENCE.md).

## The golden rule (ratchet)

**A PR can add code, but it can never make a metric worse — no exception, no justification.** A metric may only hold or improve. The gate tracks these, each with a fixed direction:

| Metric | Regresses when | Blocks merge? |
|---|---|---|
| Test coverage | drops | yes |
| Duplication (jscpd) | rises | yes |
| Lint violations | rises | yes |
| Large files (over line limit) | count rises | yes |
| Cyclomatic complexity (functions over limit) | count rises | yes |
| Circular dependencies | count rises | yes |
| Mutation score (killed mutants %) | drops | yes |
| Vulnerabilities (`npm audit`) | any `critical` | critical blocks, high warns |

A metric with no report is recorded as `null` — it never counts as an improvement, so you cannot game the ratchet by hiding a signal.

E2E and regression tests aren't metrics — they pass or fail. They run as separate required CI jobs, not in the baseline; see [REFERENCE.md](REFERENCE.md) §3b.

## Babysitting

After opening a PR, the agent drives it to green instead of waiting on a human: watch CI, read reviewer/gate comments, apply the fix, push, resolve the threads, repeat until the gate passes and checks are green. It never edits `baseline.json` to pass and never force-merges. Full `gh` playbook in [REFERENCE.md](REFERENCE.md).

## Setup

Copy [scripts/qualitygate.config.example.json](scripts/qualitygate.config.example.json) to `qualitygate.config.json`, point `reports.*` at the files your stack already produces (jest/jacoco coverage, eslint/checkstyle, npm audit), set `maxFileLines`, and turn metrics on/off in `metrics`. Per-stack collection commands are in [REFERENCE.md](REFERENCE.md).

**Lite or full.** Pick how much runs with `--preset`:

```bash
node quality-gate.mjs collect --preset=lite   # the five fundamentals
node quality-gate.mjs collect --preset=full   # everything (default)
```

`lite` = coverage, duplication, lint, large files, vulnerabilities — adoptable with no extra tooling. `full` adds complexity, dependencies, and mutation. Start lite on a legacy project and graduate; the `baseline.json` carries over. Mutation is **slow** (reruns the suite per mutant) and only meaningful once the test suite is solid — add it last. An explicit `metrics` list in the config always overrides the preset.
