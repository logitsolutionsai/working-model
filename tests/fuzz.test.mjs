// Fuzz and minimize: seeded and reproducible, shrinking keeps the same
// failing claim, vacuous claims are flagged, limits are inconclusive, and
// mutation testing is untouched.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileModel } from '../src/engine/model.mjs';
import { fuzzModel, generateCase, evaluateCase, caseModel } from '../src/fuzz/fuzz.mjs';
import { shrinkCase } from '../src/fuzz/shrink.mjs';
import { mutateClaims } from '../src/engine/mutate.mjs';
import { checkClaims } from '../src/engine/claims.mjs';
import { counterSpec } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'working-model.mjs');
const SPEC = path.join(ROOT, 'examples', 'reality-bridge', 'circuit-breaker.model.json');

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function compile(spec) {
  const { model, errors } = compileModel(spec);
  assert.deepEqual(errors.map((e) => e.code), []);
  return model;
}
const demo = () => compile(JSON.parse(fs.readFileSync(SPEC, 'utf8')));

describe('fuzz', () => {
  test('case 0 is the defaults; the same seed gives the same cases, another seed other ones', () => {
    const m = demo();
    const c0 = generateCase(m, 7, 0);
    assert.deepEqual(c0.params, { threshold: 5, cooldown: 4 });
    assert.deepEqual(c0.events, []);
    const a = Array.from({ length: 20 }, (_, i) => JSON.stringify(generateCase(m, 7, i)));
    const b = Array.from({ length: 20 }, (_, i) => JSON.stringify(generateCase(m, 7, i)));
    const c = Array.from({ length: 20 }, (_, i) => JSON.stringify(generateCase(m, 8, i)));
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });

  test('a case never touches the original model and never invents an event', () => {
    const m = demo();
    const before = m.events.map((e) => [e.name, e.index]);
    for (let i = 1; i < 30; i++) {
      const cm = caseModel(m, generateCase(m, 3, i));
      for (const e of cm.events) assert.ok(m.eventNames.has(e.name));
    }
    assert.deepEqual(m.events.map((e) => [e.name, e.index]), before);
    assert.equal(checkClaims(m, {}).passed, 4);
  });

  test('the same seed and budget write byte-identical failure cases', () => {
    const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), 'wm-fz-')), fs.mkdtempSync(path.join(os.tmpdir(), 'wm-fz-'))];
    for (const d of dirs) assert.equal(cli(['fuzz', SPEC, '--cases', '120', '--seed', '7', '--out', d]).code, 0);
    const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
    assert.equal(read(dirs[0], 'first-failure.json'), read(dirs[1], 'first-failure.json'));
    assert.equal(read(dirs[0], 'fuzz-report.json'), read(dirs[1], 'fuzz-report.json'));
    // --strict makes a failure exit 1
    assert.equal(cli(['fuzz', SPEC, '--cases', '120', '--seed', '7', '--out', dirs[0], '--strict']).code, 1);
    // minimize twice: same bytes, same claim, and the saved case still fails
    const outs = dirs.map((d) => path.join(d, 'min.json'));
    for (let i = 0; i < 2; i++) assert.equal(cli(['minimize', SPEC, '--case', path.join(dirs[i], 'first-failure.json'), '--out', outs[i]]).code, 0);
    assert.equal(fs.readFileSync(outs[0], 'utf8'), fs.readFileSync(outs[1], 'utf8'));
    const first = JSON.parse(read(dirs[0], 'first-failure.json'));
    const min = JSON.parse(fs.readFileSync(outs[0], 'utf8'));
    assert.equal(min.failure.claimId, first.failure.claimId);
    assert.equal(min.evidenceType, 'simulated');
    assert.ok(min.shrink.checks <= 200);
    assert.equal(cli(['fuzz', SPEC, '--case', outs[0]]).code, 1);
  });

  test('shrinking keeps the same failing claim and never edits the claims', () => {
    const m = demo();
    const claimsBefore = JSON.stringify(m.spec.claims);
    let start = null;
    for (let i = 1; i < 200 && !start; i++) {
      const c = generateCase(m, 11, i);
      const { first } = evaluateCase(m, c);
      if (first && first.failure && c.events.length >= 2) start = { c, id: first.failure.claimId };
    }
    assert.ok(start, 'expected a failing case with several perturbations');
    const res = shrinkCase(m, start.c, start.id, { budget: 200 });
    assert.equal(res.failure.claimId, start.id);
    assert.ok(res.case.events.length <= start.c.events.length);
    const again = evaluateCase(m, res.case, { claimId: start.id });
    assert.equal(again.first.failure.claimId, start.id);
    assert.equal(JSON.stringify(m.spec.claims), claimsBefore);
    // a budget of 0 stops at once and says so
    assert.equal(shrinkCase(m, start.c, start.id, { budget: 0 }).shrink.stopReason, start.c.events.length || Object.keys(start.c.params).length ? 'budget-exhausted' : 'local-minimum-under-budget');
    assert.throws(() => shrinkCase(m, generateCase(m, 11, 0), start.id), (e) => e.code === 'E_CASE_DOES_NOT_FAIL');
  });

  test('a claim whose trigger never happens is reported as vacuous, not as proof', () => {
    const m = compile(counterSpec({ claims: [{ id: 'quiet', kind: 'whenever', event: 'pong', expr: 'n < 0', text: 'Never.' }], narration: [], events: [{ name: 'ping', at: [2] }], rules: { tick: 'n += step', on: { ping: "if n > 1000 { emit('pong', n) }" } } }));
    const rep = fuzzModel(m, { seed: 1, cases: 25 });
    assert.ok(rep.warnings.some((w) => w.code === 'W_VACUOUS_CLAIM' && w.claimId === 'quiet'));
    assert.equal(rep.casesChecked, 25);
    assert.match(rep.note, /not a proof/);
  });

  test('a case that hits the step limit is inconclusive, never a pass', () => {
    const m = compile(counterSpec({ params: [{ id: 'step', label: 'Step', min: 1, max: 5, step: 1, default: 1 }], rules: { tick: 'if step == 5 { while true { n += 0 } }\nn += step' }, limits: { steps: 1000 } }));
    const rep = fuzzModel(m, { seed: 2, cases: 40 });
    assert.ok(rep.limits.length > 0);
    assert.ok(rep.warnings.some((w) => w.code === 'W_FUZZ_LIMIT'));
    const s = rep.claims.find((c) => c.id === 'grows');
    assert.ok(s.errors > 0);
  });

  test('case caps: 2000 unless --unsafe-large', () => {
    const m = demo();
    assert.throws(() => fuzzModel(m, { cases: 2001 }), (e) => e.code === 'E_FUZZ_LIMIT');
    assert.throws(() => fuzzModel(m, { cases: 0 }), (e) => e.code === 'E_USAGE');
    assert.throws(() => fuzzModel(compile({ ...JSON.parse(fs.readFileSync(SPEC, 'utf8')), fuzz: { events: { nope: { fuzzable: true } } } }), { cases: 1 }), (e) => e.code === 'E_FUZZ_UNKNOWN_EVENT');
  });

  test('fuzz leaves mutation testing as it was', () => {
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
    const a = mutateClaims(compile(spec), {});
    fuzzModel(compile(spec), { seed: 7, cases: 50 });
    const b = mutateClaims(compile(spec), {});
    const strip = (r) => JSON.stringify({ ...r, ms: 0, mutants: r.mutants.map((x) => ({ ...x, ms: 0 })) });
    assert.equal(strip(a), strip(b));
    const { fuzz, ...noFuzz } = spec;
    assert.ok(fuzz);
    const c = mutateClaims(compile(noFuzz), {});
    assert.equal(c.score, a.score, 'the fuzz block must not change the mutation score');
  });

  test('250 small cases run well inside the 30 s target', () => {
    const t0 = performance.now();
    const rep = fuzzModel(demo(), { seed: 7, cases: 250, now: () => performance.now() });
    assert.equal(rep.casesChecked, 250);
    assert.ok(performance.now() - t0 < 30000);
  });
});
