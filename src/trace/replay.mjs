// Replay: drive a compiled model with the input events of an observed trace.
//
// replayMode "replace-inputs": the model events the mapping names as inputs
// are fired from the trace instead of from the spec's schedule; every other
// model event must be declared internal and keeps its own schedule. The
// order inside a run is the engine's: tick 0 runs rules.init, then the events
// of tick 0; every later tick runs rules.tick, then the events of that tick,
// in spec order. All replayed inputs of a tick fire as one block at the place
// of the first replayed event in spec order, in trace order; consecutive
// inputs of the same event form a burst (batch = 0..n-1), exactly as the
// engine merges a burst. Time is integer ticks: tick = round(ms / dt in ms).
//
// tests/trace-replay.test.mjs checks that this loop equals simulate(): replaying
// every example's own schedule gives the same snapshots, emits and firings.
// Pure module: no Node or browser APIs.

import { ModelError } from '../engine/errors.mjs';
import { makeRng, poisson } from '../engine/rng.mjs';
import { copyBounded, kindOf, LIMITS } from '../engine/compile.mjs';
import { resolveParams, MAX_FIRINGS } from '../engine/simulate.mjs';
import { TraceError } from './errors.mjs';
import { inputFor, observedValue } from './mapping.mjs';

export const MAX_REPLAY_TICKS = 100000;

function replayTickOf(time, dt) {
  return Math.max(0, Math.ceil(time / dt - 1e-9));
}

function replayParamExpr(fn, env, what, path) {
  const v = fn(env);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ModelError('E_EVENT', `${what} must be a finite number, got ${String(v)}`, { path });
  return v;
}

// Pick the observed events that drive model inputs, with ticks.
export function planInputs(trace, mapping, model) {
  const picked = [];
  for (const e of trace.events) {
    const x = inputFor(mapping, e);
    if (!x) continue;
    picked.push({ eventId: e.id, timeMs: e.timeMs, modelEvent: x.modelEvent, subject: observedValue(x.subjectFrom, e), payloadKey: x.modelPayloadKey });
  }
  if (!picked.length) return { inputs: [], originMs: 0, noInputs: true };
  const originMs = mapping.timeOrigin === 'first-input' ? picked[0].timeMs : 0;
  let maxErr = 0;
  let worst = null;
  for (const p of picked) {
    const rel = p.timeMs - originMs;
    p.tick = Math.round(rel / mapping.dtMs);
    p.quantErrorMs = Math.abs(p.tick * mapping.dtMs - rel);
    if (p.quantErrorMs > maxErr) { maxErr = p.quantErrorMs; worst = p; }
  }
  if (maxErr > mapping.toleranceMs + 1e-9) {
    throw new TraceError('E_TRACE_QUANTIZATION', `event ${worst.eventId} moves ${round3(maxErr)} ms when snapped to a tick of ${round3(mapping.dtMs)} ms, more than the tolerance of ${round3(mapping.toleranceMs)} ms`,
      worst.eventId, 'use a smaller dt in the model, or raise "quantizationToleranceMs" in the mapping');
  }
  picked.forEach((p, i) => { p.index = i; });
  return { inputs: picked, originMs, maxQuantErrorMs: maxErr, noInputs: false, model };
}

function round3(x) { return Math.round(x * 1000) / 1000; }

// Run the model. plan: from planInputs. opts: { params, lastTick, horizonTicks }
export function replayRun(model, plan, mapping, opts = {}) {
  const P = resolveParams(model, opts.params);
  const rng = makeRng(model.seed);
  const dt = model.dt;
  const lastInputTick = plan.inputs.length ? plan.inputs[plan.inputs.length - 1].tick : 0;
  const K = Math.max(model.K, (opts.lastTick != null ? Math.max(opts.lastTick, lastInputTick) : lastInputTick) + (opts.horizonTicks || 0));
  if (K > MAX_REPLAY_TICKS) {
    throw new TraceError('E_REPLAY_LIMIT', `the replay would run ${K} ticks, more than ${MAX_REPLAY_TICKS}`, null, 'replay a shorter window of the trace, or use a larger dt');
  }
  if (plan.inputs.length > MAX_FIRINGS) throw new TraceError('E_REPLAY_LIMIT', `the trace drives ${plan.inputs.length} model inputs, more than ${MAX_FIRINGS}`, null, 'replay a shorter window of the trace');
  const internal = new Set(mapping.internalEvents);
  const env = {
    S: Object.create(null), P, L: [], t: 0, dt, tick: 0,
    seq: 0, batch: 0, payload: null, rng,
    steps: 0, maxSteps: model.maxSteps || LIMITS.steps,
    kinds: Object.create(null), emit: null, cmp: null,
  };
  const snaps = new Array(K + 1);
  const emits = new Array(K + 1);
  const fired = new Array(K + 1);
  const out = { model, params: P, K, dt, snaps, emits, fired, error: null, steps: 0, inputs: plan.inputs, seqInputs: Object.create(null) };
  let current = null; // the replayed input whose handler is running
  env.emit = (name, payload) => {
    emits[env.tick].push({ name, payload, src: env.__src, batch: env.batch, input: current ? current.index : null });
  };
  const runBlock = (fn, srcName) => { env.__src = srcName; if (fn) fn(env); };

  let stored = 0;
  const snapshot = (k) => {
    const s = Object.create(null);
    const box = { n: 0, over: null };
    for (const name of model.stateNames) {
      const v = env.S[name];
      box.n += 1;
      const c = Array.isArray(v) ? copyBounded(v, box, LIMITS.traceCells - stored) : v;
      if (c === undefined || stored + box.n > LIMITS.traceCells) {
        throw new ModelError('E_TRACE_LIMIT', `the replay would store more than ${LIMITS.traceCells} values; replay a shorter window or use a larger dt`, { path: 'state.' + name });
      }
      s[name] = c;
    }
    stored += box.n;
    snaps[k] = s;
  };

  // inputs by tick, merged into bursts of consecutive same-event inputs
  const byTick = new Map();
  for (const p of plan.inputs) {
    let list = byTick.get(p.tick);
    if (!list) { list = []; byTick.set(p.tick, list); }
    const last = list.length ? list[list.length - 1] : null;
    if (last && last.name === p.modelEvent) last.items.push(p);
    else list.push({ name: p.modelEvent, items: [p] });
  }
  const firstReplayed = model.events.find((ev) => !internal.has(ev.name));
  const seqs = Object.create(null);
  const fireBurst = (name, items) => {
    const handler = model.rules.on.get(name);
    fired[env.tick].push({ name, count: items.length });
    for (let b = 0; b < items.length; b++) {
      env.seq = seqs[name] || 0;
      seqs[name] = env.seq + 1;
      env.batch = b;
      current = items[b];
      (out.seqInputs[name] || (out.seqInputs[name] = []))[env.seq] = items[b].index;
      runBlock(handler || null, name);
      current = null;
    }
    env.seq = 0;
    env.batch = 0;
  };
  const fireScheduled = (ev, count) => {
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
  const fireInputs = (k) => { for (const burst of byTick.get(k) || []) fireBurst(burst.name, burst.items); };

  try {
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
    // the internal events' own schedule, as the engine builds it
    const sched = new Map();
    const poissonEvents = new Map();
    let firings = plan.inputs.length;
    for (const ev of model.events) {
      if (!internal.has(ev.name)) continue;
      const count = Math.round(replayParamExpr(ev.count, env, `event "${ev.name}" count`, ev.path + '.count'));
      if (count < 0) throw new ModelError('E_EVENT', `event "${ev.name}" count is negative`, { path: ev.path + '.count' });
      const from = ev.from ? replayParamExpr(ev.from, env, `event "${ev.name}" from`, ev.path + '.from') : 0;
      const until = ev.until ? replayParamExpr(ev.until, env, `event "${ev.name}" until`, ev.path + '.until') : model.duration;
      const add = (k) => {
        if (k > model.K || count <= 0) return;
        let list = sched.get(k);
        if (!list) { list = []; sched.set(k, list); }
        const last = list.length ? list[list.length - 1] : null;
        if (last && last.ev === ev) last.count += count; else list.push({ ev, count });
        firings += count;
        if (firings > MAX_FIRINGS) throw new TraceError('E_REPLAY_LIMIT', `the replay adds up to more than ${MAX_FIRINGS} firings`, ev.path, 'replay a shorter window');
      };
      if (ev.mode === 'at') {
        const times = ev.atList ? ev.atList : [replayParamExpr(ev.at, env, `event "${ev.name}" at`, ev.path + '.at')];
        for (const time of times) { if (time < 0 || time > model.duration + 1e-9) continue; add(replayTickOf(time, dt)); }
      } else if (ev.mode === 'every') {
        const period = replayParamExpr(ev.every, env, `event "${ev.name}" every`, ev.path + '.every');
        if (!(period > 0)) throw new ModelError('E_EVENT', `event "${ev.name}" "every" must be positive, got ${period}`, { path: ev.path + '.every' });
        for (let i = 0; ; i++) {
          const time = from + i * period;
          if (time > until + 1e-9 || time > model.duration + 1e-9) break;
          add(replayTickOf(time, dt));
        }
      } else {
        const rate = replayParamExpr(ev.rate, env, `event "${ev.name}" rate`, ev.path + '.rate');
        if (rate < 0) throw new ModelError('E_EVENT', `event "${ev.name}" rate is negative`, { path: ev.path + '.rate' });
        poissonEvents.set(ev, { rate, from, until, count });
      }
    }

    env.t = 0;
    env.tick = 0;
    if (model.rules.init) runBlock(model.rules.init, null);
    // tick 0: the engine fires the events of time 0 in spec order (no random arrivals yet)
    {
      const list = sched.get(0) || [];
      let si = 0;
      for (const ev of model.events) {
        if (ev === firstReplayed) fireInputs(0);
        if (!internal.has(ev.name)) continue;
        while (si < list.length && list[si].ev === ev) { fireScheduled(ev, list[si].count); si++; }
      }
    }
    snapshot(0);
    for (let k = 1; k <= K; k++) {
      env.tick = k;
      env.t = k * dt;
      if (model.rules.tick) runBlock(model.rules.tick, null);
      const list = sched.get(k) || [];
      let si = 0;
      for (const ev of model.events) {
        if (ev === firstReplayed) fireInputs(k);
        if (!internal.has(ev.name)) continue;
        if (ev.mode === 'rate') {
          const pe = poissonEvents.get(ev);
          if (env.t > pe.from + 1e-9 && env.t <= pe.until + 1e-9 && k <= model.K) {
            const n = poisson(rng, pe.rate * dt) * pe.count;
            firings += n;
            if (firings > MAX_FIRINGS) throw new TraceError('E_REPLAY_LIMIT', `the replay adds up to more than ${MAX_FIRINGS} firings`, ev.path, 'replay a shorter window');
            if (n > 0) fireScheduled(ev, n);
          }
          continue;
        }
        while (si < list.length && list[si].ev === ev) { fireScheduled(ev, list[si].count); si++; }
      }
      snapshot(k);
    }
  } catch (e) {
    if (!(e instanceof ModelError)) throw e;
    e.at = { t: env.t, tick: env.tick };
    out.error = e;
    out.K = Math.max(0, snaps.findIndex((s) => s === undefined) - 1);
  }
  out.steps = env.steps;
  return out;
}

// The subject of one model emit, by the output's modelSubjectFrom selector.
export function emitSubject(run, rec, output) {
  const sel = output.modelSubjectFrom;
  if (sel == null) return null;
  if (sel.startsWith('literal:')) return sel.slice(8);
  if (sel.startsWith('event.')) {
    if (rec.input == null) return null;
    const inp = run.inputs[rec.input];
    return inp && inp.payloadKey === sel.slice(6) ? inp.subject : null;
  }
  let v = rec.payload;
  if (sel !== 'payload') {
    const i = Number(sel.slice(8, -1));
    v = Array.isArray(v) && i < v.length ? v[i] : null;
  }
  if (v == null || Array.isArray(v)) return null;
  if (output.payloadIsSeqOf) {
    if (typeof v !== 'number' || !Number.isInteger(v)) return null;
    const list = run.seqInputs[output.payloadIsSeqOf];
    const idx = list ? list[v] : undefined;
    return idx == null ? null : run.inputs[idx].subject;
  }
  return String(v);
}
