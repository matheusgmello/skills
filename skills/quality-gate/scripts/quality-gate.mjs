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
//   --preset=lite|full  pick which metrics run without editing the config:
//                       lite = the five fundamentals, full = everything.
//                       An explicit `metrics` list in the config always wins.
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

// --- presets -----------------------------------------------------------------
// lite = the five fundamentals a project can adopt without extra tooling.
// full = everything, including the slower/heavier metrics.
const PRESETS = {
  lite: ["coverage", "duplication", "lint", "largeFiles", "security"],
  full: [...Object.keys(DIRECTION), "security", "benchmark"],
};

// --- helpers -----------------------------------------------------------------
const readJSON = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJSON = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
const round = (n) => Math.round(n * 100) / 100;
// Significant digits, not decimals: a benchmark mean can be 0.0012 ms, which
// round() would flatten to 0.
const sig = (n, digits = 4) => Number(Number(n).toPrecision(digits));

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

// benchmark: {name: value} from a bench report. Pure so --selftest covers it.
// Understands JMH, vitest bench, tinybench, and a plain {name: number} object.
// Values are time-per-op (lower is better) unless benchmarkHigherIsBetter is set.
export function parseBenchmarks(json) {
  const out = {};
  const add = (name, value) => {
    if (name != null && typeof value === "number" && isFinite(value)) out[String(name)] = sig(value);
  };

  // JMH (-rf json): [{ benchmark, primaryMetric: { score } }]
  if (Array.isArray(json) && json[0]?.primaryMetric) {
    for (const b of json) add(b.benchmark, b.primaryMetric?.score);
    return out;
  }
  // vitest bench --outputJson: { files: [{ groups: [{ benchmarks: [{ name, mean }] }] }] }
  if (json?.files) {
    for (const f of json.files)
      for (const g of f.groups || [])
        for (const b of g.benchmarks || []) add(b.name, b.mean ?? b.result?.mean);
    return out;
  }
  // tinybench: [{ name, mean | result.latency.mean | result.mean }]
  if (Array.isArray(json)) {
    for (const t of json) add(t.name, t.mean ?? t.result?.latency?.mean ?? t.result?.mean ?? t.value);
    return out;
  }
  // generic: { "parseInvoice": 1.2 }
  if (json && typeof json === "object") for (const [k, v] of Object.entries(json)) add(k, v);
  return out;
}

function collectBenchmark(cfg) {
  const p = cfg.reports?.benchmark;
  if (!p || !existsSync(p)) return null;
  const parsed = parseBenchmarks(readJSON(p));
  return Object.keys(parsed).length ? parsed : null;
}

// security: npm audit --json → vulnerability counts by severity.
function collectSecurity(cfg) {
  const p = cfg.reports?.audit;
  if (!p || !existsSync(p)) return null;
  const j = readJSON(p);
  const v = j.metadata?.vulnerabilities || {};
  return { critical: v.critical || 0, high: v.high || 0 };
}

// Which metrics run: explicit config list > --preset > full.
export function activeMetrics(cfg, preset) {
  if (cfg.metrics) return cfg.metrics;
  if (preset) {
    if (!PRESETS[preset]) {
      console.error(`unknown preset: ${preset} (use lite or full)`);
      process.exit(2);
    }
    return PRESETS[preset];
  }
  return PRESETS.full;
}

function collect(cfg, preset) {
  const metrics = {};
  const active = activeMetrics(cfg, preset);
  if (active.includes("coverage")) metrics.coverage = collectCoverage(cfg);
  if (active.includes("duplication")) metrics.duplication = collectDuplication(cfg);
  if (active.includes("lint")) metrics.lint = collectLint(cfg);
  if (active.includes("largeFiles")) metrics.largeFiles = countLargeFiles(cfg);
  if (active.includes("complexity")) metrics.complexity = collectComplexity(cfg);
  if (active.includes("dependencies")) metrics.dependencies = collectDependencies(cfg);
  if (active.includes("mutation")) metrics.mutation = collectMutation(cfg);
  if (active.includes("benchmark")) metrics.benchmark = collectBenchmark(cfg);
  if (active.includes("security")) metrics.security = collectSecurity(cfg);
  return { generatedAt: new Date().toISOString(), maxFileLines: cfg.maxFileLines || 300, metrics };
}

// --- benchmark comparison (tolerant ratchet) ---------------------------------
// CI runners are noisy: the same code varies run to run, so a strict ratchet
// would fail PRs at random. Judge by PERCENT change against a tolerance band.
//
// The band is SYMMETRIC on purpose: an improvement inside it does not advance
// the baseline either. Ratcheting to a lucky-fast run would make every ordinary
// run afterwards look like a regression — the gate would eat itself.
export function compareBenchmarks(base = {}, cur = {}, opts = {}) {
  const { tolerance = 10, higherIsBetter = false, unit = "ms" } = opts;
  const regressions = [], improvements = [], rows = [];
  const next = { ...base };

  for (const [name, value] of Object.entries(cur)) {
    const b = base?.[name];
    if (b == null || b === 0) {
      // new benchmark (or unusable baseline): start tracking it, never judge it
      next[name] = value;
      rows.push({ label: `benchmark: ${name}`, base: b ?? null, cur: value, delta: null, deltaText: "new", status: "absent", unit });
      continue;
    }
    const pct = ((value - b) / b) * 100;
    const worsePct = higherIsBetter ? -pct : pct; // positive = worse, whichever direction
    let status = "same";
    if (worsePct > tolerance) {
      regressions.push({ key: `benchmark.${name}`, base: b, cur: value });
      status = "regress";
    } else if (worsePct < -tolerance) {
      improvements.push({ key: `benchmark.${name}`, base: b, cur: value });
      next[name] = value;
      status = "improve";
    } // else: inside the band — noise. Baseline stays put.
    const shown = sig(pct, 3);
    rows.push({ label: `benchmark: ${name}`, base: b, cur: value, delta: shown, deltaText: `${shown > 0 ? "+" : ""}${shown}%`, status, unit });
  }
  return { regressions, improvements, next, rows };
}

// --- comparison (the ratchet) ------------------------------------------------
// Returns { regressions, improvements, warnings, nextBaseline, rows }.
// `rows` is every active metric (base/cur/delta/status) for the summary table.
function compare(baseline, current, opts = {}) {
  const b = baseline.metrics || {};
  const c = current.metrics || {};
  const regressions = [], improvements = [], warnings = [], rows = [];
  const nextBaseline = { ...b };

  for (const [key, dir] of Object.entries(DIRECTION)) {
    const cur = c[key], base = b[key];
    if (cur == null && base == null) continue; // metric not in play at all
    let status = "same";
    if (cur != null && base != null) {
      const worse = dir === "higher_is_better" ? cur < base : cur > base;
      const better = dir === "higher_is_better" ? cur > base : cur < base;
      if (worse) { regressions.push({ key, base, cur }); status = "regress"; }
      else if (better) { improvements.push({ key, base, cur }); nextBaseline[key] = cur; status = "improve"; }
    } else {
      status = "absent"; // one side missing — can't judge
    }
    const delta = (cur != null && base != null) ? round(cur - base) : null;
    rows.push({ label: key, base, cur, delta, status });
  }

  // security: critical > 0 always blocks; high > 0 warns. Not ratcheted.
  if (c.security) {
    if (c.security.critical > 0)
      regressions.push({ key: "security.critical", base: 0, cur: c.security.critical });
    if (c.security.high > 0)
      warnings.push({ key: "security.high", cur: c.security.high });
    rows.push({ label: "security (critical)", base: 0, cur: c.security.critical, delta: c.security.critical, status: c.security.critical > 0 ? "regress" : "same" });
    rows.push({ label: "security (high)", base: 0, cur: c.security.high, delta: c.security.high, status: c.security.high > 0 ? "warn" : "same" });
  }

  // benchmark: per-named-bench, percentage change against a tolerance band.
  if (c.benchmark) {
    const r = compareBenchmarks(b.benchmark, c.benchmark, opts.benchmark);
    regressions.push(...r.regressions);
    improvements.push(...r.improvements);
    rows.push(...r.rows);
    nextBaseline.benchmark = r.next;
  }
  return { regressions, improvements, warnings, nextBaseline, rows };
}

function markdownSummary({ regressions, improvements, warnings, rows }) {
  const ICON = { regress: "❌", improve: "✅", same: "➖", warn: "⚠️", absent: "·" };
  const fmt = (v, unit) => (v == null ? "—" : unit ? `${v} ${unit}` : String(v));
  const fmtDelta = (r) => {
    if (r.deltaText) return r.deltaText;      // benchmarks report percent
    if (r.delta == null) return "—";
    if (r.delta === 0) return "±0";
    return (r.delta > 0 ? "+" : "") + r.delta;
  };

  const n = regressions.length;
  const title = n ? `❌ ${n} regression${n > 1 ? "s" : ""} — blocking` : "✅ No regressions";
  let md = `## Quality Gate — ${title}\n\n`;
  md += "| Metric | Baseline | Current | Δ | |\n|---|---:|---:|---:|:-:|\n";
  for (const r of rows)
    md += `| ${r.label} | ${fmt(r.base, r.unit)} | ${fmt(r.cur, r.unit)} | ${fmtDelta(r)} | ${ICON[r.status] || ""} |\n`;

  const improved = improvements.length;
  if (improved) md += `\n_🎉 ${improved} metric${improved > 1 ? "s" : ""} improved — ratchet advances on merge._\n`;
  if (warnings.length) md += `\n> ⚠️ ${warnings.map((w) => `${w.key}: ${w.cur}`).join(", ")} (warning, not blocking)\n`;
  return md;
}

// --- commands ----------------------------------------------------------------
// Comparison options drawn from config (benchmark tolerance band & direction).
const compareOpts = (cfg) => ({
  benchmark: {
    tolerance: cfg.benchmarkTolerance ?? 10,
    higherIsBetter: cfg.benchmarkHigherIsBetter === true,
    unit: cfg.benchmarkUnit ?? "ms",
  },
});

function cmdCollect(cfg, preset, out = "metrics.json") {
  const m = collect(cfg, preset);
  writeJSON(out, m);
  console.log(`wrote ${out}`);
}

function cmdCheck(cfg, preset, baselinePath = "baseline.json", metricsPath = "metrics.json") {
  if (!existsSync(baselinePath)) {
    console.error(`no ${baselinePath} — run \`collect\` then commit it as the baseline first`);
    process.exit(2);
  }
  const metrics = existsSync(metricsPath) ? readJSON(metricsPath) : collect(cfg, preset);
  const result = compare(readJSON(baselinePath), metrics, compareOpts(cfg));
  const md = markdownSummary(result);
  console.log(md);
  const summaryFile = cfg.summaryFile || "quality-gate-summary.md";
  writeFileSync(summaryFile, md);
  if (result.regressions.length) process.exit(1);
}

function cmdUpdate(cfg, preset, baselinePath = "baseline.json", metricsPath = "metrics.json") {
  const metrics = existsSync(metricsPath) ? readJSON(metricsPath) : collect(cfg, preset);
  const base = existsSync(baselinePath)
    ? readJSON(baselinePath)
    : { metrics: {} };
  const { nextBaseline } = compare(base, metrics, compareOpts(cfg));
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

  // (j) summary table: every metric is a row with a signed delta
  r = compare(base, { metrics: { ...base.metrics, coverage: 12, duplication: 3.0 } });
  const md = markdownSummary(r);
  assert(md.includes("| coverage | 7 | 12 | +5 |"), "coverage row shows signed positive delta");
  assert(md.includes("| duplication | 2.2 | 3 | +0.8 |"), "duplication row shows delta");
  assert(md.includes("Baseline | Current | Δ"), "table has Baseline/Current/Δ header");
  assert(r.rows.length >= 6, "rows cover all active metrics, not just changed ones");

  // (k) presets: lite is the five fundamentals, full is everything, config wins
  const lite = activeMetrics({}, "lite");
  assert(lite.length === 5 && !lite.includes("mutation") && lite.includes("coverage"), "lite = five fundamentals, no mutation");
  const full = activeMetrics({}, "full");
  assert(full.includes("mutation") && full.includes("complexity") && full.includes("security"), "full includes the heavy metrics");
  assert(activeMetrics({}, undefined).length === full.length, "no preset defaults to full");
  assert(activeMetrics({ metrics: ["lint"] }, "full")[0] === "lint", "explicit config metrics override the preset");

  // (l) benchmark tolerance band, both directions
  const bb = { parseInvoice: 1.2, renderTable: 45, hashToken: 0.8 };
  let bench = compareBenchmarks(bb, { parseInvoice: 1.24, renderTable: 58.5, hashToken: 0.62 });
  assert(!bench.regressions.some((x) => x.key === "benchmark.parseInvoice"), "+3.3% is inside the band — noise, not a regression");
  assert(bench.regressions.some((x) => x.key === "benchmark.renderTable"), "+30% must regress");
  assert(bench.improvements.some((x) => x.key === "benchmark.hashToken"), "-22.5% must count as an improvement");
  assert(bench.next.parseInvoice === 1.2, "in-band value must NOT advance the baseline");
  assert(bench.next.hashToken === 0.62, "real improvement advances the baseline");

  // the symmetric half: a lucky-fast run inside the band must not ratchet
  bench = compareBenchmarks(bb, { parseInvoice: 1.14 }); // -5%, inside the band
  assert(bench.improvements.length === 0, "-5% is noise, not an improvement");
  assert(bench.next.parseInvoice === 1.2, "in-band speedup must not lower the baseline (would fail every later run)");

  // a brand-new benchmark is tracked but never judged
  bench = compareBenchmarks(bb, { ...bb, newBench: 9 });
  assert(bench.regressions.length === 0 && bench.next.newBench === 9, "new benchmark is adopted, not failed");

  // higher-is-better (ops/sec): more is better, so a drop regresses
  bench = compareBenchmarks({ ops: 1000 }, { ops: 700 }, { higherIsBetter: true });
  assert(bench.regressions.some((x) => x.key === "benchmark.ops"), "throughput drop must regress when higherIsBetter");

  // (m) benchmark report parsing across tools
  assert(parseBenchmarks([{ benchmark: "com.x.parse", primaryMetric: { score: 1.5 } }])["com.x.parse"] === 1.5, "parse JMH");
  assert(parseBenchmarks({ files: [{ groups: [{ benchmarks: [{ name: "v", mean: 2.5 }] }] }] }).v === 2.5, "parse vitest bench");
  assert(parseBenchmarks([{ name: "t", result: { latency: { mean: 0.0012 } } }]).t === 0.0012, "parse tinybench, sub-ms precision kept");
  assert(parseBenchmarks({ plain: 7 }).plain === 7, "parse generic {name: number}");

  // benchmark rows render a percent delta with a unit
  const bmd = markdownSummary({ regressions: [], improvements: [], warnings: [], rows: compareBenchmarks(bb, { renderTable: 58.5 }).rows });
  assert(bmd.includes("| benchmark: renderTable | 45 ms | 58.5 ms | +30%"), "benchmark row shows unit and percent delta");

  console.log("selftest OK");
}

// --- main --------------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
if (process.argv.includes("--selftest")) { selftest(); process.exit(0); }
const cfgPath = rest.find((a) => a.startsWith("--config="))?.split("=")[1] || "qualitygate.config.json";
const preset = rest.find((a) => a.startsWith("--preset="))?.split("=")[1];

switch (cmd) {
  case "collect": cmdCollect(loadConfig(cfgPath), preset); break;
  case "check": cmdCheck(loadConfig(cfgPath), preset); break;
  case "update": cmdUpdate(loadConfig(cfgPath), preset); break;
  default:
    console.error("usage: quality-gate.mjs <collect|check|update> [--config=path] [--preset=lite|full] | --selftest");
    process.exit(2);
}
