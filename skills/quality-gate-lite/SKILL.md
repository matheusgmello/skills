---
name: quality-gate-lite
description: Set up a ratchet quality gate with the five fundamental metrics — a PR may add code but may never regress coverage, duplication, lint, large files, or vulnerabilities. Use when the user wants a simple no-regression CI gate without the heavier metrics (complexity, dependencies, mutation) of the full quality-gate.
---

# Quality Gate (Lite)

The five-metric starter. Same ratchet engine as [quality-gate](../quality-gate/SKILL.md), trimmed to the fundamentals so a project can adopt the gate without wiring up complexity, dependency, or mutation tooling. Graduate to the full skill when ready — the config is forward-compatible.

## Quick start

Freeze the current metrics as a baseline, then block any PR that makes one worse.

1. **Baseline** — run [scripts/quality-gate.mjs](scripts/quality-gate.mjs) `collect` on the current tree; commit the result as `baseline.json`.
2. **On every PR** — CI runs `collect` + `check` against `baseline.json`.
3. **Gate** — `check` exits `1` and posts a Markdown summary if any metric regressed; the merge is blocked.
4. **Ratchet** — on merge to main, `update` advances the baseline to any improved values.

## The golden rule (ratchet)

**A PR can add code, but it can never make a metric worse — no exception, no justification.** The five metrics, each with a fixed direction:

| Metric | Regresses when | Blocks merge? |
|---|---|---|
| Test coverage | drops | yes |
| Duplication (jscpd) | rises | yes |
| Lint violations | rises | yes |
| Large files (over line limit) | count rises | yes |
| Vulnerabilities (`npm audit`) | any `critical` | critical blocks, high warns |

A metric with no report is recorded as `null` — never counts as an improvement, so the ratchet can't be gamed by hiding a signal.

## Babysitting

After opening a PR, the agent drives it to green: watch CI, read gate/reviewer comments, apply the fix, push, resolve threads, repeat until the gate passes. It never edits `baseline.json` to pass and never force-merges. Full `gh` playbook in [REFERENCE.md](REFERENCE.md).

## Setup

Copy [scripts/qualitygate.config.example.json](scripts/qualitygate.config.example.json) to `qualitygate.config.json`, point `reports.*` at the files your stack produces (jest/jacoco coverage, eslint/checkstyle, npm audit), set `maxFileLines`. Collection recipes and the CI workflow are in [REFERENCE.md](REFERENCE.md).

**Upgrading to full.** The [quality-gate](../quality-gate/SKILL.md) skill is the same engine plus `complexity`, `dependencies`, and `mutation`. Switch by installing it and adding those to `metrics` — your `baseline.json` carries over.
