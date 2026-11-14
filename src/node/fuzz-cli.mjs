// `fuzz` and `minimize`: seeded scenario exploration and deterministic
// shrinking. Writes canonical JSON, so the same seed and budget always give
// the same bytes.

import path from 'node:path';
import { checkFile } from './check.mjs';
import { RX, digestOf, readJSONFile, writeText } from './reality.mjs';
import { printError } from './reality-cli.mjs';
import { TraceError, canonicalPretty } from '../trace/errors.mjs';
import { fuzzModel, evaluateCase, FUZZ_GENERATOR } from '../fuzz/fuzz.mjs';
import { shrinkCase } from '../fuzz/shrink.mjs';
import { ENGINE_VERSION } from '../engine/index.mjs';

function loadModel(file) {
  const r = checkFile(file, { probe: false });
  if (r.errors.length) {
    const e = r.errors[0];
    const err = new TraceError(e.code, `the model is invalid: ${e.message}`, e.path || file, 'run check to see every error');
    err.report = r;
    throw err;
  }
  return r;
}

function rel(p) {
  const s = (path.relative(process.cwd(), p) || p).split(path.sep).join('/');
  return /[\s"']/.test(s) ? JSON.stringify(s) : s;
}

export function counterexampleFile(spec, specFile, fuzzSeed, c, failure, shrink) {
  return {
    schemaVersion: 1,
    kind: 'working-model-counterexample',
    evidenceType: 'simulated',
    modelDigest: digestOf(spec),
    engineVersion: ENGINE_VERSION,
    generator: FUZZ_GENERATOR,
    seed: fuzzSeed,
    caseIndex: c.caseIndex,
    modelSeed: c.seed,
    params: c.params,
    events: c.events,
    failure,
    ...(shrink ? { shrink } : {}),
    replay: `node scripts/working-model.mjs fuzz ${rel(specFile)} --case <this file>`,
    note: 'A simulated counterexample: the model, not an observed system, fails this claim under these conditions.',
  };
}

function loadCase(file, spec) {
  const c = readJSONFile(file, 'the case');
  if (!c || c.kind !== 'working-model-counterexample' || c.schemaVersion !== 1) throw new TraceError('E_CASE_SCHEMA', 'not a working-model counterexample (schemaVersion 1)', file, 'pass a file written by fuzz or minimize');
  if (c.modelDigest !== digestOf(spec)) throw new TraceError('E_CASE_MODEL', 'the case was written for a different version of this model (the model digest differs)', file, 'run fuzz again on the current model');
  if (!c.params || typeof c.params !== 'object' || !Array.isArray(c.events)) throw new TraceError('E_CASE_SCHEMA', 'the case needs "params" and "events"', file, null);
  if (!c.failure || typeof c.failure.claimId !== 'string') throw new TraceError('E_CASE_SCHEMA', 'the case needs "failure.claimId"', file, null);
  return { caseIndex: c.caseIndex, seed: c.modelSeed, params: c.params, events: c.events, fuzzSeed: c.seed, claimId: c.failure.claimId };
}

export async function fuzzCommand(args, c) {
  const file = args._[1];
  if (!file) { process.stderr.write('fuzz needs a spec file\n'); return RX.USAGE; }
  try {
    const r = loadModel(file);
    if (args.case) {
      const kase = loadCase(args.case, r.spec);
      const { first } = evaluateCase(r.model, kase, { claimId: kase.claimId });
      const fails = !!(first && first.failure && first.failure.claimId === kase.claimId);
      const out = { ok: !fails, claimId: kase.claimId, stillFails: fails, failure: fails ? first.failure : null };
      if (args.json) console.log(JSON.stringify(out, null, 2));
      else console.log(fails ? `${c.red('still fails')} ${kase.claimId}: ${first.failure.line || ''}` : `${c.green('passes')} ${kase.claimId} on this case`);
      return fails ? RX.FAIL : RX.OK;
    }
    const seed = args.seed == null ? 1 : (/^\d+$/.test(String(args.seed)) ? Number(args.seed) : String(args.seed));
    const rep = fuzzModel(r.model, { seed, cases: args.cases == null ? undefined : Number(args.cases), unsafeLarge: !!args.unsafeLarge, now: () => performance.now() });
    const outDir = args.out || path.join('.working-model', 'fuzz');
    rep.modelDigest = digestOf(r.spec);
    rep.engineVersion = ENGINE_VERSION;
    rep.reproduce = `node scripts/working-model.mjs fuzz ${rel(file)} --cases ${rep.casesRequested} --seed ${seed}`;
    const firstFile = path.join(outDir, 'first-failure.json');
    if (rep.firstFailure) {
      const f = rep.firstFailure;
      const { case: kase, ...failure } = f;
      delete failure.caseIndex;
      writeText(firstFile, canonicalPretty(counterexampleFile(r.spec, file, seed, kase, failure, null)));
      rep.firstFailureFile = 'first-failure.json'; // next to this report
      rep.firstFailure = { caseIndex: f.caseIndex, claimId: f.claimId, firstTick: f.firstTick };
    }
    const elapsed = rep.elapsedMs;
    delete rep.elapsedMs; // keep the report bytes deterministic; timing goes to the terminal only
    writeText(path.join(outDir, 'fuzz-report.json'), canonicalPretty(rep));
    if (args.json) console.log(JSON.stringify({ ...rep, elapsedMs: elapsed }, null, 2));
    else {
      console.log(c.bold(`${r.model.title}: ${rep.casesChecked} cases (seed ${seed}, ${FUZZ_GENERATOR}, ${elapsed} ms)`));
      for (const s of rep.claims) console.log(`  ${(s.failed ? c.red : c.green)(s.id.padEnd(24))} ${s.passed} pass, ${s.failed} fail, ${s.errors} error${s.firstFailingCase != null ? c.dim(`  first failing case ${s.firstFailingCase}`) : ''}`);
      for (const w of rep.warnings) console.log(`  ${c.yellow(w.code)} ${w.message}`);
      if (rep.firstFailure) console.log(`  first failure: case ${rep.firstFailure.caseIndex}, claim ${rep.firstFailure.claimId} -> ${firstFile}`);
      console.log(c.dim(rep.failures.length ? `  These ${rep.casesChecked} cases are a sample; conditions outside it were not tried.` : `  ${rep.note}`));
    }
    const bad = rep.failures.length || rep.limits.length;
    return args.strict && bad ? RX.FAIL : RX.OK;
  } catch (e) {
    return printError(e, args, c);
  }
}

export async function minimizeCommand(args, c) {
  const file = args._[1];
  if (!file || !args.case) { process.stderr.write('minimize needs a spec file and --case first-failure.json\n'); return RX.USAGE; }
  try {
    const r = loadModel(file);
    const kase = loadCase(args.case, r.spec);
    const budget = args.shrinkBudget == null ? 200 : Number(args.shrinkBudget);
    const res = shrinkCase(r.model, kase, kase.claimId, { budget });
    const out = args.out || path.join('.working-model', 'minimized.json');
    const doc = counterexampleFile(r.spec, file, kase.fuzzSeed, { ...res.case, caseIndex: kase.caseIndex }, res.failure, res.shrink);
    writeText(out, canonicalPretty(doc));
    if (args.json) console.log(JSON.stringify({ ...doc, out }, null, 2));
    else {
      console.log(`${c.green('minimized')} ${kase.claimId} in ${res.shrink.checks} checks (${res.shrink.stopReason}) -> ${out}`);
      console.log(`  params: ${Object.entries(res.case.params).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      console.log(`  events: ${res.case.events.length ? res.case.events.map((e) => `${e.name}#${e.index}${e.omit ? ' omitted' : ''}${e.count != null ? ' count ' + e.count : ''}${e.shift ? ' shift ' + e.shift : ''}`).join('; ') : 'as in the spec'}`);
      if (res.failure.line) console.log(`  ${res.failure.line}`);
    }
    return RX.OK;
  } catch (e) {
    return printError(e, args, c);
  }
}
