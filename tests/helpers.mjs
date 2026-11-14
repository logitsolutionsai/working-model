// Shared helpers for the unit tests.
import { compileProgramSource, compileExpressionSource, kindOf, LIMITS } from '../src/engine/compile.mjs';
import { makeRng } from '../src/engine/rng.mjs';
import { ModelError } from '../src/engine/errors.mjs';

export function env(state = {}, params = {}, extra = {}) {
  const S = Object.create(null);
  const kinds = Object.create(null);
  for (const [k, v] of Object.entries(state)) { S[k] = v; kinds[k] = kindOf(v); }
  const P = Object.create(null);
  Object.assign(P, params);
  const emitted = [];
  return {
    S, P, L: [], t: 0, dt: 0.1, tick: 0, seq: 0, batch: 0, payload: null,
    rng: makeRng(1), steps: 0, maxSteps: extra.maxSteps || LIMITS.steps, kinds,
    emit: (name, payload) => emitted.push({ name, payload }), emitted, cmp: null,
  };
}

// Run rule code against a state object; returns { S, emitted, env }.
export function run(src, state = {}, params = {}, extra = {}) {
  const fn = compileProgramSource(src, 'test', { state: new Set(Object.keys(state)), params: new Set(Object.keys(params)) });
  const e = env(state, params, extra);
  fn(e);
  return { S: e.S, emitted: e.emitted, env: e };
}

export function ev(src, state = {}, params = {}) {
  const fn = compileExpressionSource(src, 'test', { state: new Set(Object.keys(state)), params: new Set(Object.keys(params)) });
  return fn(env(state, params));
}

// Call fn and return the ModelError it throws (or fail).
export function codeOf(fn) {
  try { fn(); } catch (e) {
    if (e instanceof ModelError) return e;
    throw e;
  }
  throw new Error('expected a ModelError, but nothing was thrown');
}

// A tiny model used across the claim, simulation and lint tests.
export function counterSpec(over = {}) {
  return {
    title: 'Counter',
    dt: 1,
    duration: 10,
    seed: 3,
    params: [{ id: 'step', label: 'Step', min: 1, max: 5, step: 1, default: 1 }],
    state: { n: 0, fired: 0 },
    events: [{ name: 'ping', at: [2, 5] }],
    rules: { tick: 'n += step', on: { ping: ['fired += 1', "emit('pong', n)"] } },
    parts: [{ id: 'c', type: 'counter', at: [0, 0, 2, 2], value: 'n' }],
    narration: [{ from: 0, text: 'Counting up by {step}.', cites: ['grows'] }],
    claims: [{ id: 'grows', kind: 'at', t: 10, expr: 'n == 10 * step', text: 'After ten ticks n is ten steps.' }],
    ...over,
  };
}
