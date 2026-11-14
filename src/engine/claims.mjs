// Claim checking. Every claim becomes a test against one or more simulated
// runs, and a failing claim carries its first counterexample: the time, the
// values it depends on, and the params of the run.

import { ModelError, errorToJSON } from './errors.mjs';
import { simulate, resolveParams, snapshotEnv, makeBudget } from './simulate.mjs';
import { makeRng, hashSeed } from './rng.mjs';
import { snapToStep } from './model.mjs';
import { formatValue, autoNumber, unitFor } from './format.mjs';
import { kindOf, deepCopy } from './compile.mjs';

const EPS = 1e-9;

function paramEnv(model, P) {
  return { S: Object.create(null), P, L: [], t: 0, dt: model.dt, tick: 0, seq: 0, batch: 0, payload: null, rng: () => 0, steps: 0, maxSteps: 1e6, kinds: null, emit: null, cmp: null };
}

function timeOf(fn, model, P, path) {
  const v = fn(paramEnv(model, P));
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ModelError('E_CLAIM_TIME', `a claim time must be a number, got ${String(v)}`, { path });
  return v;
}

function tickAt(model, time, path, mode) {
  const x = time / model.dt;
  const k = mode === 'floor' ? Math.floor(x + EPS) : mode === 'ceil' ? Math.ceil(x - EPS) : Math.round(x);
  if (k < 0 || k > model.K) throw new ModelError('E_CLAIM_TIME', `time ${autoNumber(time)} is outside the run (0 to ${autoNumber(model.duration)})`, { path });
  return k;
}

function asBool(v, claim) {
  if (typeof v !== 'boolean') {
    throw new ModelError('E_CLAIM_NOT_BOOLEAN', `the claim expression must be true or false, got ${kindOf(v)} ${formatValue(v)}`, { path: claim.path + '.expr' });
  }
  return v;
}

// Values of the state, derived and param names an expression refers to.
function refValues(model, env, refs) {
  const out = {};
  if (!refs) return out;
  for (const name of refs) {
    if (model.stateNames.includes(name)) out[name] = deepCopy(env.S[name]);
    else if (model.derivedGetters.has(name)) {
      try { out[name] = model.derivedGetters.get(name)(env); } catch { out[name] = null; }
    } else if (model.paramIds.has(name)) out[name] = env.P[name];
  }
  return out;
}

function counterexample(model, env, refs, extra) {
  return Object.assign({ t: env.t, tick: env.tick, values: refValues(model, env, refs), params: { ...env.P } }, extra || {});
}

// ---- watchers: whenever claims need to look at the run while it happens ----

function makeWatcher(model, claim, P) {
  const st = { fired: 0, failed: null, pending: [], inconclusive: 0, error: null };
  const within = claim.within ? timeOf(claim.within, model, P, claim.path + '.within') : null;
  const observer = {
    names: new Set([claim.event]),
    onFire(env, info) {
      if (st.failed || st.error) return;
      st.fired++;
      if (within == null) {
        try {
          const ok = asBool(claim.expr(env), claim);
          if (!ok) {
            st.failed = counterexample(model, env, claim.expr.refs, { event: info.name, payload: deepCopy(info.payload) });
          }
        } catch (e) { if (e instanceof ModelError) st.error = e; else throw e; }
      } else {
        st.pending.push({ firedAt: env.t, deadline: env.t + within, payload: deepCopy(info.payload) });
      }
    },
  };
  const onSnapshot = (env) => {
    if (within == null || st.failed || st.error || !st.pending.length) return;
    let ok;
    try { ok = asBool(claim.expr(env), claim); } catch (e) { if (e instanceof ModelError) { st.error = e; return; } throw e; }
    if (ok) { st.pending = []; return; }
    const late = st.pending.find((p) => env.t >= p.deadline - EPS);
    if (late) {
      st.failed = counterexample(model, env, claim.expr.refs, { event: claim.event, firedAt: late.firedAt, deadline: late.deadline });
    }
  };
  const finish = () => {
    if (st.error) return { pass: false, status: 'error', error: st.error };
    if (st.failed) return { pass: false, status: 'fail', counterexample: st.failed, stats: { fired: st.fired } };
    const open = st.pending.filter((p) => p.deadline > model.duration + EPS).length;
    return { pass: true, status: 'pass', stats: { fired: st.fired, unresolved: open } };
  };
  return { observer, onSnapshot, finish };
}

// Run one simulation and evaluate the given (non-sweep, non-compare) claims on it.
export function evaluateOnRun(model, overrides, claims, opts = {}) {
  const P = resolveParams(model, overrides);
  const watchers = new Map();
  const observers = [];
  const snapHooks = [];
  const early = new Map();
  for (const c of claims) {
    if (c.kind !== 'whenever') continue;
    try {
      const w = makeWatcher(model, c, P);
      watchers.set(c, w);
      observers.push(w.observer);
      snapHooks.push(w.onSnapshot);
    } catch (e) {
      if (e instanceof ModelError) early.set(c, { pass: false, status: 'error', error: e });
      else throw e;
    }
  }
  const trace = opts.trace && !observers.length ? opts.trace : simulate(model, overrides, {
    budget: opts.budget,
    observers,
    onSnapshot: snapHooks.length ? (env, k) => { for (const h of snapHooks) h(env, k); } : null,
  });
  const results = new Map();
  for (const c of claims) {
    if (early.has(c)) { results.set(c, early.get(c)); continue; }
    if (trace.error) { results.set(c, { pass: false, status: 'error', error: trace.error }); continue; }
    try {
      results.set(c, watchers.has(c) ? watchers.get(c).finish() : evaluateOnTrace(model, trace, c));
    } catch (e) {
      if (e instanceof ModelError) results.set(c, { pass: false, status: 'error', error: e });
      else throw e;
    }
  }
  return { trace, results };
}

function evaluateOnTrace(model, trace, c) {
  const P = trace.params;
  const K = trace.K;
  switch (c.kind) {
    case 'at': {
      const time = timeOf(c.t, model, P, c.path + '.t');
      const k = tickAt(model, time, c.path + '.t', 'round');
      const env = snapshotEnv(trace, k);
      const ok = asBool(c.expr(env), c);
      return ok ? { pass: true, status: 'pass', stats: { t: env.t } } : { pass: false, status: 'fail', counterexample: counterexample(model, env, c.expr.refs) };
    }
    case 'always':
    case 'never': {
      const k0 = c.from ? tickAt(model, timeOf(c.from, model, P, c.path + '.from'), c.path + '.from', 'ceil') : 0;
      const k1 = c.until ? tickAt(model, timeOf(c.until, model, P, c.path + '.until'), c.path + '.until', 'floor') : K;
      const want = c.kind === 'always';
      for (let k = k0; k <= k1; k++) {
        const env = snapshotEnv(trace, k);
        if (asBool(c.expr(env), c) !== want) {
          return { pass: false, status: 'fail', counterexample: counterexample(model, env, c.expr.refs) };
        }
      }
      return { pass: true, status: 'pass', stats: { ticks: Math.max(0, k1 - k0 + 1) } };
    }
    case 'eventually': {
      const k0 = c.from ? tickAt(model, timeOf(c.from, model, P, c.path + '.from'), c.path + '.from', 'ceil') : 0;
      const k1 = c.by ? tickAt(model, timeOf(c.by, model, P, c.path + '.by'), c.path + '.by', 'floor') : K;
      for (let k = k0; k <= k1; k++) {
        const env = snapshotEnv(trace, k);
        if (asBool(c.expr(env), c)) return { pass: true, status: 'pass', stats: { at: env.t } };
      }
      const env = snapshotEnv(trace, Math.max(k0, k1));
      return { pass: false, status: 'fail', counterexample: counterexample(model, env, c.expr.refs, { deadline: true }) };
    }
    default:
      throw new ModelError('E_CLAIM_KIND', `cannot evaluate a ${c.kind} claim on a single run`, { path: c.path });
  }
}

// ---- sweep ------------------------------------------------------------------

export function sweepSamples(model, claim, base) {
  const seed = claim.seed != null ? claim.seed : `${hashSeed(model.seed)}:${claim.id || claim.path}`;
  const rng = makeRng(seed);
  const n = claim.samples;
  const perms = claim.vary.map(() => {
    const a = [];
    for (let i = 0; i < n; i++) a.push(i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  });
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = { ...base };
    claim.vary.forEach((v, d) => {
      const u = (perms[d][i] + rng()) / n;
      const p = model.params.find((q) => q.id === v.id);
      s[v.id] = snapToStep(v.lo + u * (v.hi - v.lo), { ...p, min: p.min, max: p.max });
      s[v.id] = Math.min(v.hi, Math.max(v.lo, s[v.id]));
    });
    out.push(s);
  }
  return out;
}

function evaluateSweep(model, c, P, budget) {
  const samples = sweepSamples(model, c, { ...P });
  let inside = 0;
  let outside = 0;
  const varied = c.vary.map((v) => v.id);
  const pick = (s) => { const o = {}; for (const id of varied) o[id] = s[id]; return o; };
  for (const s of samples) {
    const { trace, results } = evaluateOnRun(model, s, [c.inner], { budget });
    const r = results.get(c.inner);
    if (r.status === 'error') {
      return { pass: false, status: 'fail', counterexample: { t: r.error.at ? r.error.at.t : null, sample: pick(s), params: s, error: errorToJSON(r.error), note: 'error' }, stats: { samples: samples.length } };
    }
    let holds = true;
    if (c.holdsWhen) {
      try { holds = asBool(c.holdsWhen(snapshotEnv(trace, 0)), { path: c.path + '.holdsWhen' }); } catch (e) {
        if (e instanceof ModelError) return { pass: false, status: 'error', error: e };
        throw e;
      }
    }
    if (holds) {
      inside++;
      if (!r.pass) return { pass: false, status: 'fail', counterexample: { ...r.counterexample, sample: pick(s), params: s, note: c.holdsWhen ? 'inside' : 'sample' }, stats: { samples: samples.length } };
    } else {
      outside++;
      if (r.pass) return { pass: false, status: 'fail', counterexample: { t: null, values: {}, sample: pick(s), params: s, note: 'outside' }, stats: { samples: samples.length } };
    }
  }
  if (c.holdsWhen && (inside === 0 || outside === 0)) {
    return { pass: false, status: 'fail', counterexample: { t: null, values: {}, params: { ...P }, note: inside === 0 ? 'none-inside' : 'none-outside' }, stats: { samples: samples.length, inside, outside } };
  }
  return { pass: true, status: 'pass', stats: { samples: samples.length, inside, outside } };
}

// ---- compare ----------------------------------------------------------------

export function measureRun(model, trace, m) {
  if (trace.error) throw trace.error;
  const K = trace.K;
  const val = (k) => {
    const v = m.of(snapshotEnv(trace, k));
    if (typeof v !== 'number') throw new ModelError('E_TYPE', `measure "${m.raw}" must be a number, got ${kindOf(v)}`, { path: 'measure.of' });
    return v;
  };
  switch (m.agg) {
    case 'final': return val(K);
    case 'at': return val(tickAt(model, timeOf(m.t, model, trace.params, 'measure.t'), 'measure.t', 'round'));
    default: {
      let acc = m.agg === 'max' ? -Infinity : m.agg === 'min' ? Infinity : 0;
      for (let k = 0; k <= K; k++) {
        const v = val(k);
        if (m.agg === 'max') acc = Math.max(acc, v);
        else if (m.agg === 'min') acc = Math.min(acc, v);
        else acc += v;
      }
      if (m.agg === 'mean') acc /= K + 1;
      return acc;
    }
  }
}

function evaluateCompare(model, c, P, budget) {
  const side = (runs) => {
    const o = { ...P };
    const env = paramEnv(model, P);
    for (const r of runs) {
      const v = r.fn(env);
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ModelError('E_TYPE', `override for "${r.id}" must be a number`, { path: c.path });
      o[r.id] = v;
    }
    return o;
  };
  const Pa = side(c.runs.a);
  const Pb = side(c.runs.b);
  const ta = simulate(model, Pa, { budget });
  const tb = simulate(model, Pb, { budget });
  const a = measureRun(model, ta, c.measure);
  const b = measureRun(model, tb, c.measure);
  const env = paramEnv(model, P);
  env.cmp = { a, b };
  const ok = asBool(c.expect(env), { path: c.path + '.expect' });
  const overA = {}; for (const r of c.runs.a) overA[r.id] = Pa[r.id];
  const overB = {}; for (const r of c.runs.b) overB[r.id] = Pb[r.id];
  const stats = { a, b, overridesA: overA, overridesB: overB };
  return ok ? { pass: true, status: 'pass', stats } : { pass: false, status: 'fail', counterexample: { t: null, a, b, overridesA: overA, overridesB: overB, params: { ...P } }, stats };
}

// ---- all claims -----------------------------------------------------------

// Returns { trace, results: [ { id, kind, pass, status, text, line, counterexample, error, stats } ], passed, total }
export function checkClaims(model, overrides, opts = {}) {
  const P = resolveParams(model, overrides);
  const budget = opts.budget || makeBudget();
  const simple = model.claims.filter((c) => c.kind !== 'sweep' && c.kind !== 'compare');
  const { trace, results } = evaluateOnRun(model, P, simple, { ...opts, budget });
  const out = [];
  for (const c of model.claims) {
    let r;
    try {
      if (c.kind === 'sweep') r = evaluateSweep(model, c, P, budget);
      else if (c.kind === 'compare') r = evaluateCompare(model, c, P, budget);
      else r = results.get(c);
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      r = { pass: false, status: 'error', error: e };
    }
    let text = c.raw;
    try { text = c.text ? c.text(paramEnv(model, P)) : c.raw; } catch { /* keep raw text */ }
    const res = { id: c.id, kind: c.kind, pass: r.pass, status: r.status, text };
    if (r.counterexample) res.counterexample = r.counterexample;
    if (r.error) res.error = errorToJSON(r.error);
    if (r.stats) res.stats = r.stats;
    res.line = r.pass ? '' : explain(model, c, res);
    out.push(res);
  }
  const passed = out.filter((r) => r.pass).length;
  return { trace, results: out, passed, total: out.length, params: P };
}

// ---- one-line explanations ------------------------------------------------

function fmtTime(model, t) {
  const u = model.timeUnit;
  return `t = ${autoNumber(Math.round(t * 1e6) / 1e6)}${u ? (u.length <= 3 ? ' ' + u : ' ' + u) : ''}`;
}

function fmtValues(values) {
  return Object.entries(values || {}).map(([k, v]) => `${k} = ${formatValue(v)}`).join(', ');
}

function fmtParams(model, ps) {
  return Object.entries(ps || {}).map(([k, v]) => {
    const p = model.params.find((q) => q.id === k);
    if (p && p.choices) return `${k} = ${p.choices[Math.round((v - p.min) / p.step)] || formatValue(v)}`;
    return `${k} = ${formatValue(v, p && p.format)}${p && p.unit && p.unit.length <= 6 && p.format !== '%' ? ' ' + unitFor(v, p.unit) : ''}`;
  }).join(', ');
}

export function explain(model, claim, res) {
  if (res.status === 'error') {
    const e = res.error;
    return `error ${e.code}: ${e.message}${e.path ? ' (' + e.path + (e.line ? ':' + e.line + ':' + e.col : '') + ')' : ''}`;
  }
  const ce = res.counterexample;
  if (!ce) return '';
  switch (claim.kind) {
    case 'at':
    case 'always':
    case 'never':
      return `fails at ${fmtTime(model, ce.t)}: ${fmtValues(ce.values) || 'the expression is false'}`;
    case 'eventually':
      return `still false at ${fmtTime(model, ce.t)}: ${fmtValues(ce.values)}`;
    case 'whenever':
      if (ce.deadline != null && ce.firedAt != null) {
        return `"${ce.event}" at ${fmtTime(model, ce.firedAt)} was not followed in time; at ${fmtTime(model, ce.t)}: ${fmtValues(ce.values)}`;
      }
      return `after "${ce.event}" at ${fmtTime(model, ce.t)}: ${[fmtValues(ce.values), ce.payload != null ? `payload = ${formatValue(ce.payload)}` : ''].filter(Boolean).join(', ') || 'the expression is false'}`;
    case 'sweep': {
      const at = fmtParams(model, ce.sample);
      if (ce.note === 'outside') return `at ${at} the claim still holds, although holdsWhen is false`;
      if (ce.note === 'none-inside') return 'no sampled params satisfy holdsWhen; widen the ranges';
      if (ce.note === 'none-outside') return 'every sampled param set satisfies holdsWhen, so its boundary is never tested; widen the ranges';
      if (ce.note === 'error') return `at ${at} the model fails: ${ce.error.code} ${ce.error.message}`;
      const inner = ce.t != null ? `${ce.deadline ? 'still false' : 'fails'} at ${fmtTime(model, ce.t)}: ${fmtValues(ce.values)}` : 'fails';
      return `at ${at}: ${inner}`;
    }
    case 'compare': {
      const m = claim.measure;
      const what = m.label || `${m.agg} of ${m.raw}`;
      return `${what}: a = ${formatValue(ce.a)} (${fmtParams(model, ce.overridesA)}), b = ${formatValue(ce.b)} (${fmtParams(model, ce.overridesB)})`;
    }
    default: return '';
  }
}
