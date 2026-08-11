#!/usr/bin/env node
// secret-scan.mjs — find exposed secrets in the working tree and git history.
// Zero dependencies, Node >= 18, ESM. Named-pattern based (like gitleaks), high
// signal over entropy noise. Exits 1 when a non-allowlisted secret is found, so
// it works as a pass/fail CI gate.
//
//   scan  --root=.            scan the working tree
//   scan  --git              scan git history (all commits) too
//   --selftest
//
// The report REDACTS every match — it prints the type and a 4-char prefix, never
// the secret. A report that quoted secrets would itself be the leak.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

// --- patterns ----------------------------------------------------------------
// { type, re }. re must be global. High-signal named credentials first, then a
// generic assignment catch-all.
const PATTERNS = [
  { type: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
  { type: "github-token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { type: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { type: "slack-token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  { type: "stripe-secret-key", re: /sk_live_[0-9a-zA-Z]{24,}/g },
  { type: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { type: "jwt", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { type: "generic-secret-assignment", re: /(?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?token|client[_-]?secret)['"]?\s*[:=]\s*['"]([^'"]{8,})['"]/gi },
];

// Lines/values that are obviously placeholders, not real secrets.
const ALLOW_RE = /(example|sample|dummy|placeholder|changeme|your[_-]?|<[^>]+>|xxxx+|redacted|process\.env|import\.meta\.env|getenv|os\.environ|\$\{)/i;

// --- pure detection ----------------------------------------------------------
export function redact(match) {
  const head = match.slice(0, 4);
  return `${head}***redacted*** (${match.length} chars)`;
}

// Returns [{ type, redacted }] for one line. Allowlisted lines yield nothing.
export function detectSecrets(line, allow = ALLOW_RE) {
  if (allow.test(line)) return [];
  const hits = [];
  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      // for the generic assignment, the secret is group 1; else the whole match
      const secret = m[1] ?? m[0];
      hits.push({ type, redacted: redact(secret) });
    }
  }
  return hits;
}

// --- working-tree scan -------------------------------------------------------
const SKIP = ["node_modules", ".git", ".claude", "dist", "build", "target", "coverage", "__pycache__"];
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|jar|war|class|woff2?|ttf|eot|mp4|mov|lock)$/i;
// Template files hold placeholders by convention, not real secrets.
const TEMPLATE = /\.(example|sample|template|dist)$/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.includes(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (!BINARY.test(name) && !TEMPLATE.test(name)) out.push(full);
  }
  return out;
}

// In a git repo, scan only what can reach git: tracked + untracked files that
// aren't gitignored. A correctly-ignored .env.local isn't "exposed", so skip it.
// Outside a repo, walk everything.
function filesToScan(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").filter(Boolean).map((p) => join(root, p))
      .filter((f) => !BINARY.test(f) && !TEMPLATE.test(f) && existsSync(f));
  } catch {
    return walk(root);
  }
}

function scanTree(root) {
  if (!existsSync(root)) { console.error(`root does not exist: ${root}`); process.exit(2); }
  const findings = [];
  for (const file of filesToScan(root)) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    text.split("\n").forEach((line, idx) => {
      for (const hit of detectSecrets(line))
        findings.push({ ...hit, location: `${relative(root, file)}:${idx + 1}`, source: "tree" });
    });
  }
  return findings;
}

// --- git-history scan --------------------------------------------------------
// A secret committed once is compromised even if later removed — it lives in history.
function scanGit(root) {
  let out;
  try {
    out = execFileSync("git", ["-C", root, "log", "-p", "--all", "--no-color", "--unified=0"],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch { return []; }
  const findings = [];
  let sha = "?";
  for (const line of out.split("\n")) {
    const cm = /^commit ([0-9a-f]{40})/.exec(line);
    if (cm) { sha = cm[1].slice(0, 10); continue; }
    if (line[0] !== "+") continue; // only added lines
    for (const hit of detectSecrets(line.slice(1)))
      findings.push({ ...hit, location: `commit ${sha}`, source: "git" });
  }
  return findings;
}

// --- report ------------------------------------------------------------------
function report(findings) {
  let md = "# Secret scan\n\n";
  if (!findings.length) { md += "No secrets found.\n"; return md; }
  md += `**${findings.length} potential secret(s) found.** Every match below is redacted.\n\n`;
  md += "| Type | Where | Source | Match |\n|---|---|---|---|\n";
  for (const f of findings) md += `| ${f.type} | ${f.location} | ${f.source} | \`${f.redacted}\` |\n`;
  md += "\n> A secret in git history is **compromised** — removing it from the code is not enough. **Rotate/revoke the key**, then purge history (git filter-repo / BFG). See REFERENCE.md.\n";
  return md;
}

// --- selftest ----------------------------------------------------------------
function selftest() {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

  assert(detectSecrets("const k = 'AKIA1234567890ABCDEF';").some((h) => h.type === "aws-access-key"), "detect AWS key");
  assert(detectSecrets("-----BEGIN RSA PRIVATE KEY-----").some((h) => h.type === "private-key"), "detect private key header");
  assert(detectSecrets(`api_key = "s3cr3tvalue123"`).some((h) => h.type === "generic-secret-assignment"), "detect generic assignment");

  // allowlist: placeholders and env lookups must NOT flag
  assert(detectSecrets(`api_key = "your-api-key-here"`).length === 0, "placeholder is allowlisted");
  assert(detectSecrets(`token = process.env.TOKEN`).length === 0, "env lookup is not a secret");

  // redaction never reveals the secret
  const r = redact("AKIA1234567890ABCDEF");
  assert(r.startsWith("AKIA") && !r.includes("567890"), "redact shows prefix only, hides body");

  console.log("selftest OK");
}

// --- main --------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes("--selftest")) { selftest(); process.exit(0); }

const arg = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};

if (argv[0] !== "scan") {
  console.error("usage: secret-scan.mjs scan [--root=.] [--git] [--out=secret-scan.md] | --selftest");
  process.exit(2);
}

const root = arg("root", ".");
const out = arg("out", "secret-scan.md");
const findings = scanTree(root);
if (argv.includes("--git")) findings.push(...scanGit(root));
writeFileSync(out, report(findings));
console.log(`wrote ${out} — ${findings.length} potential secret(s)`);
if (findings.length) process.exit(1); // pass/fail gate
