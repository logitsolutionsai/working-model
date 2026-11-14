// Matching and observed assertions: one-to-one pairs, subjects kept apart,
// no matches by timing alone, completeness deciding fail versus
// inconclusive, and the demo where every model claim passes while the
// declared-complete trace disagrees.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchEvents } from '../src/trace/match.mjs';
import { evaluateAssertion, aggregateStatus } from '../src/trace/assertions.mjs';
import { validateMapping } from '../src/trace/mapping.mjs';
import { evaluateReality } from '../src/trace/conformance.mjs';
import { compileModel } from '../src/engine/model.mjs';
import { checkWithTrace } from '../src/node/reality.mjs';
import { counterSpec } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RB = path.join(ROOT, 'examples', 'reality-bridge');

const exp = (key, timeMs, subject) => ({ key, timeMs, subject });
const obs = (id, timeMs, subject) => ({ id, timeMs, subject });

describe('matching', () => {
  test('two expected outputs and one observed event give at most one match', () => {
    const m = matchEvents([exp(0, 100, 's'), exp(1, 110, 's')], [obs('o1', 105, 's')], 50);
    assert.equal(m.pairs.length, 1);
    assert.equal(m.unmatchedExpected.length, 1);
    assert.equal(m.pairs[0].expected.key, 0);
  });

  test('two subjects at the same time stay distinct', () => {
    const m = matchEvents([exp(0, 100, 'a'), exp(1, 100, 'b')], [obs('o1', 100, 'b'), obs('o2', 100, 'a')], 10);
    assert.deepEqual(m.pairs.map((p) => [p.expected.subject, p.observed.id]), [['a', 'o2'], ['b', 'o1']]);
  });

  test('a duplicate observed event cannot satisfy one expected output twice', () => {
    const m = matchEvents([exp(0, 100, 's')], [obs('o1', 100, 's'), obs('o2', 101, 's')], 10);
    assert.equal(m.pairs.length, 1);
    assert.deepEqual(m.unmatchedObserved.map((o) => o.id), ['o2']);
  });

  test('events without a subject are never matched by timing alone', () => {
    const m = matchEvents([exp(0, 100, null)], [obs('o1', 100, null), obs('o2', 100, null)], 10);
    assert.equal(m.pairs.length, 0);
    assert.equal(m.uncorrelatedExpected.length, 1);
    assert.equal(m.uncorrelatedObserved.length, 2);
  });

  test('maximum cardinality with a deterministic tie-break', () => {
    // greedy-by-nearest would pair e0 with o2 and leave e1 alone; the earliest-available rule pairs both
    const m = matchEvents([exp(0, 100, 's'), exp(1, 140, 's')], [obs('o1', 70, 's'), obs('o2', 110, 's')], 40);
    assert.equal(m.pairs.length, 2);
    const again = matchEvents([exp(0, 100, 's'), exp(1, 140, 's')], [obs('o2', 110, 's'), obs('o1', 70, 's')], 40);
    assert.deepEqual(again.pairs.map((p) => p.observed.id), m.pairs.map((p) => p.observed.id));
    const tie = matchEvents([exp(0, 100, 's')], [obs('b', 100, 's'), obs('a', 100, 's')], 0);
    assert.equal(tie.pairs[0].observed.id, 'a');
  });

  test('ten thousand correlated events match in one pass', () => {
    const E = [];
    const O = [];
    for (let i = 0; i < 10000; i++) { E.push(exp(i, i * 10, 's' + (i % 50))); O.push(obs('o' + i, i * 10 + 3, 's' + (i % 50))); }
    const t0 = performance.now();
    const m = matchEvents(E, O, 5);
    assert.equal(m.pairs.length, 10000);
    assert.ok(performance.now() - t0 < 2000);
  });
});

function tinyModel() {
  const spec = counterSpec({
    state: { n: 0, fired: 0 },
    events: [{ name: 'ping', at: [2, 5] }],
    rules: { on: { ping: ["emit('pong', seq)"] } },
    claims: [], narration: [],
  });
  const { model, errors } = compileModel(spec);
  assert.deepEqual(errors, []);
  return model;
}

function mappingFor(model, extra = {}) {
  return validateMapping({
    schemaVersion: 1, msPerModelUnit: 1000, timeOrigin: 'zero',
    inputs: [{ observedKind: 'req', modelEvent: 'ping', modelPayloadKey: 'rid' }],
    outputs: [{ modelEmit: 'pong', observedKind: 'resp', modelSubjectFrom: 'event.rid', observedSubjectFrom: 'subject', withinMs: 500 }],
    assertions: [{ id: 'pongs', kind: 'event-correspondence', modelEmit: 'pong' }],
    ...extra,
  }, model);
}

const ev = (id, timeMs, kind, subject) => ({ id, timeMs, kind, subject, attrs: {} });

describe('observed assertions', () => {
  test('a missing observed output fails when the trace is declared complete, and is inconclusive otherwise', () => {
    const model = tinyModel();
    const mapping = mappingFor(model);
    const events = [ev('e1', 1000, 'req', 'r1'), ev('e2', 1000, 'resp', 'r1'), ev('e3', 3000, 'req', 'r2')];
    const complete = evaluateReality(model, { completeness: 'declared-complete', events }, mapping).report;
    assert.equal(complete.status, 'fail');
    assert.equal(complete.firstMismatch.type, 'missing_observed_output');
    assert.equal(complete.firstMismatch.subject, 'r2');
    assert.deepEqual(complete.firstMismatch.relatedEventIds, ['e3']);
    assert.equal(complete.firstMismatch.cause, 'Unmatched expected output; trace declared complete');
    const unknown = evaluateReality(model, { completeness: 'unknown', events }, mapping).report;
    assert.equal(unknown.status, 'inconclusive');
    assert.equal(unknown.observedAssertions.results[0].status, 'inconclusive');
    assert.match(unknown.observedAssertions.results[0].inconclusiveReason, /completeness is "unknown"/);
  });

  test('event.<key> correlates each output with the input that caused it', () => {
    const model = tinyModel();
    const mapping = mappingFor(model);
    const events = [ev('e1', 1000, 'req', 'r1'), ev('e2', 1000, 'req', 'r2'), ev('e3', 1100, 'resp', 'r2'), ev('e4', 1200, 'resp', 'r1')];
    const { report } = evaluateReality(model, { completeness: 'declared-complete', events }, mapping);
    assert.equal(report.status, 'pass');
    assert.equal(report.outputs[0].matched, 2);
    assert.equal(report.observedAssertions.results[0].metrics.precision, 1);
  });

  test('payloadIsSeqOf maps a seq payload back to the observed subject', () => {
    const model = tinyModel();
    const mapping = mappingFor(model, {
      outputs: [{ modelEmit: 'pong', observedKind: 'resp', modelSubjectFrom: 'payload', payloadIsSeqOf: 'ping', observedSubjectFrom: 'subject', withinMs: 500 }],
    });
    const events = [ev('e1', 1000, 'req', 'r1'), ev('e2', 2000, 'req', 'r2'), ev('e3', 2100, 'resp', 'r2'), ev('e4', 1100, 'resp', 'r1')];
    const { report } = evaluateReality(model, { completeness: 'declared-complete', events }, mapping);
    assert.equal(report.status, 'pass');
  });

  test('outputs without a correlation rule are inconclusive, never matched by time', () => {
    const model = tinyModel();
    const mapping = mappingFor(model, { outputs: [{ modelEmit: 'pong', observedKind: 'resp' }] });
    const events = [ev('e1', 1000, 'req', 'r1'), ev('e2', 1000, 'resp', 'r1')];
    const { report } = evaluateReality(model, { completeness: 'declared-complete', events }, mapping);
    assert.equal(report.status, 'inconclusive');
    assert.match(report.observedAssertions.results[0].inconclusiveReason, /no correlation identifier/);
  });

  test('zero denominators are undefined with an explanation, never 100%', () => {
    const model = tinyModel();
    const mapping = mappingFor(model);
    const { report } = evaluateReality(model, { completeness: 'declared-complete', events: [ev('e1', 0, 'other', null), ev('e0', 0, 'req', null)] }, mapping);
    // one input without a subject: the model emits once, uncorrelated
    assert.equal(report.observedAssertions.results[0].status, 'inconclusive');
    const a = evaluateAssertion(mapping.assertions[0], {
      completeness: 'declared-complete', traceEndMs: 0, trace: { events: [] },
      outputs: new Map([['pong', { output: mapping.outputs[0], expected: [], observed: [], match: matchEvents([], [], 10) }]]),
    });
    assert.equal(a.status, 'inconclusive');
    assert.equal(a.metrics.precision, 'undefined');
    assert.equal(a.metrics.recall, 'undefined');
    assert.ok(a.metrics.notes.length === 2);
  });

  test('a trace with no model inputs is inconclusive, not a simulated pass', () => {
    const model = tinyModel();
    const { report } = evaluateReality(model, { completeness: 'declared-complete', events: [ev('e1', 0, 'resp', 'r1')] }, mappingFor(model));
    assert.equal(report.status, 'inconclusive');
    assert.match(report.inconclusiveReason, /no events mapped to model inputs/);
  });

  test('never-observed, response-before and event-order', () => {
    const trace = (completeness, events) => ({ completeness, traceEndMs: 10000, trace: { events }, outputs: new Map() });
    const never = { id: 'n', kind: 'never-observed', required: true, observedKind: 'boom', when: null };
    assert.equal(evaluateAssertion(never, trace('unknown', [])).status, 'inconclusive');
    assert.equal(evaluateAssertion(never, trace('declared-complete', [])).status, 'pass');
    const hit = evaluateAssertion(never, trace('unknown', [ev('b1', 5, 'boom', null)]));
    assert.equal(hit.status, 'fail');
    assert.deepEqual(hit.firstFailure.relatedEventIds, ['b1']);

    const rb = { id: 'r', kind: 'response-before', required: true, request: 'req', response: 'resp', withinMs: 100, by: 'subject' };
    assert.equal(evaluateAssertion(rb, trace('declared-complete', [ev('1', 0, 'req', 'a'), ev('2', 50, 'resp', 'a')])).status, 'pass');
    const late = evaluateAssertion(rb, trace('unknown', [ev('1', 0, 'req', 'a'), ev('2', 150, 'resp', 'a')]));
    assert.equal(late.status, 'fail');
    assert.equal(late.firstFailure.type, 'late_response');
    assert.equal(evaluateAssertion(rb, trace('unknown', [ev('1', 0, 'req', 'a')])).status, 'inconclusive');
    assert.equal(evaluateAssertion(rb, trace('declared-complete', [ev('1', 0, 'req', 'a')])).firstFailure.type, 'missing_response');

    const order = { id: 'o', kind: 'event-order', required: true, first: 'open', then: 'reject', by: 'subject' };
    assert.equal(evaluateAssertion(order, trace('declared-complete', [ev('1', 0, 'open', 'x'), ev('2', 5, 'reject', 'x')])).status, 'pass');
    assert.equal(evaluateAssertion(order, trace('declared-complete', [ev('2', 5, 'reject', 'x'), ev('1', 9, 'open', 'x')])).status, 'fail');
    assert.equal(evaluateAssertion(order, trace('unknown', [ev('2', 5, 'reject', 'x')])).status, 'inconclusive');
  });

  test('aggregate status: fail beats inconclusive beats pass; optional assertions do not count', () => {
    assert.equal(aggregateStatus([{ required: true, status: 'pass' }, { required: true, status: 'inconclusive' }]), 'inconclusive');
    assert.equal(aggregateStatus([{ required: true, status: 'fail' }, { required: true, status: 'inconclusive' }]), 'fail');
    assert.equal(aggregateStatus([{ required: true, status: 'pass' }, { required: false, status: 'fail' }]), 'pass');
    assert.equal(aggregateStatus([]), 'inconclusive');
  });
});

describe('claims versus reality (the demo)', () => {
  test('every model claim passes while the declared-complete trace disagrees, reported separately', () => {
    const { report } = checkWithTrace(path.join(RB, 'circuit-breaker.model.json'), {
      trace: path.join(RB, 'observed.normalized.json'), mapping: path.join(RB, 'trace-map.json'), probe: false,
    });
    assert.deepEqual(report.modelClaims, { passed: 4, total: 4, status: 'pass' });
    assert.equal(report.status, 'fail');
    assert.equal(report.exit, 1);
    assert.equal(report.firstMismatch.type, 'unexpected_observed_output');
    assert.equal(report.firstMismatch.atMs, 1800);
    assert.deepEqual(report.firstMismatch.relatedEventIds, ['ev-00011']);
    assert.match(report.modelDigest, /^sha256:[0-9a-f]{64}$/);
  });

  test('the window model with the corrected assumption agrees with the same trace', () => {
    const { report } = checkWithTrace(path.join(RB, 'circuit-breaker-window.model.json'), {
      trace: path.join(RB, 'observed.normalized.json'), mapping: path.join(RB, 'trace-map.json'), probe: false,
    });
    assert.equal(report.status, 'pass');
    assert.equal(report.exit, 0);
    assert.equal(report.observedAssertions.passed, 3);
  });

  test('strict-observed turns inconclusive into a failing exit, without inventing a failure', () => {
    const { report } = checkWithTrace(path.join(RB, 'circuit-breaker.model.json'), {
      trace: path.join(RB, 'observed-unknown.normalized.json'), mapping: path.join(RB, 'trace-map.json'), probe: false, strictObserved: true,
    });
    assert.equal(report.completeness, 'unknown');
    assert.equal(report.observedAssertions.failed, 0);
    assert.equal(report.status, 'inconclusive');
    assert.equal(report.exit, 1);
  });
});
