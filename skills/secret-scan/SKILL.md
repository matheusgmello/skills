---
name: secret-scan
description: Scan a codebase and its git history for exposed secrets — API keys, tokens, private keys, passwords — and block them before they ship. Use when the user worries about a leaked key or credential, wants secret scanning, a pre-commit or CI secret check, or asks whether a secret is exposed in the repo or git history.
---

# Secret Scan

Finds committed secrets — the "exposed key" a pentest can't model as layers, because it's presence/absence, not depth. Pairs with [pentest-me](../pentest-me/SKILL.md): pentest-me attacks layers, this one hunts leaked credentials.

## Quick start

```bash
node scripts/secret-scan.mjs scan --root=.          # working tree (git-aware)
node scripts/secret-scan.mjs scan --root=. --git    # + full git history
node scripts/secret-scan.mjs --selftest
```

Writes `secret-scan.md` and exits `1` if anything is found — so it drops straight into CI as a pass/fail gate. Every match in the report is **redacted** (type + 4-char prefix only); the report never quotes a secret.

## What it catches

Named credentials (AWS keys, GitHub/Google/Slack/Stripe tokens, JWTs, PEM private keys) and generic `key/secret/token/password = "…"` assignments. High-signal patterns, not entropy guessing — see [REFERENCE.md](REFERENCE.md) for the full list and how to add your own.

## Two scopes

- **Working tree** (default) — only files that can reach git: tracked + untracked-but-not-`.gitignore`d. A correctly ignored `.env.local` is *not* exposed, so it's skipped.
- **Git history** (`--git`) — every commit. This matters because **a secret committed even once is compromised, even if a later commit removed it** — it still lives in history where anyone with the repo can read it.

## The rule when you find one

**A committed secret is burned. Removing it from the code is not enough — rotate/revoke the key**, then purge it from history (`git filter-repo` / BFG). Order matters: rotate first (assume it's already scraped), clean history second. Full remediation in [REFERENCE.md](REFERENCE.md).

## Limits

Named-pattern matching misses a bespoke secret with no recognizable shape, and a password in a test fixture is reported even when it's fake — allowlist those. It's a strong net, not proof of zero secrets.
