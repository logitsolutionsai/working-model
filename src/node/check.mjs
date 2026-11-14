// `working-model check`: schema, compile, simulate, claims, lint.

import fs from 'node:fs';
import path from 'node:path';
import { buildSchema } from './schema.mjs';
import { validateSchema } from './validate-schema.mjs';
import { analyze } from '../engine/index.mjs';
import { ModelError, describeLoc, excerpt, errorToJSON } from '../engine/errors.mjs';
import { explain } from '../engine/claims.mjs';
import { formatValue } from '../engine/format.mjs';
import { mutateClaims, scorePercent } from '../engine/mutate.mjs';

export const EXIT = { OK: 0, CLAIMS: 1, INVALID: 2, USAGE: 64 };

let SCHEMA = null;
export function schema() {
  if (!SCHEMA) SCHEMA = buildSchema();
  return SCHEMA;
}

// Parse JSON and turn a syntax error into E_JSON with a line and column.
export function parseSpecText(text, file) {
  try {
    return { spec: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (e) {
    const msg = String(e.message);
    let line = null;
    let col = null;
    const lc = /line (\d+) column (\d+)/.exec(msg);
    const pos = /position (\d+)/.exec(msg);
    if (lc) { line = Number(lc[1]); col = Number(lc[2]); } else if (pos) {
      const p = Number(pos[1]);
      const before = text.slice(0, p).split('\n');
      line = before.length; col = before[before.length - 1].length + 1;
    }
    return { error: { code: 'E_JSON', message: 'not valid JSON: ' + msg.replace(/^.*?:\s*/, ''), path: file, line, col } };
  }
}

export function loadSpec(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { error: { code: 'E_READ', message: `cannot read ${file}: ${e.code || e.message}`, path: file } };
  }
  return parseSpecText(text, file);
}

// JSON.parse accepts very deep nesting, but the schema walk and the engine
// recurse, so refuse it up front with a clear error instead of a stack overflow.
const MAX_JSON_DEPTH = 64;
function tooDeep(value, max) {
  const stack = [[value, 0, '']];
  while (stack.length) {
    const [v, d, p] = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (d >= max) return p || '(root)';
    if (Array.isArray(v)) v.forEach((x, i) => stack.push([x, d + 1, `${p}[${i}]`]));
    else for (const k of Object.keys(v)) stack.push([v[k], d + 1, p ? `${p}.${k}` : k]);
  }
  return null;
}

// Full check of an already-parsed spec. Returns a plain report object.
export function checkSpec(spec, opts = {}) {
  const report = { ok: false, exit: EXIT.INVALID, stage: 'schema', errors: [], warnings: [], results: [], passed: 0, total: 0, lint: [], probes: [], ticks: 0, ms: 0 };
  const deep = tooDeep(spec, MAX_JSON_DEPTH);
  if (deep) {
    report.errors = [{ code: 'E_TOO_DEEP', path: deep, message: `the JSON is nested more than ${MAX_JSON_DEPTH} levels deep` }];
    return report;
  }
  const schemaErrors = validateSchema(spec, schema());
  if (schemaErrors.length) {
    report.errors = schemaErrors;
    return report;
  }
  const a = analyze(spec, { params: opts.params, probe: opts.probe });
  report.stage = a.stage;
  report.model = a.model;
  report.ticks = a.ticks;
  report.ms = Math.round(a.ms);
  report.errors = a.errors.map((e) => errorWithExcerpt(e));
  report.warnings = a.warnings;
  if (a.errors.length) return report;
  report.results = a.results;
  report.passed = a.passed;
  report.total = a.total;
  report.lint = a.lint;
  report.probes = a.probes;
  report.trace = a.trace;
  const lintErrors = a.lint.filter((i) => i.severity === 'error').length;
  const warnCount = a.lint.filter((i) => i.severity !== 'error').length + a.warnings.length;
  report.ok = a.passed === a.total && lintErrors === 0 && !(opts.strict && warnCount > 0);
  report.exit = report.ok ? EXIT.OK : EXIT.CLAIMS;
  return report;
}

function errorWithExcerpt(e) {
  const j = errorToJSON(e);
  if (e instanceof ModelError && e.loc) {
    const ex = excerpt(e.loc);
    if (ex) j.excerpt = ex;
    if (e.at) j.at = e.at;
  }
  return j;
}

export function checkFile(file, opts = {}) {
  const loaded = loadSpec(file);
  if (loaded.error) {
    return { file, ok: false, exit: EXIT.INVALID, stage: 'json', errors: [loaded.error], warnings: [], results: [], passed: 0, total: 0, lint: [], probes: [] };
  }
  const r = checkSpec(loaded.spec, opts);
  r.file = file;
  r.spec = loaded.spec;
  if (opts.mutate && r.model && !r.errors.length) runMutation(r, opts);
  return r;
}

// `check --mutate`: test the claims by breaking the rules on purpose.
// strict: exit 1 when a claim never fails or the score is below minScore.
export function runMutation(r, opts) {
  const mo = typeof opts.mutate === 'object' ? opts.mutate : {};
  if (r.passed !== r.total) {
    r.mutation = { ok: false, error: 'every claim must pass first' };
    return r;
  }
  r.mutation = mutateClaims(r.model, { params: opts.params, cap: mo.cap, seed: mo.seed });
  const m = r.mutation;
  if (m.ok && mo.strict) {
    const min = mo.minScore != null ? mo.minScore : 0;
    m.strictFailures = [];
    if (m.neverFailed.length) m.strictFailures.push(`${m.neverFailed.length} claim${m.neverFailed.length === 1 ? '' : 's'} never failed`);
    if (scorePercent(m) < min) m.strictFailures.push(`mutation score ${scorePercent(m)}% is below ${min}%`);
    if (m.strictFailures.length && r.exit === EXIT.OK) { r.exit = EXIT.CLAIMS; r.ok = false; }
  }
  return r;
}

export function mutationLine(m) {
  if (!m || !m.ok) return '';
  return `mutation score ${scorePercent(m)}% (${m.killed + m.engine} of ${m.scored} mutants killed)`;
}

export function formatMutation(r, c) {
  const m = r.mutation;
  const out = [];
  if (!m) return '';
  if (!m.ok) return c.red(`  mutation testing skipped: ${m.error}`);
  out.push(c.bold('  Mutation testing'));
  out.push(c.dim(`  ${m.tested} mutant${m.tested === 1 ? '' : 's'}${m.sampled ? ` (a seeded sample of ${m.total}; --mutate=${m.total} tests all)` : ''}, ${m.paramSets} param set${m.paramSets === 1 ? '' : 's'}, ${m.ms} ms: `
    + `${m.killed} killed by claims, ${m.engine} by the engine, ${m.equivalent} equivalent, ${m.visual} visual only, ${m.ignored} ignored, ${m.survived} survived`));
  out.push('');
  const w = Math.max(...m.claims.map((x) => x.id.length), 4);
  for (const cl of m.claims) {
    const n = `${cl.kills} kill${cl.kills === 1 ? '' : 's'}`.padEnd(10);
    const only = cl.unique ? `(${cl.unique} only this claim catches)` : '';
    out.push(`  ${(cl.kills ? c.green : c.red)(cl.id.padEnd(w))}  ${n}${c.dim(only)}`);
    if (cl.example) out.push(c.dim(`  ${' '.repeat(w)}  e.g. ${cl.example.id} ${cl.example.at}  ${cl.example.change}`));
  }
  if (m.neverFailed.length) {
    out.push('');
    out.push(c.red('  Claims that never failed:'));
    for (const x of m.neverFailed) out.push(`    ${c.red(x.id)}: ${x.hint}`);
  }
  const engine = m.mutants.filter((x) => x.status === 'engine');
  if (engine.length) {
    out.push('');
    out.push(c.dim('  Killed by the engine (the mutant does not compile, or errors while running):'));
    for (const x of engine) out.push(c.dim(`    ${x.id} ${x.at}  ${x.change}  ${x.error ? x.error.code : ''}`));
  }
  const survived = m.mutants.filter((x) => x.status === 'survived');
  if (survived.length) {
    out.push('');
    out.push(c.yellow('  Survived mutants (the rules could break this way and no claim would notice):'));
    const groups = new Map();
    for (const x of survived) { if (!groups.has(x.path)) groups.set(x.path, []); groups.get(x.path).push(x); }
    for (const [p, xs] of groups) {
      out.push(`    ${c.bold(p)}`);
      for (const x of xs) out.push(`      ${x.id.padEnd(5)} ${x.key}  ${c.dim('[' + x.op + ']')}`);
    }
    out.push(c.dim('    For each: add or strengthen a claim (often a scenario that exercises the rule), or, if the change is truly harmless,'));
    out.push(c.dim('    add { "mutant": "<the line after the id>", "reason": "..." } to mutate.ignore in the spec.'));
  }
  const visual = m.mutants.filter((x) => x.status === 'visual');
  if (visual.length) {
    out.push('');
    out.push(c.dim(`  Visual only (the state is unchanged; only signals differ): ${visual.map((x) => x.id).join(', ')}`));
  }
  const eq = m.mutants.filter((x) => x.status === 'equivalent');
  if (eq.length) out.push(c.dim(`  Equivalent (no observable change at any param set the claims use): ${eq.map((x) => x.id).join(', ')}`));
  const ign = m.mutants.filter((x) => x.status === 'ignored');
  if (ign.length) {
    out.push(c.dim('  Ignored (mutate.ignore):'));
    for (const x of ign) out.push(c.dim(`    ${x.id} ${x.at}  ${x.change}: ${x.reason}`));
  }
  for (const wv of m.warnings) out.push(`  ${c.yellow(wv.code)}  ${wv.path}: ${wv.message}`);
  out.push('');
  const bad = m.neverFailed.length || m.survived;
  out.push((bad ? c.yellow : c.green)(`  ${mutationLine(m)}${m.neverFailed.length ? `, ${m.neverFailed.length} claim${m.neverFailed.length === 1 ? '' : 's'} never failed` : ''}`));
  if (m.strictFailures && m.strictFailures.length) out.push(c.red(`  --mutate-strict: ${m.strictFailures.join('; ')}`));
  return out.join('\n');
}

export function listSpecFiles(target) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    return fs.readdirSync(target).filter((f) => f.endsWith('.model.json')).sort().map((f) => path.join(target, f));
  }
  return [target];
}

// ---- output -------------------------------------------------------------

export function color(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { green: wrap('32'), red: wrap('31'), yellow: wrap('33'), dim: wrap('2'), bold: wrap('1'), cyan: wrap('36') };
}

export function summaryLine(r) {
  if (r.stage === 'json' || r.stage === 'schema' || r.stage === 'compile' || r.stage === 'simulate') {
    if (r.errors.length) return `invalid spec: ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`;
  }
  return `${r.passed}/${r.total} claims pass`;
}

export function formatReport(r, c) {
  const out = [];
  const name = path.basename(r.file || 'spec');
  const title = r.spec && r.spec.title ? ` - ${r.spec.title}` : '';
  out.push(c.bold(`${name}${title}`));
  if (r.errors.length) {
    out.push(c.red(`  ${r.stage === 'json' ? 'JSON' : r.stage === 'schema' ? 'schema' : r.stage === 'simulate' ? 'simulation' : 'compile'} errors:`));
    for (const e of r.errors) {
      const where = e.path ? `${e.path}${e.line ? ':' + e.line + ':' + e.col : ''}` : '';
      out.push(`  ${c.red(e.code)}  ${where ? where + ': ' : ''}${e.message}`);
      if (e.at) out.push(c.dim(`      while simulating t = ${formatValue(Math.round(e.at.t * 1e6) / 1e6)}`));
      if (e.excerpt) out.push(c.dim(e.excerpt));
      if (e.hint) out.push(c.dim(`      hint: ${e.hint}`));
    }
    out.push('');
    out.push(c.red(`  ${summaryLine(r)}`));
    return out.join('\n');
  }
  const m = r.model;
  const nParts = m ? m.parts.length : 0;
  out.push(c.dim(`  ${nParts} parts, ${m ? m.params.length : 0} params, ${r.ticks + 1} ticks, ${r.ms} ms`));
  out.push('');
  const w = Math.max(...r.results.map((x) => x.id.length), 4);
  for (const x of r.results) {
    const mark = x.pass ? c.green('PASS') : c.red(x.status === 'error' ? 'ERR ' : 'FAIL');
    out.push(`  ${mark}  ${x.id.padEnd(w)}  ${x.text}`);
    if (!x.pass) out.push(c.red(`        ${x.line || explain(m, m.claims.find((q) => q.id === x.id), x)}`));
  }
  const issues = [...(r.warnings || []), ...(r.lint || [])];
  if (issues.length) {
    out.push('');
    for (const i of issues) {
      const tag = i.severity === 'error' ? c.red(i.code) : c.yellow(i.code);
      out.push(`  ${tag}  ${i.path ? i.path + ': ' : ''}${i.message}`);
      if (i.fix) out.push(c.dim(`      fix: ${i.fix}`));
    }
  }
  const breakers = (r.probes || []).filter((p) => p.failing.length);
  if (breakers.length) {
    out.push('');
    out.push(c.dim('  Sliders that break a claim:'));
    for (const p of breakers) out.push(c.dim(`    ${p.param} = ${formatValue(p.value)} breaks ${p.failing.join(', ')}`));
  }
  out.push('');
  const ok = r.passed === r.total;
  out.push((ok ? c.green : c.red)(`  ${summaryLine(r)}`));
  return out.join('\n');
}

export function reportToJSON(r) {
  return {
    file: r.file, ok: r.ok, exit: r.exit, stage: r.stage,
    summary: summaryLine(r), passed: r.passed, total: r.total,
    errors: r.errors, warnings: r.warnings || [], lint: r.lint || [],
    results: (r.results || []).map((x) => ({ ...x })),
    probes: r.probes || [], ticks: r.ticks, ms: r.ms,
    ...(r.mutation ? { mutation: mutationJSON(r.mutation) } : {}),
  };
}

export function mutationJSON(m) {
  if (!m.ok) return { ok: false, error: m.error };
  return { ...m, scorePercent: scorePercent(m) };
}
