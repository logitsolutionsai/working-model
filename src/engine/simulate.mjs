// Discrete-time simulation.
//
// Tick 0: state starts from its initial values, rules.init runs, then events
//         scheduled at t = 0 fire. Snapshot 0 is taken.
// Tick k: t = k * dt. rules.tick runs, then every event whose time falls in
//         (t - dt, t] fires (in spec order; a burst of n runs the handler n
//         times with batch = 0..n-1). Snapshot k is taken.
//
// The trace keeps a deep copy of the state at every tick, every emit() with
// its tick, and every event firing, so the page can scrub through time and
// claims can be checked after the run.

import { ModelError } from './errors.mjs';
import { makeRng, poisson } from './rng.mjs';
import { copyBounded, kindOf, LIMITS } from './compile.mjs';

// Every event entry, burst and random arrival counts towards one cap, so a
// spec such as "count": 1e9 or "rate": 1e12 fails at once instead of hanging.
export const MAX_FIRINGS = 200000;

function tooManyFirings(path) {
  return new ModelError('E_EVENT', `the events add up to more than ${MAX_FIRINGS} firings in one run; use a smaller count or rate, or a larger "every"`, { path });
}

export function resolveParams(model, overrides) {
  const P = Object.create(null);
  for (const p of model.params) {
    let v = overrides && overrides[p.id] != null ? Number(overrides[p.id]) : p.default;
    if (!Number.isFinite(v)) v = p.default;
    P[p.id] = v;
  }
  return P;
}

function makeEnv(model, P, rng) {
  return {
    S: Object.create(null), P, L: [], t: 0, dt: model.dt, tick: 0,
    seq: 0, batch: 0, payload: null, rng,
    steps: 0, maxSteps: model.maxSteps || LIMITS.steps,
    kinds: Object.create(null), emit: null, cmp: null,
  };
}

function tickOf(time, dt) {
  return Math.max(0, Math.ceil(time / dt - 1e-9));
}

function evalParamExpr(fn, env, what, path) {
  const v = fn(env);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ModelError('E_EVENT', `${what} must be a finite number, got ${String(v)}`, { path });
  }
  return v;
}

// Build the per-tick schedule of deterministic events.
function schedule(model, env) {
  const K = model.K;
  const byTick = new Map();
  const add = (k, ev, count) => {
    if (k > K || count <= 0) return;
    let list = byTick.get(k);
    if (!list) { list = []; byTick.set(k, list); }
    const last = list.length ? list[list.length - 1] : null;
    if (last && last.ev === ev) last.count += count;
    else list.push({ ev, count });
  };
  let total = 0;
  const poissonEvents = [];
  for (const ev of model.events) {
    const count = Math.round(evalParamExpr(ev.count, env, `event "${ev.name}" count`, ev.path + '.count'));
    if (count < 0) throw new ModelError('E_EVENT', `event "${ev.name}" count is negative`, { path: ev.path + '.count' });
    const from = ev.from ? evalParamExpr(ev.from, env, `event "${ev.name}" from`, ev.path + '.from') : 0;
    const until = ev.until ? evalParamExpr(ev.until, env, `event "${ev.name}" until`, ev.path + '.until') : model.duration;
    if (ev.mode === 'at') {
      const times = ev.atList ? ev.atList : [evalParamExpr(ev.at, env, `event "${ev.name}" at`, ev.path + '.at')];
      for (const time of times) {
        if (time < 0 || time > model.duration + 1e-9) continue;
        add(tickOf(time, model.dt), ev, count);
        total += count;
        if (total > MAX_FIRINGS) throw tooManyFirings(ev.path + (ev.atList ? '.at' : '.count'));
      }
    } else if (ev.mode === 'every') {
      const period = evalParamExpr(ev.every, env, `event "${ev.name}" every`, ev.path + '.every');
      if (!(period > 0)) throw new ModelError('E_EVENT', `event "${ev.name}" "every" must be positive, got ${period}`, { path: ev.path + '.every' });
      for (let i = 0; ; i++) {
        const time = from + i * period;
        if (time > until + 1e-9 || time > model.duration + 1e-9) break;
        add(tickOf(time, model.dt), ev, count);
        total += count;
        if (total > MAX_FIRINGS) throw tooManyFirings(ev.path + '.every');
      }
    } else {
      const rate = evalParamExpr(ev.rate, env, `event "${ev.name}" rate`, ev.path + '.rate');
      if (rate < 0) throw new ModelError('E_EVENT', `event "${ev.name}" rate is negative`, { path: ev.path + '.rate' });
      poissonEvents.push({ ev, rate, from, until, count });
    }
  }
  return { byTick, poissonEvents, total };
}

// observers: [{ names: Set, onFire(env, info) }] called after each handler or
// tick-rule block for the event it ran and each name it emitted.
// onSnapshot(env, k) is called after each snapshot.
export function simulate(model, overrides, opts = {}) {
  const P = resolveParams(model, overrides);
  const rng = makeRng(model.seed);
  const env = makeEnv(model, P, rng);
  const K = model.K;
  const dt = model.dt;
  const snaps = new Array(K + 1);
  const emits = new Array(K + 1);
  const fired = new Array(K + 1);
  const observers = opts.observers || [];
  const watch = new Set();
  for (const o of observers) for (const n of o.names) watch.add(n);
  const trace = { model, params: P, K, dt, snaps, emits, fired, error: null, steps: 0 };
  // opts.budget is shared by every run of one claim check, so many sweep
  // samples or compares cannot add up to minutes of work. Ticks count too.
  const budget = opts.budget || null;
  const ownLimit = env.maxSteps;
  // a tick (snapshot, schedule, observers) costs about as much as 32 rule steps
  const tickCost = 32 * K;
  if (budget) env.maxSteps = Math.min(ownLimit, budget.left - tickCost);

  let block = null; // emits of the block currently running
  env.emit = (name, payload) => {
    const rec = { name, payload, src: env.__src, batch: env.batch };
    emits[env.tick].push(rec);
    if (block) block.push(rec);
  };

  const runBlock = (fn, srcName) => {
    block = [];
    env.__src = srcName;
    if (fn) fn(env);
    const done = block;
    block = null;
    if (watch.size) {
      if (srcName && watch.has(srcName)) notify(srcName, null, true);
      for (const e of done) if (watch.has(e.name)) notify(e.name, e.payload, false);
    }
  };
  const notify = (name, payload, scheduled) => {
    const saved = env.payload;
    env.payload = payload;
    for (const o of observers) if (o.names.has(name)) o.onFire(env, { name, payload, scheduled, k: env.tick, t: env.t });
    env.payload = saved;
  };

  // The trace stores a copy of the state at every tick; LIMITS.traceCells
  // caps the total so a big list in a long run fails cleanly instead of
  // running Node or the browser out of memory.
  let stored = 0;
  const snapshot = (k) => {
    const s = Object.create(null);
    const box = { n: 0, over: null };
    for (const name of model.stateNames) {
      const v = env.S[name];
      box.n += 1;
      const c = Array.isArray(v) ? copyBounded(v, box, LIMITS.traceCells - stored) : v;
      if (c === undefined || stored + box.n > LIMITS.traceCells) {
        if (box.over === 'depth') throw new ModelError('E_TOO_DEEP', `state "${name}" is a list nested more than ${LIMITS.depth} levels deep`, { path: 'state.' + name });
        throw new ModelError('E_TRACE_LIMIT', `the run would store more than ${LIMITS.traceCells} values (the whole state is kept for each of the ${K + 1} ticks); use a larger dt, a shorter duration or smaller lists`, { path: 'state.' + name });
      }
      s[name] = c;
    }
    stored += box.n;
    snaps[k] = s;
    if (opts.onSnapshot) opts.onSnapshot(env, k);
  };

  try {
    if (budget && env.maxSteps <= 0) throw budgetError(budget, 0, null);
    // initial state
    for (const si of model.stateInit) {
      const box = { n: 0, over: null };
      const v = copyBounded(si.fn ? si.fn(env) : si.value, box, LIMITS.cells);
      if (v === undefined) throw new ModelError(box.over === 'depth' ? 'E_TOO_DEEP' : 'E_LIST_LIMIT', `state "${si.name}" starts as a list that is too big or too deeply nested`, { path: 'state.' + si.name });
      const kind = kindOf(v);
      if (kind === 'number' && !Number.isFinite(v)) throw new ModelError('E_NONFINITE', `state "${si.name}" starts as a non-finite number`, { path: 'state.' + si.name });
      env.S[si.name] = v;
      env.kinds[si.name] = kind;
    }
    for (let k = 0; k <= K; k++) { emits[k] = []; fired[k] = []; }
    const { byTick, poissonEvents, total } = schedule(model, env);
    let firings = total;
    const seqs = Object.create(null);

    const fire = (ev, count) => {
      const handler = model.rules.on.get(ev.name);
      fired[env.tick].push({ name: ev.name, count });
      for (let b = 0; b < count; b++) {
        env.seq = seqs[ev.name] || 0;
        seqs[ev.name] = env.seq + 1;
        env.batch = b;
        runBlock(handler || null, ev.name);
      }
      env.seq = 0;
      env.batch = 0;
    };

    env.t = 0;
    env.tick = 0;
    if (model.rules.init) runBlock(model.rules.init, null);
    for (const item of byTick.get(0) || []) fire(item.ev, item.count);
    snapshot(0);

    for (let k = 1; k <= K; k++) {
      env.tick = k;
      env.t = k * dt;
      if (model.rules.tick) runBlock(model.rules.tick, null);
      const sched = byTick.get(k) || [];
      // deterministic and random events fire in spec order
      let si = 0;
      for (const ev of model.events) {
        if (ev.mode === 'rate') {
          const pe = poissonEvents.find((x) => x.ev === ev);
          if (env.t > pe.from + 1e-9 && env.t <= pe.until + 1e-9) {
            const n = poisson(rng, pe.rate * dt) * pe.count;
            firings += n;
            if (firings > MAX_FIRINGS) throw tooManyFirings(ev.path + '.rate');
            if (n > 0) fire(ev, n);
          }
          continue;
        }
        while (si < sched.length && sched[si].ev === ev) { fire(ev, sched[si].count); si++; }
      }
      snapshot(k);
    }
  } catch (err) {
    if (!(err instanceof ModelError)) throw err;
    let e = err;
    if (budget && e.code === 'E_STEP_LIMIT' && env.maxSteps < ownLimit) e = budgetError(budget, env.tick, e.loc);
    e.at = { t: env.t, tick: env.tick };
    trace.error = e;
    trace.K = Math.max(0, snaps.findIndex((s) => s === undefined) - 1);
    if (trace.K < 0) trace.K = 0;
  }
  trace.steps = env.steps;
  if (budget) budget.left -= env.steps + tickCost;
  return trace;
}

export function makeBudget(steps) {
  const n = steps || LIMITS.checkSteps;
  return { total: n, left: n };
}

function budgetError(budget, tick, loc) {
  return new ModelError('E_STEP_LIMIT', `checking the claims needs more than ${budget.total} steps of simulation in all (each sweep sample and each compare run re-runs the model); use fewer sweep samples, a shorter run or lighter rules`, loc);
}

// Environment for evaluating expressions against a recorded snapshot.
export function snapshotEnv(trace, k) {
  const model = trace.model;
  return {
    S: trace.snaps[k], P: trace.params, L: [], t: k * model.dt, dt: model.dt, tick: k,
    seq: 0, batch: 0, payload: null, rng: () => 0, steps: 0, maxSteps: 1e6, kinds: null, emit: null, cmp: null,
  };
}

// Current values of state and derived names for display.
export function valuesAt(trace, k, names) {
  const env = snapshotEnv(trace, k);
  const model = trace.model;
  const out = {};
  for (const name of names) {
    if (model.stateNames.includes(name)) out[name] = env.S[name];
    else if (model.derivedGetters.has(name)) {
      try { out[name] = model.derivedGetters.get(name)(env); } catch { out[name] = null; }
    } else if (model.paramIds.has(name)) out[name] = trace.params[name];
  }
  return out;
}
