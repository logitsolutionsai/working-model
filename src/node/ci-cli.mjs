// `working-model ci`: claims, mutation, fuzz, trace conformance and browser
// parity for a set of models, as JSON, Markdown and JUnit XML. Thresholds
// come only from the config. A browser check without Chrome is reported as
// skipped, never as passed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkFile, runMutation, listSpecFiles } from './check.mjs';
import { RX, digestOf, readJSONFile, writeText, checkWithTrace, resolveSpecPath } from './reality.mjs';
import { printError } from './reality-cli.mjs';
import { TraceError, canonicalPretty } from '../trace/errors.mjs';
import { fuzzModel } from '../fuzz/fuzz.mjs';
import { scorePercent } from '../engine/mutate.mjs';
import { ENGINE_VERSION } from '../engine/index.mjs';
import { CI_DEFAULTS, aggregate, diffAgainst, toMarkdown, toJUnit } from '../ci/report.mjs';

const CONFIG_KEYS = ['$schema', 'schemaVersion', 'models', 'checks', 'output', 'note'];

export function loadConfig(file) {
  if (!file) return { config: { schemaVersion: 1, checks: {} }, base: process.cwd() };
  const raw = readJSONFile(file, 'the CI config');
  const bad = (msg, where) => new TraceError('E_CI_CONFIG', msg, where, 'see docs/CI.md for the config format');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('the config must be a JSON object', null);
  for (const k of Object.keys(raw)) if (!CONFIG_KEYS.includes(k)) throw bad(`unknown key "${k}"`, k);
  if (raw.schemaVersion !== 1) throw bad('"schemaVersion" must be 1', 'schemaVersion');
  if (raw.models != null && (!Array.isArray(raw.models) || raw.models.some((m) => typeof m !== 'string'))) throw bad('"models" must be a list of paths or patterns', 'models');
  const checks = raw.checks || {};
  for (const k of Object.keys(checks)) if (!(k in CI_DEFAULTS)) throw bad(`unknown check "${k}"`, `checks.${k}`);
  const m = checks.mutation;
  if (m && m.minScore != null && !(typeof m.minScore === 'number' && m.minScore >= 0 && m.minScore <= 100)) throw bad('"minScore" must be a percentage from 0 to 100', 'checks.mutation.minScore');
  const f = checks.fuzz;
  if (f && f.cases != null && !(Number.isInteger(f.cases) && f.cases > 0 && f.cases <= 2000)) throw bad('"cases" must be a whole number from 1 to 2000', 'checks.fuzz.cases');
  return { config: raw, base: path.dirname(path.resolve(file)) };
}

// "dir/*.model.json" style patterns: "*" matches inside one path segment.
export function expandModels(patterns, base) {
  const out = new Set();
  for (const p of patterns) {
    const full = path.resolve(base, p);
    if (!p.includes('*')) { for (const f of listSpecFiles(full)) out.add(path.resolve(f)); continue; }
    const dir = path.dirname(full);
    const re = new RegExp('^' + path.basename(full).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*') + '$');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) if (re.test(f)) out.add(path.join(dir, f));
  }
  return [...out].sort();
}

function rel(p) { return (path.relative(process.cwd(), p) || p).split(path.sep).join('/'); }

async function parityCheck(file, browserBox) {
  const { findChrome, launch } = await import('./chrome.mjs');
  try { findChrome(); } catch (e) { return { status: 'skipped', detail: 'no Chrome, Edge or Chromium found; set WORKING_MODEL_CHROME to run this check' }; }
  const { writeRealityPage } = await import('./build-reality.mjs');
  const { report, check, trace, files } = checkWithTrace(file, { trace: true, probe: false });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-ci-'));
  const page = path.join(tmp, 'parity.html');
  writeRealityPage(check.spec, { trace, mapping: readJSONFile(files.mappingFile, 'the mapping'), report }, page, {});
  if (!browserBox.browser) browserBox.browser = await launch();
  const p = await browserBox.browser.newPage({ width: 1280, height: 800 });
  try {
    await p.open(page);
    await p.waitForFunction('window.workingModelReality && window.workingModelReality.ready');
    const parity = await p.evaluate('window.workingModelReality.parity');
    return parity ? { status: 'pass', detail: 'the browser re-check equals the command line' } : { status: 'fail', detail: 'the browser re-check differs from the command line' };
  } finally {
    if (p.close) await p.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runCi(target, opts = {}) {
  const { config, base } = loadConfig(opts.config);
  const checks = {};
  for (const k of Object.keys(CI_DEFAULTS)) checks[k] = { ...CI_DEFAULTS[k], ...((config.checks || {})[k] || {}) };
  const patterns = config.models || (target ? [target] : []);
  if (!patterns.length) throw new TraceError('E_USAGE', 'ci needs a folder or file, or "models" in the config', null, 'pass a folder of *.model.json files');
  const files = expandModels(patterns, config.models ? base : process.cwd());
  if (!files.length) throw new TraceError('E_CI_NO_MODELS', 'no *.model.json files matched', 'models', 'check the paths in "models"');
  const browserBox = { browser: null };
  const models = [];
  try {
    for (const file of files) {
      const entry = { file: rel(file), checks: [], reproduce: [], assumptions: [] };
      const r = checkFile(file, { probe: false });
      if (r.errors.length) {
        entry.checks.push({ name: 'claims', status: 'error', detail: `${r.errors[0].code} ${r.errors[0].message}` });
        models.push(entry);
        continue;
      }
      const spec = r.spec;
      entry.digests = { spec: digestOf(spec), rules: digestOf({ rules: spec.rules || {}, events: spec.events || [], state: spec.state || {}, params: spec.params || [] }), claims: digestOf(spec.claims || []) };
      const lintErrors = r.lint.filter((i) => i.severity === 'error').length;
      const claimsOk = r.passed === r.total && !lintErrors;
      entry.checks.push({ name: 'claims', status: claimsOk ? 'pass' : (checks.claims.required ? 'fail' : 'inconclusive'), detail: `${r.passed}/${r.total} claims pass${lintErrors ? `, ${lintErrors} lint errors` : ''}` });
      entry.reproduce.push(`node scripts/working-model.mjs check ${rel(file)}`);
      if (checks.mutation.enabled) {
        if (!claimsOk) entry.checks.push({ name: 'mutation', status: 'skipped', detail: 'every claim must pass first' });
        else {
          runMutation(r, { mutate: {} });
          const m = r.mutation;
          const score = scorePercent(m);
          const never = m.neverFailed.length;
          const ok = score >= checks.mutation.minScore;
          entry.checks.push({ name: 'mutation', status: ok ? 'pass' : 'fail', detail: `score ${score}% (minimum ${checks.mutation.minScore}%), ${m.killed + m.engine} of ${m.scored} mutants killed${never ? `, ${never} claims never failed` : ''}` });
          entry.reproduce.push(`node scripts/working-model.mjs check ${rel(file)} --mutate`);
        }
      }
      if (checks.fuzz.enabled) {
        const rep = fuzzModel(r.model, { seed: checks.fuzz.seed, cases: checks.fuzz.cases, now: () => performance.now() });
        const bad = rep.failures.length + rep.limits.length;
        const status = bad ? (checks.fuzz.strict ? 'fail' : 'inconclusive') : 'pass';
        entry.checks.push({ name: 'fuzz', status, detail: `${rep.casesChecked} cases, seed ${checks.fuzz.seed}: ${rep.failures.length} failing, ${rep.limits.length} hit a limit${rep.firstFailure ? `; first: case ${rep.firstFailure.caseIndex}, claim ${rep.firstFailure.claimId}` : ''}${checks.fuzz.strict ? '' : ' (not strict)'}` });
        if (rep.firstFailure) entry.counterexample = digestOf({ claim: rep.firstFailure.claimId, params: rep.firstFailure.case.params, events: rep.firstFailure.case.events });
        entry.reproduce.push(`node scripts/working-model.mjs fuzz ${rel(file)} --cases ${checks.fuzz.cases} --seed ${checks.fuzz.seed}`);
      }
      const reality = spec.reality && spec.reality.mapping && spec.reality.observedTrace;
      if (checks.reality.enabled) {
        if (!reality) entry.checks.push({ name: 'reality', status: 'skipped', detail: 'the spec names no mapping and observed trace (reality block)' });
        else {
          try {
            const { report } = checkWithTrace(file, { trace: true, probe: false, strictObserved: checks.reality.strictObserved });
            const oa = report.observedAssertions;
            let status = report.status === 'error' ? 'error' : report.status;
            if (status === 'inconclusive' && checks.reality.strictObserved) status = 'fail';
            entry.checks.push({ name: 'reality', status, detail: `observed ${oa.passed} pass, ${oa.failed} fail, ${oa.inconclusive} inconclusive (completeness ${report.completeness}${checks.reality.strictObserved ? ', strict' : ''})` });
            entry.firstMismatch = report.firstMismatch;
            entry.assumptions = report.assumptions;
            entry.digests.mapping = report.mappingDigest;
            entry.digests.trace = report.traceDigest;
            entry.reproduce.push(`node scripts/working-model.mjs check ${rel(file)} --trace`);
          } catch (e) {
            entry.checks.push({ name: 'reality', status: 'error', detail: `${e.code || 'E_INTERNAL'} ${e.message}` });
          }
        }
      }
      if (checks.parity.enabled) {
        if (!reality) entry.checks.push({ name: 'parity', status: 'skipped', detail: 'no observed trace to compare in the browser' });
        else {
          try { entry.checks.push({ name: 'parity', ...(await parityCheck(file, browserBox)) }); } catch (e) { entry.checks.push({ name: 'parity', status: 'skipped', detail: `the browser could not run: ${String(e.message).slice(0, 160)}` }); }
        }
      }
      if (spec.reality && spec.reality.mapping) { try { resolveSpecPath(file, spec.reality.mapping, 'reality.mapping'); } catch (e) { entry.checks.push({ name: 'reality-paths', status: 'error', detail: e.message }); } }
      models.push(entry);
    }
  } finally {
    if (browserBox.browser) await browserBox.browser.close();
  }
  const agg = aggregate(models);
  const report = {
    schemaVersion: 1, kind: 'working-model-ci-report', engineVersion: ENGINE_VERSION, status: agg.status, counts: agg.counts,
    thresholds: checks, models,
  };
  if (opts.base) report.changes = diffAgainst(readJSONFile(opts.base, 'the base report'), models);
  return { report, config };
}

export async function ciCommand(args, c) {
  try {
    const { report, config } = await runCi(args._[1], { config: args.config, base: args.base });
    const outputs = config.output || {};
    const md = toMarkdown(report);
    const junit = toJUnit(report);
    const json = canonicalPretty(report);
    if (outputs.json) writeText(outputs.json, json);
    if (outputs.markdown) writeText(outputs.markdown, md);
    if (outputs.junit) writeText(outputs.junit, junit);
    const format = args.format || (args.json ? 'json' : 'markdown');
    if (format === 'json') process.stdout.write(json);
    else if (format === 'junit') process.stdout.write(junit);
    else if (format === 'markdown') process.stdout.write(md);
    else throw new TraceError('E_USAGE', `unknown --format "${format}"`, '--format', 'use json, markdown or junit');
    return report.status === 'fail' ? RX.FAIL : RX.OK;
  } catch (e) {
    return printError(e, args, c);
  }
}
