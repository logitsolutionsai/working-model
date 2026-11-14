// Observed assertions. Each returns pass, fail or inconclusive, with the
// normalized event ids it rests on. A missing observed event fails an
// assertion only when the trace is declared complete; otherwise it is
// inconclusive. Causes are factual descriptions of what the algorithm found,
// never guessed root causes.
// Pure module: no Node or browser APIs.

import { observedValue, matchesWhen } from './mapping.mjs';

const MAX_IDS = 20;

function ids(list) { return list.slice(0, MAX_IDS).map((x) => x.id); }
function ratio(n, d) { return d ? n / d : undefined; }
function r4(x) { return x === undefined ? undefined : Math.round(x * 10000) / 10000; }

function inconclusive(a, reason, extra) {
  return { id: a.id, kind: a.kind, required: a.required, status: 'inconclusive', inconclusiveReason: reason, ...extra };
}

// ctx: { trace, completeness, outputs (per modelEmit: { expected, observed, match }), traceEndMs }
export function evaluateAssertion(a, ctx) {
  const complete = ctx.completeness === 'declared-complete';
  const incompleteWhy = `the trace completeness is "${ctx.completeness}": events missing from the trace (inputs or outputs) could explain this, so it cannot count as a failure`;
  switch (a.kind) {
    case 'event-correspondence': {
      const o = ctx.outputs.get(a.modelEmit);
      const m = o.match;
      const E = o.expected.length;
      const O = o.observed.length;
      const M = m.pairs.length;
      const precision = ratio(M, O);
      const recall = ratio(M, E);
      const metrics = {
        expected: E, observed: O, matched: M,
        precision: r4(precision) === undefined ? 'undefined' : r4(precision),
        recall: r4(recall) === undefined ? 'undefined' : r4(recall),
        minPrecision: a.minPrecision, minRecall: a.minRecall, skew: m.skew,
        notes: [
          ...(O === 0 ? ['precision is undefined: nothing of this kind was observed'] : []),
          ...(E === 0 ? ['recall is undefined: the model predicted no output of this kind'] : []),
        ],
      };
      const evidence = {
        matchedPairs: m.pairs.slice(0, MAX_IDS).map((p) => ({ observedId: p.observed.id, expectedAtMs: p.expected.timeMs, deltaMs: p.deltaMs })),
        unmatchedExpected: m.unmatchedExpected.slice(0, MAX_IDS).map((e) => ({ atMs: e.timeMs, subject: e.subject, causedBy: e.causedBy })),
        unmatchedObservedIds: ids(m.unmatchedObserved),
        uncorrelatedObservedIds: ids(m.uncorrelatedObserved),
        uncorrelatedExpected: m.uncorrelatedExpected.length,
      };
      const base = { metrics, evidence, test: `precision >= ${a.minPrecision} and recall >= ${a.minRecall}` };
      if (E === 0 && O === 0) return inconclusive(a, 'neither the model nor the trace has this output, so there is nothing to compare', base);
      const unc = m.uncorrelatedExpected.length + m.uncorrelatedObserved.length;
      if (unc) return inconclusive(a, `no correlation identifier for ${unc} event${unc === 1 ? '' : 's'}; events are never matched by timing alone`, base);
      const recallFail = recall !== undefined && recall < a.minRecall - 1e-12;
      const precFail = precision !== undefined && precision < a.minPrecision - 1e-12;
      if (!recallFail && !precFail) return { id: a.id, kind: a.kind, required: a.required, status: 'pass', ...base };
      const failed = [];
      if (recallFail) failed.push(`recall ${r4(recall)} < minRecall ${a.minRecall}`);
      if (precFail) failed.push(`precision ${r4(precision)} < minPrecision ${a.minPrecision}`);
      base.failedTest = failed.join('; ');
      if (!complete) return inconclusive(a, `${failed.join('; ')}, but ${incompleteWhy}`, base);
      const cands = [];
      if (recallFail && m.unmatchedExpected.length) {
        const e = m.unmatchedExpected[0];
        cands.push({ type: 'missing_observed_output', atMs: e.timeMs, subject: e.subject, expectedKind: o.output.observedKind, observedKind: null, cause: 'Unmatched expected output; trace declared complete', relatedEventIds: e.causedBy ? [e.causedBy] : [] });
      }
      if (precFail && m.unmatchedObserved.length) {
        const x = m.unmatchedObserved[0];
        cands.push({ type: 'unexpected_observed_output', atMs: x.timeMs, subject: x.subject, expectedKind: null, observedKind: x.kind, cause: `Observed output with no predicted model output within ${o.output.withinMs} ms; trace declared complete`, relatedEventIds: [x.id] });
      }
      cands.sort((p, q) => p.atMs - q.atMs);
      return { id: a.id, kind: a.kind, required: a.required, status: 'fail', firstFailure: { assertionId: a.id, ...cands[0], test: base.failedTest }, ...base };
    }
    case 'event-order': {
      const firsts = new Map();
      let thens = 0;
      let unc = 0;
      const violations = [];
      for (const e of ctx.trace.events) {
        if (e.kind === a.first) {
          const s = observedValue(a.by, e);
          if (s == null) { unc++; continue; }
          if (!firsts.has(s)) firsts.set(s, e);
        } else if (e.kind === a.then) {
          thens++;
          const s = observedValue(a.by, e);
          if (s == null) { unc++; continue; }
          if (!firsts.has(s)) violations.push({ e, s });
        }
      }
      const base = { evidence: { thenEvents: thens, violationIds: violations.slice(0, MAX_IDS).map((v) => v.e.id) }, test: `every "${a.then}" has an earlier "${a.first}" with the same ${a.by}` };
      if (!thens) return inconclusive(a, `no "${a.then}" event was observed, so the order was never exercised`, base);
      if (violations.length) {
        if (!complete) return inconclusive(a, `${violations.length} "${a.then}" event${violations.length === 1 ? ' has' : 's have'} no earlier "${a.first}", but ${incompleteWhy}`, base);
        const v = violations[0];
        return { id: a.id, kind: a.kind, required: a.required, status: 'fail', ...base, firstFailure: { assertionId: a.id, type: 'order_violation', atMs: v.e.timeMs, subject: v.s, expectedKind: a.first, observedKind: a.then, cause: `"${a.then}" observed with no earlier "${a.first}" for the same subject; trace declared complete`, relatedEventIds: [v.e.id], test: base.test } };
      }
      if (unc) return inconclusive(a, `no correlation identifier for ${unc} event${unc === 1 ? '' : 's'}`, base);
      return { id: a.id, kind: a.kind, required: a.required, status: 'pass', ...base };
    }
    case 'response-before': {
      const waiting = new Map(); // subject -> queue of request events
      const reqs = [];
      let unc = 0;
      const late = [];
      const pairs = [];
      for (const e of ctx.trace.events) {
        if (e.kind === a.request) {
          const s = observedValue(a.by, e);
          if (s == null) { unc++; continue; }
          const r = { e, s, answered: null };
          reqs.push(r);
          if (!waiting.has(s)) waiting.set(s, []);
          waiting.get(s).push(r);
        } else if (e.kind === a.response) {
          const s = observedValue(a.by, e);
          if (s == null) { unc++; continue; }
          const q = waiting.get(s);
          if (q && q.length) {
            const r = q.shift();
            r.answered = e;
            pairs.push(r);
            if (e.timeMs - r.e.timeMs > a.withinMs + 1e-9) late.push(r);
          }
        }
      }
      const missing = reqs.filter((r) => !r.answered);
      const missingFinal = missing.filter((r) => r.e.timeMs + a.withinMs <= ctx.traceEndMs);
      const base = {
        evidence: { requests: reqs.length, answered: pairs.length, lateIds: late.slice(0, MAX_IDS).map((r) => r.answered.id), missingIds: ids(missing.map((r) => r.e)) },
        test: `every "${a.request}" gets a "${a.response}" with the same ${a.by} within ${a.withinMs} ms`,
      };
      if (!reqs.length) return inconclusive(a, `no "${a.request}" event was observed`, base);
      const cands = [];
      for (const r of late) cands.push({ type: 'late_response', atMs: r.answered.timeMs, subject: r.s, expectedKind: a.response, observedKind: a.response, cause: `response observed ${r.answered.timeMs - r.e.timeMs} ms after the request, more than ${a.withinMs} ms`, relatedEventIds: [r.e.id, r.answered.id] });
      if (complete) for (const r of missingFinal) cands.push({ type: 'missing_response', atMs: r.e.timeMs + a.withinMs, subject: r.s, expectedKind: a.response, observedKind: null, cause: 'No response observed for the request; trace declared complete', relatedEventIds: [r.e.id] });
      if (cands.length) {
        cands.sort((p, q) => p.atMs - q.atMs);
        return { id: a.id, kind: a.kind, required: a.required, status: 'fail', ...base, firstFailure: { assertionId: a.id, ...cands[0], test: base.test } };
      }
      if (missing.length) {
        const why = complete ? 'the trace ends before their deadline' : incompleteWhy;
        return inconclusive(a, `${missing.length} request${missing.length === 1 ? ' has' : 's have'} no observed response, and ${why}`, base);
      }
      if (unc) return inconclusive(a, `no correlation identifier for ${unc} event${unc === 1 ? '' : 's'}`, base);
      return { id: a.id, kind: a.kind, required: a.required, status: 'pass', ...base };
    }
    case 'never-observed': {
      const hits = ctx.trace.events.filter((e) => e.kind === a.observedKind && matchesWhen(a.when, e));
      const base = { evidence: { observedIds: ids(hits) }, test: `no "${a.observedKind}" event is observed` };
      if (hits.length) {
        const h = hits[0];
        return { id: a.id, kind: a.kind, required: a.required, status: 'fail', ...base, firstFailure: { assertionId: a.id, type: 'observed_forbidden_output', atMs: h.timeMs, subject: h.subject == null ? null : h.subject, expectedKind: null, observedKind: h.kind, cause: `"${h.kind}" was observed`, relatedEventIds: [h.id] } };
      }
      if (!complete) return inconclusive(a, `nothing was observed, but absence only counts when completeness is declared (it is "${ctx.completeness}")`, base);
      return { id: a.id, kind: a.kind, required: a.required, status: 'pass', ...base };
    }
    default:
      return inconclusive(a, 'unknown assertion kind', {});
  }
}

export function aggregateStatus(results) {
  const req = results.filter((r) => r.required);
  if (req.some((r) => r.status === 'fail')) return 'fail';
  if (!req.length || req.some((r) => r.status === 'inconclusive')) return 'inconclusive';
  return 'pass';
}

