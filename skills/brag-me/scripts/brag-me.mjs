#!/usr/bin/env node
// brag-me.mjs — collect verifiable contribution facts from git/gh for a brag doc.
// Zero dependencies, Node >= 18, ESM. It gathers EVIDENCE, not prose — the agent
// distills brag.md / resume.md from the facts.json this writes. It never invents
// numbers: a signal that isn't in git/gh is simply absent.
//
//   collect --author=<name|email> [--since=<YYYY-MM-DD>] [--repo=.] [--baseline=baseline.json]
//   --selftest
//
// Output: brag-facts.json

import { execFileSync } from "node:child_process";
import { writeFileSync as writeFile, existsSync } from "node:fs";

// --- pure helpers (unit-tested via --selftest) -------------------------------

// Conventional-commit prefix → bucket. Falls back to keyword sniffing, else "other".
export function classifyType(subject) {
  const m = /^(\w+)(\([^)]*\))?!?:/.exec(subject.trim());
  const prefix = m && m[1].toLowerCase();
  const known = { feat: "feature", fix: "bugfix", test: "tests", refactor: "refactor", perf: "performance", docs: "docs", chore: "chore", build: "chore", ci: "chore", style: "chore" };
  if (prefix && known[prefix]) return known[prefix];
  const s = subject.toLowerCase();
  if (/\bfix|bug|patch\b/.test(s)) return "bugfix";
  if (/\btest|coverage\b/.test(s)) return "tests";
  if (/\brefactor|modulariz|cleanup\b/.test(s)) return "refactor";
  if (/\bperf|latenc|optimi[sz]e|faster\b/.test(s)) return "performance";
  return "other";
}

// Sum `git log --numstat` lines: "added<TAB>deleted<TAB>path". "-" means binary.
export function aggregateNumstat(lines) {
  const files = new Set();
  let added = 0, deleted = 0;
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, d, path] = parts;
    if (a !== "-") added += Number(a) || 0;
    if (d !== "-") deleted += Number(d) || 0;
    files.add(path);
  }
  return { filesTouched: files.size, linesAdded: added, linesDeleted: deleted };
}

// From an ordered list of baseline snapshots [{date, metrics}], report first→last delta.
export function baselineDelta(snapshots) {
  if (!snapshots.length) return null;
  const first = snapshots[0], last = snapshots[snapshots.length - 1];
  const keys = new Set([...Object.keys(first.metrics || {}), ...Object.keys(last.metrics || {})]);
  const deltas = {};
  for (const k of keys) {
    const a = first.metrics?.[k], b = last.metrics?.[k];
    if (typeof a === "number" && typeof b === "number") deltas[k] = { from: a, to: b, change: Math.round((b - a) * 100) / 100 };
  }
  return { fromDate: first.date, toDate: last.date, deltas };
}

// --- git/gh wrappers ---------------------------------------------------------
function git(args, repo) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function collectCommits(author, since, repo) {
  const args = ["log", `--author=${author}`, "--pretty=%H%x1f%ad%x1f%s", "--date=short"];
  if (since) args.push(`--since=${since}`);
  const out = git(args, repo).trim();
  if (!out) return { total: 0, byType: {}, firstDate: null, lastDate: null };
  const rows = out.split("\n").map((l) => l.split("\x1f"));
  const byType = {};
  for (const [, , subject] of rows) {
    const t = classifyType(subject || "");
    byType[t] = (byType[t] || 0) + 1;
  }
  const dates = rows.map((r) => r[1]).sort();
  return { total: rows.length, byType, firstDate: dates[0], lastDate: dates[dates.length - 1] };
}

function collectDiff(author, since, repo) {
  const args = ["log", `--author=${author}`, "--numstat", "--pretty=tformat:"];
  if (since) args.push(`--since=${since}`);
  const lines = git(args, repo).split("\n").filter(Boolean);
  return aggregateNumstat(lines);
}

function collectPRs(author, repo) {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--author", author, "--state", "merged", "--limit", "200",
       "--json", "number,title,mergedAt,additions,deletions"],
      { cwd: repo, encoding: "utf8" },
    );
    const prs = JSON.parse(out);
    return { count: prs.length, prs: prs.map((p) => ({ number: p.number, title: p.title, mergedAt: p.mergedAt })) };
  } catch {
    return null; // no gh, not a github repo, or not authed → absent, never faked
  }
}

function collectBaselineHistory(baselinePath, repo) {
  if (!baselinePath || !existsSync(`${repo}/${baselinePath}`)) return null;
  let shas;
  try {
    shas = git(["log", "--format=%H%x1f%ad", "--date=short", "--", baselinePath], repo).trim().split("\n");
  } catch { return null; }
  if (!shas[0]) return null;
  const snapshots = [];
  for (const line of shas.reverse()) { // oldest → newest
    const [sha, date] = line.split("\x1f");
    try {
      const content = git(["show", `${sha}:${baselinePath}`], repo);
      snapshots.push({ date, metrics: JSON.parse(content).metrics || {} });
    } catch { /* skip commits where the file didn't parse */ }
  }
  return baselineDelta(snapshots);
}

// --- selftest ----------------------------------------------------------------
function selftest() {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

  assert(classifyType("feat(api): add users endpoint") === "feature", "feat → feature");
  assert(classifyType("fix: null guard") === "bugfix", "fix → bugfix");
  assert(classifyType("refactor!: split module") === "refactor", "refactor! → refactor");
  assert(classifyType("Improve latency of search") === "performance", "keyword → performance");
  assert(classifyType("random subject") === "other", "unknown → other");

  const agg = aggregateNumstat(["10\t2\tsrc/a.ts", "5\t0\tsrc/b.ts", "-\t-\timg.png"]);
  assert(agg.filesTouched === 3 && agg.linesAdded === 15 && agg.linesDeleted === 2, "numstat aggregation");

  const d = baselineDelta([
    { date: "2026-01-01", metrics: { coverage: 7, lint: 483 } },
    { date: "2026-06-01", metrics: { coverage: 22, lint: 400 } },
  ]);
  assert(d.deltas.coverage.change === 15 && d.deltas.lint.change === -83, "baseline delta first→last");
  assert(baselineDelta([]) === null, "empty snapshots → null");

  console.log("selftest OK");
}

// --- main --------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes("--selftest")) { selftest(); process.exit(0); }

const arg = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};

if (argv[0] !== "collect") {
  console.error("usage: brag-me.mjs collect --author=<name|email> [--since=YYYY-MM-DD] [--repo=.] [--baseline=baseline.json] | --selftest");
  process.exit(2);
}

const author = arg("author");
if (!author) { console.error("--author is required (your git name or email)"); process.exit(2); }
const repo = arg("repo", ".");
const since = arg("since");
const baseline = arg("baseline", "baseline.json");

const facts = {
  generatedAt: new Date().toISOString(),
  author, since: since || null, repo,
  commits: collectCommits(author, since, repo),
  diff: collectDiff(author, since, repo),
  pullRequests: collectPRs(author, repo),
  baselineTrend: collectBaselineHistory(baseline, repo),
};

const out = "brag-facts.json";
writeFile(out, JSON.stringify(facts, null, 2) + "\n");
console.log(`wrote ${out} — ${facts.commits.total} commits by ${author}`);
