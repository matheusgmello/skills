#!/usr/bin/env node
// quality-gate.mjs — ratchet quality gate. Zero dependencies, Node >= 18, ESM.
//
// A PR may add code but must never regress a metric. Metric may only hold or
// improve; when it improves, `update` advances the ratchet and locks the gain.
//
//   collect   build metrics.json from the current tree + tool reports
//   check     compare metrics.json against baseline.json; exit 1 on any regression
//   update    rewrite baseline.json with the improved values (run on merge to main)
//   --selftest run inline asserts and exit
//
// Config: qualitygate.config.json (see qualitygate.config.example.json).

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

// --- metric directions -------------------------------------------------------
// higher_is_better: regresses when it DROPS. otherwise: regresses when it RISES.
// `security` is special-cased (critical blocks, high warns).
const DIRECTION = {
  coverage: "higher_is_better",
  duplication: "lower_is_better",
  lint: "lower_is_better",
  largeFiles: "lower_is_better",
  complexity: "lower_is_better",   // functions over the cyclomatic limit
  dependencies: "lower_is_better", // circular dependency count
  mutation: "higher_is_better",    // mutation score % (killed mutants)
};

// --- helpers -----------------------------------------------------------------
const readJSON = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJSON = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
const round = (n) => Math.round(n * 100) / 100;

function loadConfig(path = "qualitygate.config.json") {
  if (!existsSync(path)) {
    console.error(`config not found: ${path} (see qualitygate.config.example.json)`);
    process.exit(2);
  }
  return readJSON(path);
}

// Count files whose line count exceeds cfg.maxFileLines, honoring include/exclude globs.
function countLargeFiles(cfg) {
  const root = cfg.root || ".";
  const max = cfg.maxFileLines || 300;
  const exclude = (cfg.exclude || ["node_modules", ".git", "dist", "build", "target", "coverage"]);
  const include = cfg.includeExt || [".js", ".jsx", ".ts", ".tsx", ".java", ".py", ".rb"];
  if (!existsSync(root)) {
    console.error(`config.root does not exist: ${root}`);
    process.exit(2);
  }
  let count = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (exclude.includes(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (include.some((e) => name.endsWith(e))) {
        const lines = readFileSync(full, "utf8").split("\n").length;
        if (lines > max) count++;
      }
    }
  };
  walk(root);
  return count;
}

// Run jscpd and read its json report for the duplication percentage.
function collectDuplication(cfg) {
  const root = cfg.root || ".";
  try {
    execFileSync(
      "npx",
      ["--yes", "jscpd", root, "--silent", "--reporters", "json", "--output", ".jscpd"],
      { stdio: "ignore" },
    );
    const rep = readJSON(join(".jscpd", "jscpd-report.json"));
    return round(rep.statistics.total.percentage);
  } catch {
    return null; // jscpd unavailable → metric absent, never counts as improvement
  }
}

// coverage: jest json-summary (total.lines.pct) or a jacoco CSV path.
function collectCoverage(cfg) {
  const p = cfg.reports?.coverage;
  if (!p || !existsSync(p)) return null;
  if (p.endsWith(".json")) {
    const j = readJSON(p);
    return round(j.total?.lines?.pct ?? j.total?.statements?.pct ?? null);
  }
  if (p.endsWith(".csv")) {
    // jacoco CSV: sum INSTRUCTION_MISSED / INSTRUCTION_COVERED across rows.
    const rows = readFileSync(p, "utf8").trim().split("\n").slice(1);
    let missed = 0, covered = 0;
    for (const r of rows) {
      const c = r.split(",");
      missed += Number(c[3]) || 0;
      covered += Number(c[4]) || 0;
    }
    const total = missed + covered;
    return total ? round((covered / total) * 100) : null;
  }
  return null;
}

// lint: eslint json (count messages) or checkstyle xml (count <error> tags).
function collectLint(cfg) {
  const p = cfg.reports?.lint;
  if (!p || !existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  if (p.endsWith(".json")) {
    const results = JSON.parse(raw);
    return results.reduce((n, f) => n + (f.messages?.length || 0), 0);
  }
  if (p.endsWith(".xml")) {
    return (raw.match(/<error\b/g) || []).length;
  }
  return null;
}

// complexity: count violations of the cyclomatic-complexity rule in the lint report.
// Pure so --selftest can exercise it. eslint json: messages with ruleId === rule.
// checkstyle xml: <error> whose source mentions "Cyclomatic".
export function countComplexity(raw, ext, rule = "complexity") {
  if (ext === ".json") {
    const results = JSON.parse(raw);
    return results.reduce(
      (n, f) => n + (f.messages?.filter((m) => m.ruleId === rule).length || 0),
      0,
    );
  }
  if (ext === ".xml") {
    return (raw.match(/<error\b[^>]*\bsource="[^"]*Cyclomatic[^"]*"/g) || []).length;
  }
  return null;
}

function collectComplexity(cfg) {
  const p = cfg.reports?.lint; // reuse the lint report (eslint `complexity` / checkstyle CyclomaticComplexity)
  if (!p || !existsSync(p)) return null;
  const ext = p.endsWith(".json") ? ".json" : p.endsWith(".xml") ? ".xml" : null;
  if (!ext) return null;
  return countComplexity(readFileSync(p, "utf8"), ext, cfg.complexityRule || "complexity");
}

// dependencies: number of circular dependency cycles, via madge (JS/TS).
function collectDependencies(cfg) {
  const root = cfg.root || ".";
  try {
    const out = execFileSync("npx", ["--yes", "madge", "--circular", "--json", root], { encoding: "utf8" });
    const cycles = JSON.parse(out);
    return Array.isArray(cycles) ? cycles.length : Object.keys(cycles).length;
  } catch {
    return null; // madge unavailable / non-JS project → absent, never faked
  }
}

// mutation: mutation score % from a stryker json or pitest xml report. Pure
// helpers so --selftest can exercise them. Score = detected / valid * 100.
export function mutationScoreStryker(report) {
  let detected = 0, valid = 0;
  for (const f of Object.values(report.files || {})) {
    for (const m of f.mutants || []) {
      if (m.status === "Killed" || m.status === "Timeout") { detected++; valid++; }
      else if (m.status === "Survived" || m.status === "NoCoverage") { valid++; }
      // Ignored / CompileError / RuntimeError are excluded from the denominator
    }
  }
  return valid ? round((detected / valid) * 100) : null;
}

export function mutationScorePitest(xml) {
  const tags = xml.match(/<mutation\b[^>]*>/g) || [];
  if (!tags.length) return null;
  const detected = tags.filter((t) => /detected=['"]true['"]/.test(t)).length;
  return round((detected / tags.length) * 100);
}

function collectMutation(cfg) {
  const p = cfg.reports?.mutation;
  if (!p || !existsSync(p)) return null;
  if (p.endsWith(".json")) return mutationScoreStryker(readJSON(p));
  if (p.endsWith(".xml")) return mutationScorePitest(readFileSync(p, "utf8"));
  return null;
}

// security: npm audit --json → vulnerability counts by severity.
function collectSecurity(cfg) {
  const p = cfg.reports?.audit;
  if (!p || !existsSync(p)) return null;
  const j = readJSON(p);
  const v = j.metadata?.vulnerabilities || {};
  return { critical: v.critical || 0, high: v.high || 0 };
}

function collect(cfg) {
  const metrics = {};
  const active = cfg.metrics || Object.keys(DIRECTION).concat("security");
  if (active.includes("coverage")) metrics.coverage = collectCoverage(cfg);
  if (active.includes("duplication")) metrics.duplication = collectDuplication(cfg);
  if (active.includes("lint")) metrics.lint = collectLint(cfg);
  if (active.includes("largeFiles")) metrics.largeFiles = countLargeFiles(cfg);
  if (active.includes("complexity")) metrics.complexity = collectComplexity(cfg);
  if (active.includes("dependencies")) metrics.dependencies = collectDependencies(cfg);
  if (active.includes("mutation")) metrics.mutation = collectMutation(cfg);
  if (active.includes("security")) metrics.security = collectSecurity(cfg);
  return { generatedAt: new Date().toISOString(), maxFileLines: cfg.maxFileLines || 300, metrics };
}

// --- comparison (the ratchet) ------------------------------------------------
// Returns { regressions:[], improvements:[], warnings:[], nextBaseline:{} }.
function compare(baseline, current) {
  const b = baseline.metrics || {};
  const c = current.metrics || {};
  const regressions = [], improvements = [], warnings = [];
  const nextBaseline = { ...b };

  for (const [key, dir] of Object.entries(DIRECTION)) {
    const cur = c[key], base = b[key];
    if (cur == null || base == null) continue; // absent metric never regresses or improves
    const worse = dir === "higher_is_better" ? cur < base : cur > base;
    const better = dir === "higher_is_better" ? cur > base : cur < base;
    if (worse) regressions.push({ key, base, cur });
    else if (better) { improvements.push({ key, base, cur }); nextBaseline[key] = cur; }
  }

  // security: critical > 0 always blocks; high > 0 warns. Not ratcheted.
  if (c.security) {
    if (c.security.critical > 0)
      regressions.push({ key: "security.critical", base: 0, cur: c.security.critical });
    if (c.security.high > 0)
      warnings.push({ key: "security.high", cur: c.security.high });
  }
  return { regressions, improvements, warnings, nextBaseline };
}

function markdownSummary({ regressions, improvements, warnings }) {
  const arrow = (r) => `\`${r.base}\` → \`${r.cur}\``;
  let md = "## Quality Gate\n\n";
  if (regressions.length) {
    md += "### ❌ Regressions (blocking)\n\n";
    for (const r of regressions) md += `- **${r.key}**: ${arrow(r)}\n`;
    md += "\n";
  } else {
    md += "### ✅ No regressions\n\n";
  }
  if (warnings.length) {
    md += "### ⚠️ Warnings\n\n";
    for (const w of warnings) md += `- **${w.key}**: ${w.cur}\n`;
    md += "\n";
  }
  if (improvements.length) {
    md += "### 🎉 Improvements (ratchet advances on merge)\n\n";
    for (const i of improvements) md += `- **${i.key}**: ${arrow(i)}\n`;
    md += "\n";
  }
  return md;
}

// --- commands ----------------------------------------------------------------
function cmdCollect(cfg, out = "metrics.json") {
  const m = collect(cfg);
  writeJSON(out, m);
  console.log(`wrote ${out}`);
}

function cmdCheck(cfg, baselinePath = "baseline.json", metricsPath = "metrics.json") {
  if (!existsSync(baselinePath)) {
    console.error(`no ${baselinePath} — run \`collect\` then commit it as the baseline first`);
    process.exit(2);
  }
  const metrics = existsSync(metricsPath) ? readJSON(metricsPath) : collect(cfg);
  const result = compare(readJSON(baselinePath), metrics);
  const md = markdownSummary(result);
  console.log(md);
  const summaryFile = cfg.summaryFile || "quality-gate-summary.md";
  writeFileSync(summaryFile, md);
  if (result.regressions.length) process.exit(1);
}

function cmdUpdate(cfg, baselinePath = "baseline.json", metricsPath = "metrics.json") {
  const metrics = existsSync(metricsPath) ? readJSON(metricsPath) : collect(cfg);
  const base = existsSync(baselinePath)
    ? readJSON(baselinePath)
    : { metrics: {} };
  const { nextBaseline } = compare(base, metrics);
  writeJSON(baselinePath, { updatedAt: new Date().toISOString(), metrics: nextBaseline });
  console.log(`ratchet advanced → ${baselinePath}`);
}

// --- selftest ----------------------------------------------------------------
function selftest() {
  const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };
  const base = { metrics: { coverage: 7, duplication: 2.2, lint: 483, largeFiles: 19, complexity: 12, dependencies: 3, security: { critical: 0, high: 0 } } };

  // (a) coverage drops → regression
  let r = compare(base, { metrics: { ...base.metrics, coverage: 6 } });
  assert(r.regressions.some((x) => x.key === "coverage"), "coverage drop must regress");

  // (b) duplication rises → regression
  r = compare(base, { metrics: { ...base.metrics, duplication: 3.0 } });
  assert(r.regressions.some((x) => x.key === "duplication"), "duplication rise must regress");

  // (c) everything improves → no regression, ratchet advances
  r = compare(base, { metrics: { coverage: 12, duplication: 1.0, lint: 400, largeFiles: 15, security: { critical: 0, high: 0 } } });
  assert(r.regressions.length === 0, "all-better must not regress");
  assert(r.nextBaseline.coverage === 12 && r.nextBaseline.lint === 400, "ratchet must advance to improved values");

  // (d) critical vuln blocks; high only warns
  r = compare(base, { metrics: { ...base.metrics, security: { critical: 1, high: 4 } } });
  assert(r.regressions.some((x) => x.key === "security.critical"), "critical vuln must block");
  assert(r.warnings.some((x) => x.key === "security.high"), "high vuln must warn, not block");

  // (e) absent metric never counts as regression or improvement
  r = compare(base, { metrics: { ...base.metrics, coverage: null } });
  assert(!r.regressions.some((x) => x.key === "coverage"), "absent metric must not regress");

  // (f) complexity rise → regression; dependencies rise → regression
  r = compare(base, { metrics: { ...base.metrics, complexity: 15 } });
  assert(r.regressions.some((x) => x.key === "complexity"), "complexity rise must regress");
  r = compare(base, { metrics: { ...base.metrics, dependencies: 5 } });
  assert(r.regressions.some((x) => x.key === "dependencies"), "circular deps rise must regress");

  // (g) complexity parsing: eslint json counts only the `complexity` rule
  const eslintJson = JSON.stringify([
    { messages: [{ ruleId: "complexity" }, { ruleId: "no-unused-vars" }, { ruleId: "complexity" }] },
    { messages: [{ ruleId: "complexity" }] },
  ]);
  assert(countComplexity(eslintJson, ".json", "complexity") === 3, "must count only complexity-rule messages");

  // (h) mutation score drops → regression (higher_is_better)
  const mbase = { metrics: { ...base.metrics, mutation: 60 } };
  r = compare(mbase, { metrics: { ...mbase.metrics, mutation: 55 } });
  assert(r.regressions.some((x) => x.key === "mutation"), "mutation score drop must regress");

  // (i) mutation parsing: stryker (2 killed, 1 survived → 66.67) and pitest
  const stryker = { files: { "a.ts": { mutants: [{ status: "Killed" }, { status: "Killed" }, { status: "Survived" }] } } };
  assert(mutationScoreStryker(stryker) === 66.67, "stryker score = detected/valid*100");
  const pit = `<mutations><mutation detected='true' status='KILLED'/><mutation detected='false' status='SURVIVED'/></mutations>`;
  assert(mutationScorePitest(pit) === 50, "pitest score = detected/total*100");

  console.log("selftest OK");
}

// --- main --------------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
if (process.argv.includes("--selftest")) { selftest(); process.exit(0); }
const cfgPath = rest.find((a) => a.startsWith("--config="))?.split("=")[1] || "qualitygate.config.json";

switch (cmd) {
  case "collect": cmdCollect(loadConfig(cfgPath)); break;
  case "check": cmdCheck(loadConfig(cfgPath)); break;
  case "update": cmdUpdate(loadConfig(cfgPath)); break;
  default:
    console.error("usage: quality-gate.mjs <collect|check|update> [--config=path] | --selftest");
    process.exit(2);
}
