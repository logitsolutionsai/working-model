// Replay: the trace-driven loop must be the engine's loop. Replaying every
// example's own schedule as a trace gives the same snapshots, emits and
// firings as simulate(); tick rules run before events; nothing is injected
// twice; ticks are quantized as documented.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModel } from '../src/engine/model.mjs';
import { simulate } from '../src/engine/simulate.mjs';
import { validateMapping } from '../src/trace/mapping.mjs';
import { planInputs, replayRun } from '../src/trace/replay.mjs';
import { counterSpec } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'examples');

function compile(spec) {
  const { model, errors } = compileModel(spec);
  assert.deepEqual(errors.map((e) => e.code), []);
  return model;
}

// A trace that records exactly the firings of a baseline run.
function traceFromRun(run, dtMs) {
  const events = [];
  for (let k = 0; k <= run.K; k++) {
    for (const f of run.fired[k]) for (let b = 0; b < f.count; b++) events.push({ id: 'ev-' + String(events.length + 1).padStart(5, '0'), timeMs: k * dtMs, kind: f.name, attrs: {} });
  }
  return { schemaVersion: 1, kind: 'working-model-trace', timeBase: 'relative-ms', completeness: 'declared-complete', events };
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

describe('replay equals the engine', () => {
  const files = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith('.model.json')).sort();
  for (const f of files) {
    const spec = JSON.parse(fs.readFileSync(path.join(EXAMPLES, f), 'utf8'));
    const names = [...new Set((spec.events || []).map((e) => e.name))];
    if (!names.length) {
      test(`${f}: no events, so there is nothing to replay`, () => {
        const model = compile(spec);
        assert.throws(() => validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, inputs: [] }, model), /inputs/);
      });
      continue;
    }
    test(`${f}: replaying its own schedule reproduces simulate() exactly`, () => {
      const model = compile(spec);
      const base = simulate(model, {});
      assert.equal(base.error, null);
      const mapping = validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, timeOrigin: 'zero', inputs: names.map((n) => ({ observedKind: n, modelEvent: n })) }, model);
      const trace = traceFromRun(base, mapping.dtMs);
      const plan = planInputs(trace, mapping, model);
      const run = replayRun(model, plan, mapping, {});
      assert.equal(run.error, null);
      assert.equal(run.K, base.K);
      assert.deepEqual(plain(run.fired), plain(base.fired), 'firings differ');
      if (model.events.some((e) => e.mode === 'rate')) {
        // A replayed random arrival stream no longer draws from the seeded
        // generator, so rule code that calls random functions sees another
        // sequence (documented in docs/REALITY-BRIDGE.md). The input stream
        // itself must still be identical, which the line above checks.
        return;
      }
      assert.deepEqual(plain(run.snaps), plain(base.snaps), 'snapshots differ');
      const strip = (e) => e.map((list) => list.map((x) => ({ name: x.name, payload: x.payload, src: x.src, batch: x.batch })));
      assert.deepEqual(plain(strip(run.emits)), plain(strip(base.emits)), 'emits differ');
    });
  }
});

describe('replay semantics', () => {
  test('tick rules run before the replayed events of the same tick', () => {
    const model = compile(counterSpec({ state: { n: 0, seen: [] }, rules: { tick: 'n += 1', on: { ping: ['push(seen, n)'] } }, narration: [], claims: [] }));
    const mapping = validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, timeOrigin: 'zero', inputs: [{ observedKind: 'ping', modelEvent: 'ping' }] }, model);
    const trace = { events: [{ id: 'a', timeMs: 3000, kind: 'ping', attrs: {} }] };
    const run = replayRun(model, planInputs(trace, mapping, model), mapping);
    assert.deepEqual(plain(run.snaps[3].seen), [3]);
  });

  test('replayed events replace the schedule: a scheduled ping never fires on top of the trace', () => {
    const model = compile(counterSpec());
    const mapping = validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, timeOrigin: 'zero', inputs: [{ observedKind: 'ping', modelEvent: 'ping' }] }, model);
    const trace = { events: [{ id: 'a', timeMs: 5000, kind: 'ping', attrs: {} }] };
    const run = replayRun(model, planInputs(trace, mapping, model), mapping);
    const firings = run.fired.flat();
    assert.deepEqual(plain(firings), [{ name: 'ping', count: 1 }]);
    assert.equal(run.snaps[run.K].fired, 1);
  });

  test('an event that is neither replayed nor internal is refused as ambiguous', () => {
    const model = compile(counterSpec({ events: [{ name: 'ping', at: [2] }, { name: 'tock', every: 3 }], rules: { tick: 'n += step', on: { ping: 'fired += 1', tock: 'fired += 0' } } }));
    assert.throws(() => validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, inputs: [{ observedKind: 'ping', modelEvent: 'ping' }] }, model), (e) => e.code === 'E_REPLAY_AMBIGUOUS');
    assert.throws(() => validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, internalEvents: ['ping'], inputs: [{ observedKind: 'ping', modelEvent: 'ping' }] }, model), (e) => e.code === 'E_REPLAY_AMBIGUOUS');
    const ok = validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, internalEvents: ['tock'], inputs: [{ observedKind: 'ping', modelEvent: 'ping' }] }, model);
    assert.deepEqual(ok.internalEvents, ['tock']);
  });

  test('internal events keep their own schedule beside the replayed ones', () => {
    const model = compile(counterSpec({ state: { n: 0, fired: 0, log: [] }, events: [{ name: 'ping', at: [2] }, { name: 'tock', every: 4 }], rules: { tick: 'n += step', on: { ping: "push(log, 'p')", tock: "push(log, 't')" } } }));
    const mapping = validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, timeOrigin: 'zero', internalEvents: ['tock'], inputs: [{ observedKind: 'ping', modelEvent: 'ping' }] }, model);
    const trace = { events: [{ id: 'a', timeMs: 4000, kind: 'ping', attrs: {} }, { id: 'b', timeMs: 7000, kind: 'ping', attrs: {} }] };
    const run = replayRun(model, planInputs(trace, mapping, model), mapping);
    // tock at 0, 4, 8; pings at 4 and 7; at tick 4 the replayed block comes first (ping is first in spec order)
    assert.deepEqual(plain(run.snaps[run.K].log), ['t', 'p', 't', 'p', 't']);
  });

  test('20 ms timestamps at dt = 0.1 s snap to the nearest tick and report the error', () => {
    const model = compile(counterSpec({ dt: 0.1, duration: 2, events: [{ name: 'ping', at: [0.5] }], claims: [], narration: [] }));
    const mapping = validateMapping({ schemaVersion: 1, timeOrigin: 'zero', inputs: [{ observedKind: 'ping', modelEvent: 'ping' }] }, model);
    assert.equal(mapping.dtMs, 100);
    const trace = { events: [20, 40, 60, 80, 140].map((t, i) => ({ id: 'e' + i, timeMs: t, kind: 'ping', attrs: {} })) };
    const plan = planInputs(trace, mapping, model);
    assert.deepEqual(plan.inputs.map((p) => p.tick), [0, 0, 1, 1, 1]);
    assert.equal(plan.maxQuantErrorMs, 40);
    // a tighter tolerance refuses the same trace
    const strict = validateMapping({ schemaVersion: 1, timeOrigin: 'zero', quantizationToleranceMs: 10, inputs: [{ observedKind: 'ping', modelEvent: 'ping' }] }, model);
    assert.throws(() => planInputs(trace, strict, model), (e) => e.code === 'E_TRACE_QUANTIZATION');
  });

  test('first-input origin puts the first replayed input at t = 0, and same-tick inputs keep trace order', () => {
    const model = compile(counterSpec({ state: { n: 0, fired: 0, log: [] }, events: [{ name: 'ping', at: [1] }, { name: 'pong', at: [1] }], rules: { on: { ping: "push(log, 'ping')", pong: "push(log, 'pong')" } }, claims: [], narration: [] }));
    const mapping = validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, inputs: [{ observedKind: 'a', modelEvent: 'ping' }, { observedKind: 'b', modelEvent: 'pong' }] }, model);
    const trace = { events: [{ id: '1', timeMs: 5000, kind: 'b', attrs: {} }, { id: '2', timeMs: 5000, kind: 'a', attrs: {} }, { id: '3', timeMs: 7000, kind: 'b', attrs: {} }] };
    const plan = planInputs(trace, mapping, model);
    assert.equal(plan.originMs, 5000);
    assert.deepEqual(plan.inputs.map((p) => p.tick), [0, 0, 2]);
    const run = replayRun(model, plan, mapping);
    assert.deepEqual(plain(run.snaps[run.K].log), ['pong', 'ping', 'pong']);
  });

  test('a replay that loops forever stops at the step limit with an error, not a pass', () => {
    const model = compile(counterSpec({ rules: { on: { ping: 'while true { n += 1 }' } }, claims: [], narration: [], limits: { steps: 1000 } }));
    const mapping = validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, inputs: [{ observedKind: 'ping', modelEvent: 'ping' }] }, model);
    const run = replayRun(model, planInputs({ events: [{ id: 'a', timeMs: 0, kind: 'ping', attrs: {} }] }, mapping, model), mapping);
    assert.equal(run.error.code, 'E_STEP_LIMIT');
  });

  test('a trace longer than the replay limit is refused', () => {
    const model = compile(counterSpec({ dt: 0.001, duration: 1, claims: [], narration: [] }));
    const mapping = validateMapping({ schemaVersion: 1, msPerModelUnit: 1000, timeOrigin: 'zero', inputs: [{ observedKind: 'ping', modelEvent: 'ping' }] }, model);
    const plan = planInputs({ events: [{ id: 'a', timeMs: 0, kind: 'ping', attrs: {} }, { id: 'b', timeMs: 500000, kind: 'ping', attrs: {} }] }, mapping, model);
    assert.throws(() => replayRun(model, plan, mapping), (e) => e.code === 'E_REPLAY_LIMIT');
  });
});
