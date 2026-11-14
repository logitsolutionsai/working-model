// Seeded scenario fuzzing: run the model's own claims on many generated
// cases (slider values, the model seed, and perturbations of the events the
// spec's optional "fuzz" block marks fuzzable). It complements `sweep`
// claims and `check --mutate`; it changes neither. "No failure found" is
// not a proof: the report says how many cases were sampled and how.
//
// Generator "mulberry32-v1": the engine's seeded generator, seeded with
// hashSeed("fuzz:" + seed). Case 0 is always the defaults.
// Pure module: no Node or browser APIs (timing comes from opts.now).

import { makeRng, hashSeed } from '../engine/rng.mjs';
import { checkClaims } from '../engine/claims.mjs';
import { snapToStep } from '../engine/model.mjs';
import { showValue } from '../engine/compile.mjs';
import { TraceError } from '../trace/errors.mjs';

export const FUZZ_GENERATOR = 'mulberry32-v1';
export const FUZZ_LIMITS = { defaultCases: 100, maxCases: 2000, hardCases: 20000, timeoutMs: 120000, shrinkBudget: 200, stratifyAbove: 1000 };

function gridSize(p) { return Math.round((p.max - p.min) / p.step) + 1; }
function gridValue(p, i) { return snapToStep(p.min + i * p.step, p); }

// The fuzzable spec events: [{ index, name, cfg, mode }]
export function fuzzableEvents(model) {
  const cfg = (model.spec && model.spec.fuzz && model.spec.fuzz.events) || {};
  const out = [];
  for (const ev of model.events) {
    const c = cfg[ev.name];
    if (c && c.fuzzable === true) out.push({ index: ev.index, name: ev.name, cfg: c, mode: ev.mode });
  }
  return out;
}

export function validateFuzzBlock(model) {
  const cfg = (model.spec && model.spec.fuzz && model.spec.fuzz.events) || {};
  for (const name of Object.keys(cfg)) {
    if (!model.eventNames.has(name)) throw new TraceError('E_FUZZ_UNKNOWN_EVENT', `fuzz.events names "${name}", which is not a model event; fuzz never invents events`, `fuzz.events.${name}`, `model events: ${[...model.eventNames].join(', ') || 'none'}`);
    const c = cfg[name];
    if (c.count && c.count[0] > c.count[1]) throw new TraceError('E_FUZZ_SCHEMA', `fuzz.events.${name}.count must be [smallest, largest]`, `fuzz.events.${name}.count`, null);
  }
}

// One generated case. Case 0 is the defaults with no perturbation.
export function generateCase(model, seed, caseIndex) {
  const params = {};
  for (const p of model.params) params[p.id] = p.default;
  const c = { caseIndex, seed: model.seed, params, events: [] };
  if (caseIndex === 0) return c;
  const rng = makeRng(hashSeed(`fuzz:${seed}:${caseIndex}`));
  for (const p of model.params) {
    const n = gridSize(p);
    if (n > FUZZ_LIMITS.stratifyAbove) {
      // stratified: min, max and default first, then seeded interior points
      const pick = caseIndex % 4;
      params[p.id] = pick === 1 ? p.min : pick === 2 ? p.max : pick === 3 ? p.default : gridValue(p, 1 + Math.floor(rng() * (n - 2)));
    } else {
      params[p.id] = gridValue(p, Math.floor(rng() * n));
    }
  }
  if (rng() < 0.25) c.seed = Math.floor(rng() * 1e6);
  for (const f of fuzzableEvents(model)) {
    if (rng() < 0.5) continue; // leave this event as the spec has it
    const pert = { index: f.index, name: f.name };
    if (f.cfg.omit && rng() < 0.2) pert.omit = true;
    else {
      if (f.cfg.shift > 0 && f.mode !== 'rate') {
        const steps = Math.round(f.cfg.shift / model.dt);
        const k = Math.floor(rng() * (2 * steps + 1)) - steps;
        if (k) pert.shift = Math.round(k * model.dt * 1e9) / 1e9;
      }
      if (f.cfg.count) pert.count = f.cfg.count[0] + Math.floor(rng() * (f.cfg.count[1] - f.cfg.count[0] + 1));
    }
    if (pert.omit || pert.shift != null || pert.count != null) c.events.push(pert);
  }
  return c;
}

// A compiled-model copy that runs this case: other seed, perturbed events.
// The original model is never changed.
export function caseModel(model, c) {
  const byIndex = new Map(c.events.map((e) => [e.index, e]));
  const events = [];
  for (const ev of model.events) {
    const p = byIndex.get(ev.index);
    if (!p) { events.push(ev); continue; }
    if (p.omit) continue;
    const e = { ...ev };
    if (p.count != null) { const n = p.count; e.count = () => n; }
    if (p.shift) {
      const s = p.shift;
      if (ev.mode === 'at' && ev.atList) e.atList = ev.atList.map((x) => x + s);
      else if (ev.mode === 'at') { const f = ev.at; e.at = (env) => f(env) + s; }
      else if (ev.mode === 'every') { const f = ev.from; e.from = f ? (env) => f(env) + s : () => s; if (ev.until) { const u = ev.until; e.until = (env) => u(env) + s; } }
    }
    events.push(e);
  }
  return { ...model, seed: c.seed, events };
}

function firstFailure(model, res) {
  for (const r of res.results) {
    if (r.status === 'error' && r.error && /LIMIT/.test(r.error.code)) return { limit: r };
  }
  for (const r of res.results) {
    if (!r.pass && r.status === 'fail') {
      const cx = r.counterexample || {};
      const sc = ((model.spec && model.spec.claims) || []).find((x) => x.id === r.id);
      const tick = cx.tick != null ? cx.tick : cx.t != null ? Math.round(cx.t / model.dt) : null;
      return {
        failure: {
          claimId: r.id, kind: r.kind, firstTick: tick,
          observed: Object.entries(cx.values || {}).map(([k, v]) => `${k}=${showValue(v)}`).join(', ') || null,
          expected: sc ? (sc.expr || (sc.claim && sc.claim.expr) || sc.kind) : null,
          line: r.line || null,
        },
      };
    }
    if (r.status === 'error') return { error: r };
  }
  return null;
}

export function evaluateCase(model, c, opts = {}) {
  const m = caseModel(model, c);
  const only = opts.claimId ? { ...m, claims: m.claims.filter((x) => x.id === opts.claimId) } : m;
  const res = checkClaims(only, c.params);
  return { res, first: firstFailure(only, res) };
}

// opts: { seed, cases, now(), timeoutMs, unsafeLarge }
export function fuzzModel(model, opts = {}) {
  validateFuzzBlock(model);
  const seed = opts.seed == null ? 1 : opts.seed;
  let cases = opts.cases == null ? FUZZ_LIMITS.defaultCases : Number(opts.cases);
  if (!Number.isInteger(cases) || cases < 1) throw new TraceError('E_USAGE', '--cases must be a positive whole number', '--cases', null);
  const cap = opts.unsafeLarge ? FUZZ_LIMITS.hardCases : FUZZ_LIMITS.maxCases;
  if (cases > cap) throw new TraceError('E_FUZZ_LIMIT', `--cases ${cases} is above ${cap}`, '--cases', opts.unsafeLarge ? `use at most ${FUZZ_LIMITS.hardCases}` : 'pass --unsafe-large to allow up to ' + FUZZ_LIMITS.hardCases);
  const now = opts.now || (() => 0);
  const timeoutMs = opts.timeoutMs || FUZZ_LIMITS.timeoutMs;
  const t0 = now();
  const perClaim = new Map(model.claims.map((c) => [c.id, { id: c.id, kind: c.kind, cases: 0, passed: 0, failed: 0, errors: 0, exercised: 0, firstFailingCase: null }]));
  const paramSeen = new Map(model.params.map((p) => [p.id, new Set()]));
  const failures = [];
  const limits = [];
  let checked = 0;
  let stopReason = 'cases-done';
  let perturbedCases = 0;
  for (let i = 0; i < cases; i++) {
    if (now() - t0 > timeoutMs) { stopReason = 'timeout'; break; }
    const c = generateCase(model, seed, i);
    if (c.events.length) perturbedCases++;
    for (const p of model.params) paramSeen.get(p.id).add(c.params[p.id]);
    const { res, first } = evaluateCase(model, c);
    checked++;
    for (const r of res.results) {
      const s = perClaim.get(r.id);
      s.cases++;
      if (r.pass) s.passed++;
      else if (r.status === 'fail') { s.failed++; if (s.firstFailingCase == null) s.firstFailingCase = i; } else s.errors++;
      const vacuous = r.kind === 'whenever' && r.stats && r.stats.fired === 0;
      const vacuousSweep = r.kind === 'sweep' && r.stats && r.stats.inside === 0;
      if (!vacuous && !vacuousSweep) s.exercised++;
    }
    if (first && first.limit) limits.push({ caseIndex: i, claimId: first.limit.id, code: first.limit.error.code });
    if (first && first.failure) failures.push({ caseIndex: i, ...first.failure, case: c });
  }
  const warnings = [];
  for (const s of perClaim.values()) {
    if (s.cases && s.exercised === 0) warnings.push({ code: 'W_VACUOUS_CLAIM', claimId: s.id, message: `claim "${s.id}" was never exercised in ${s.cases} sampled cases (its trigger never happened), so passing it says nothing` });
    if (s.cases && s.failed === 0 && s.errors === 0) warnings.push({ code: 'W_NEVER_FAILED_IN_FUZZ', claimId: s.id, message: `claim "${s.id}" passed in every sampled case; that is not a proof, and it may be too weak to fail (check --mutate tells you more)` });
  }
  if (limits.length) warnings.push({ code: 'W_FUZZ_LIMIT', message: `${limits.length} case${limits.length === 1 ? '' : 's'} hit a step or trace limit; those cases are inconclusive, not passes` });
  return {
    schemaVersion: 1, kind: 'working-model-fuzz-report', generator: FUZZ_GENERATOR, seed, casesRequested: cases, casesChecked: checked, stopReason,
    elapsedMs: Math.round(now() - t0),
    sampling: {
      caseZero: 'defaults, no perturbation',
      params: model.params.map((p) => ({ id: p.id, choices: gridSize(p), method: gridSize(p) > FUZZ_LIMITS.stratifyAbove ? 'stratified: min, max, default, seeded interior' : 'uniform over the slider grid', distinctSampled: paramSeen.get(p.id).size })),
      fuzzableEvents: fuzzableEvents(model).map((f) => ({ index: f.index, name: f.name, ...f.cfg })),
      perturbedCases,
      modelSeedVaried: 'in about a quarter of the cases',
    },
    claims: [...perClaim.values()],
    failures: failures.map((f) => ({ caseIndex: f.caseIndex, claimId: f.claimId, firstTick: f.firstTick })),
    firstFailure: failures.length ? failures[0] : null,
    limits,
    warnings,
    note: 'No failure found is not a proof of correctness; it covers only the sampled cases.',
  };
}
