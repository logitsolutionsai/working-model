// Deterministic shrinking of a failing fuzz case. A candidate is kept only
// when the same claim still fails (a different failure or an error does not
// count). Order: drop event perturbations (halves, then one at a time), move
// burst counts back toward the spec, shifts toward zero, params toward their
// defaults (then halfway, snapped to the slider step), then the model seed
// back to the spec's. Stops after `budget` evaluations and says so.
// Duration is not shrunk: claims name times inside the run.
// Pure module: no Node or browser APIs.

import { evaluateCase } from './fuzz.mjs';
import { snapToStep } from '../engine/model.mjs';
import { TraceError } from '../trace/errors.mjs';

function clone(c) { return JSON.parse(JSON.stringify(c)); }

export function shrinkCase(model, start, claimId, opts = {}) {
  const budget = opts.budget == null ? 200 : opts.budget;
  if (!(Number.isInteger(budget) && budget >= 0 && budget <= 2000)) throw new TraceError('E_USAGE', '--shrink-budget must be a whole number from 0 to 2000', '--shrink-budget', null);
  let checks = 0;
  let hitBudget = false;
  let last = null;
  const stillFails = (c) => {
    if (checks >= budget) { hitBudget = true; return false; }
    checks++;
    const { first } = evaluateCase(model, c, { claimId });
    if (first && first.failure && first.failure.claimId === claimId) { last = first.failure; return true; }
    return false;
  };
  // confirm the starting case
  const confirm = evaluateCase(model, start, { claimId });
  if (!(confirm.first && confirm.first.failure && confirm.first.failure.claimId === claimId)) {
    throw new TraceError('E_CASE_DOES_NOT_FAIL', `claim "${claimId}" does not fail on this case`, 'case', 'pass a case written by fuzz, for the same model');
  }
  last = confirm.first.failure;
  let cur = clone(start);

  // 1. drop perturbations: halves, then single ones
  let n = 2;
  while (cur.events.length && !hitBudget) {
    const size = Math.ceil(cur.events.length / n);
    let removed = false;
    for (let i = 0; i < cur.events.length && !hitBudget; i += size) {
      const cand = clone(cur);
      cand.events.splice(i, size);
      if (stillFails(cand)) { cur = cand; removed = true; break; }
    }
    if (removed) { n = Math.max(2, n - 1); continue; }
    if (size === 1) break;
    n = Math.min(cur.events.length, n * 2);
  }
  // 2. counts toward the spec's own count, shifts toward zero
  const specCount = (index) => {
    const ev = model.events.find((e) => e.index === index);
    const P = Object.assign(Object.create(null), cur.params);
    try { return Math.round(ev.count({ P, S: Object.create(null), L: [], t: 0, dt: model.dt })); } catch { return 1; }
  };
  for (let i = 0; i < cur.events.length && !hitBudget; i++) {
    if (cur.events[i].count != null) {
      const target = specCount(cur.events[i].index);
      let cand = clone(cur);
      delete cand.events[i].count;
      if (stillFails(cand)) cur = cand;
      else {
        while (!hitBudget) {
          const c = cur.events[i].count;
          if (c === target) break;
          const step = Math.trunc((target - c) / 2) || Math.sign(target - c);
          cand = clone(cur);
          cand.events[i].count = c + step;
          if (stillFails(cand)) cur = cand; else break;
        }
      }
    }
    if (!hitBudget && cur.events[i].shift) {
      const cand = clone(cur);
      delete cand.events[i].shift;
      if (stillFails(cand)) cur = cand;
    }
  }
  cur.events = cur.events.filter((e) => e.omit || e.count != null || e.shift);
  // 3. params toward defaults, then halfway
  for (const p of model.params) {
    if (hitBudget) break;
    if (cur.params[p.id] === p.default) continue;
    const cand = clone(cur);
    cand.params[p.id] = p.default;
    if (stillFails(cand)) { cur = cand; continue; }
    for (let k = 0; k < 8 && !hitBudget; k++) {
      const v = cur.params[p.id];
      const mid = snapToStep((v + p.default) / 2, p);
      if (mid === v || mid === p.default) break;
      const c2 = clone(cur);
      c2.params[p.id] = mid;
      if (stillFails(c2)) cur = c2; else break;
    }
  }
  // 4. the model seed back to the spec's
  if (!hitBudget && cur.seed !== model.seed) {
    const cand = clone(cur);
    cand.seed = model.seed;
    if (stillFails(cand)) cur = cand;
  }
  return { case: cur, failure: last, shrink: { checks, budget, stopReason: hitBudget ? 'budget-exhausted' : 'local-minimum-under-budget' } };
}
