// Model versus observed: replay the trace's inputs through the model, match
// predicted outputs to observed ones, and evaluate the observed assertions.
// The model's own claims are checked elsewhere (check) and reported beside
// this, never merged into it.
// Pure module: no Node or browser APIs.

import { TraceError } from './errors.mjs';
import { observedValue, inputFor } from './mapping.mjs';
import { planInputs, replayRun, emitSubject } from './replay.mjs';
import { matchEvents } from './match.mjs';
import { evaluateAssertion, aggregateStatus } from './assertions.mjs';

export const REALITY_VERSION = '1';

export function evaluateReality(model, trace, mapping, opts = {}) {
  const warnings = [];
  const plan = planInputs(trace, mapping, model);
  const outKinds = new Map(mapping.outputs.map((o) => [o.observedKind, o]));
  const assertionKinds = new Set();
  for (const a of mapping.assertions) for (const k of [a.first, a.then, a.request, a.response, a.observedKind]) if (k) assertionKinds.add(k);
  // coverage of the observed trace
  const unmappedKinds = {};
  let inputMapped = 0;
  let outputMapped = 0;
  let unmapped = 0;
  for (const e of trace.events) {
    if (inputFor(mapping, e)) inputMapped++;
    else if (outKinds.has(e.kind)) outputMapped++;
    else if (!assertionKinds.has(e.kind)) { unmapped++; unmappedKinds[e.kind] = (unmappedKinds[e.kind] || 0) + 1; }
  }
  if (unmapped && !mapping.allowUnknownObserved) {
    const kind = Object.keys(unmappedKinds).sort()[0];
    throw new TraceError('E_TRACE_UNKNOWN_KIND', `${unmapped} observed event${unmapped === 1 ? '' : 's'} have kinds the mapping does not know, such as "${kind}"`, 'allowUnknownObserved', 'map them, or set "allowUnknownObserved": true to count them as unmapped');
  }
  const traceEndMs = trace.events.length ? trace.events[trace.events.length - 1].timeMs : 0;
  const report = {
    schemaVersion: 1, kind: 'working-model-reality-report', verificationVersion: REALITY_VERSION,
    status: 'inconclusive', completeness: trace.completeness,
    observedAssertions: { passed: 0, failed: 0, inconclusive: 0, total: mapping.assertions.length, results: [] },
    coverage: {
      observedEvents: trace.events.length, inputMapped, outputMapped, observedUnmapped: unmapped, unmappedKinds,
      modelOutputs: 0, modelOutputsUnmapped: {}, uncorrelated: 0,
    },
    replay: {
      mode: 'replace-inputs', timeOrigin: mapping.timeOrigin, originMs: plan.originMs, dtMs: mapping.dtMs,
      inputsReplayed: plan.inputs.length, internalEvents: mapping.internalEvents,
      maxQuantizationErrorMs: plan.maxQuantErrorMs || 0, toleranceMs: mapping.toleranceMs, ticks: 0, error: null,
    },
    outputs: [], firstMismatch: null, warnings,
  };
  if (trace.completeness !== 'declared-complete') warnings.push({ code: 'W_COMPLETENESS', message: `trace completeness is "${trace.completeness}": missing observed events make assertions inconclusive, not failed` });
  if (plan.noInputs) {
    report.status = 'inconclusive';
    report.inconclusiveReason = 'the trace has no events mapped to model inputs, so nothing was replayed';
    for (const a of mapping.assertions) report.observedAssertions.results.push({ id: a.id, kind: a.kind, required: a.required, status: 'inconclusive', inconclusiveReason: report.inconclusiveReason });
    report.observedAssertions.inconclusive = mapping.assertions.length;
    return { report, run: null };
  }
  // run long enough to cover every mapped observed event plus the widest window
  const toTick = (ms) => Math.round((ms - plan.originMs) / mapping.dtMs);
  let lastMs = plan.originMs;
  for (const e of trace.events) {
    if (inputFor(mapping, e) || outKinds.has(e.kind)) {
      if (e.timeMs < plan.originMs) {
        throw new TraceError('E_TRACE_NEGATIVE_TIME', `event ${e.id} is ${plan.originMs - e.timeMs} ms before the first model input, the time origin`, e.id, 'set "timeOrigin": "zero" in the mapping, or trim the trace');
      }
      lastMs = Math.max(lastMs, e.timeMs);
    }
  }
  const widest = mapping.outputs.reduce((w, o) => Math.max(w, o.withinMs), 0);
  const run = replayRun(model, plan, mapping, { params: opts.params, lastTick: toTick(lastMs), horizonTicks: Math.ceil(widest / mapping.dtMs) });
  report.replay.ticks = run.K;
  if (run.error) {
    report.status = 'error';
    report.replay.error = { code: run.error.code, message: run.error.message, location: run.error.loc ? run.error.loc.path : null, at: run.error.at };
    return { report, run };
  }
  // predicted outputs
  const outputs = new Map();
  const unmappedEmits = {};
  const byName = new Map(mapping.outputs.map((o) => [o.modelEmit, []]));
  let key = 0;
  for (let k = 0; k <= run.K; k++) {
    for (const rec of run.emits[k]) {
      const list = byName.get(rec.name);
      if (!list) { unmappedEmits[rec.name] = (unmappedEmits[rec.name] || 0) + 1; continue; }
      list.push({ rec, k, key: key++ });
    }
  }
  let uncorrelated = 0;
  for (const o of mapping.outputs) {
    const expected = byName.get(o.modelEmit).map(({ rec, k, key: kk }) => ({
      key: kk, tick: k, timeMs: plan.originMs + k * mapping.dtMs, subject: emitSubject(run, rec, o),
      causedBy: rec.input != null ? run.inputs[rec.input].eventId : null,
    }));
    const observed = trace.events.filter((e) => e.kind === o.observedKind).map((e) => ({ id: e.id, kind: e.kind, timeMs: e.timeMs, subject: observedValue(o.observedSubjectFrom, e) }));
    const match = matchEvents(expected, observed, o.withinMs);
    uncorrelated += match.uncorrelatedExpected.length + match.uncorrelatedObserved.length;
    outputs.set(o.modelEmit, { output: o, expected, observed, match });
    report.coverage.modelOutputs += expected.length;
    report.outputs.push({
      modelEmit: o.modelEmit, observedKind: o.observedKind, withinMs: o.withinMs, expected: expected.length, observed: observed.length,
      matched: match.pairs.length, unmatchedExpected: match.unmatchedExpected.length, unmatchedObserved: match.unmatchedObserved.length,
      uncorrelated: match.uncorrelatedExpected.length + match.uncorrelatedObserved.length, skew: match.skew,
    });
  }
  report.coverage.modelOutputsUnmapped = unmappedEmits;
  report.coverage.uncorrelated = uncorrelated;
  const ctx = { trace, completeness: trace.completeness, outputs, traceEndMs };
  const results = mapping.assertions.map((a) => evaluateAssertion(a, ctx));
  report.observedAssertions.results = results;
  report.observedAssertions.passed = results.filter((r) => r.status === 'pass').length;
  report.observedAssertions.failed = results.filter((r) => r.status === 'fail').length;
  report.observedAssertions.inconclusive = results.filter((r) => r.status === 'inconclusive').length;
  report.status = aggregateStatus(results);
  if (!mapping.assertions.length) report.inconclusiveReason = 'the mapping has no assertions';
  const fails = results.filter((r) => r.status === 'fail' && r.firstFailure).map((r) => r.firstFailure).sort((p, q) => p.atMs - q.atMs);
  report.firstMismatch = fails.length ? fails[0] : null;
  return { report, run, outputs };
}
