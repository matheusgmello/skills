# Secret Scan — Reference

Named-pattern secret detection (the gitleaks approach): high signal, low noise, no entropy guessing. The point is not to find *every* secret — it's to catch the common shapes before they reach git, and to prove whether a known key is in history.

---

## 1. Patterns detected

| Type | Shape |
|---|---|
| `aws-access-key` | `AKIA` + 16 upper-alphanumerics |
| `github-token` | `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` + 36+ chars |
| `google-api-key` | `AIza` + 35 chars |
| `slack-token` | `xoxb-`/`xoxa-`/`xoxp-`/`xoxr-`/`xoxs-` + token |
| `stripe-secret-key` | `sk_live_` + 24+ chars |
| `private-key` | `-----BEGIN … PRIVATE KEY-----` header |
| `jwt` | three base64url segments `eyJ….eyJ….…` |
| `generic-secret-assignment` | `key`/`secret`/`token`/`password`/`client_secret` `= "…"` (8+ chars) |

Add a pattern by extending `PATTERNS` in the script — `{ type, re }`, `re` global. For the generic assignment, the secret is capture group 1; for named ones it's the whole match.

---

## 2. Allowlisting — cutting false positives

Three layers already suppress noise:

- **Template files** — paths ending `.example`, `.sample`, `.template`, `.dist` are skipped (placeholders by convention).
- **Placeholder values** — lines matching `example`, `your-…`, `changeme`, `<...>`, `xxxx`, `dummy`, `sample`, `redacted` are ignored.
- **Env lookups** — `process.env`, `import.meta.env`, `getenv`, `os.environ`, `${…}` are not secrets (that's the *right* way to hold one).

Still noisy? A password in a **test fixture** (`application-test.yml`, `*.test.*`) is reported because a real secret can hide there too — verify it's fake, then add its path/value to the allowlist regex (`ALLOW_RE`) or exclude the file. Never blanket-ignore whole `test/` trees; that's where leaked staging creds love to hide.

---

## 3. Two scopes, and why history matters

```bash
node secret-scan.mjs scan --root=.          # working tree, git-aware
node secret-scan.mjs scan --root=. --git    # + git history (all commits)
```

**Working tree** uses `git ls-files --cached --others --exclude-standard` inside a repo — it scans tracked files plus untracked ones that aren't `.gitignore`d. A gitignored `.env.local` is skipped: it can't reach git, so it isn't "exposed". Outside a git repo it walks the tree.

**History** (`--git`) reads every added line across all commits. Run it at least once per repo: a key committed in March and "removed" in April is still sitting in the March commit. `git log -p` sees it; so does anyone who clones.

---

## 4. Remediation — the order is the whole point

When a secret is found in tracked code or history:

1. **Rotate/revoke the key first.** Assume it's already scraped — bots watch public pushes within seconds. A key removed from history but not rotated is still a live key someone copied.
2. **Then purge history** so it stops leaking to new clones:
   ```bash
   git filter-repo --path path/to/file --invert-paths     # or replace the string
   # or BFG: java -jar bfg.jar --replace-text secrets.txt
   git push --force-with-lease --all
   ```
3. **Prevent recurrence** — move the value to an env var / secrets manager, add the file to `.gitignore`, and wire this scan into pre-commit + CI (§5).

Rotating without cleaning history leaks a dead key (low harm); cleaning history without rotating leaves a live key in the wild (high harm). Always rotate first.

---

## 5. CI / pre-commit integration

The scan exits `1` on any finding, so it's a drop-in pass/fail gate.

```yaml
# .github/workflows/secret-scan.yml
name: secret-scan
on: [pull_request]
jobs:
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # full history for --git
      - run: node secret-scan.mjs scan --root=. --git
      - if: always()
        run: cat secret-scan.md >> "$GITHUB_STEP_SUMMARY"
```

Add `secret-scan` to the branch's required checks. As a pre-commit hook, run the working-tree scan (fast) and leave the `--git` history sweep for CI (slower). Like e2e/regression in the quality-gate, this is a **pass/fail check, not a ratcheted metric** — there's no acceptable non-zero count of exposed secrets.
