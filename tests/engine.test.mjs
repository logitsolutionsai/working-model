import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compileModel } from '../src/engine/model.mjs';
import { simulate } from '../src/engine/simulate.mjs';
import { checkClaims, explain } from '../src/engine/claims.mjs';
import { lintModel, probeParams, findLiteralNumbers } from '../src/engine/lint.mjs';
import { formatNumber, ordinal, parseTemplate, compileTemplate } from '../src/engine/format.mjs';
import { counterSpec } from './helpers.mjs';

function model(spec) {
  const { model: m, errors } = compileModel(spec);
  assert.deepEqual(errors.map((e) => e.code), []);
  return m;
}

describe('simulation', () => {
  test('same seed gives an identical trace', () => {
    const spec = counterSpec({
      state: { n: 0, fired: 0, noise: [] },
      rules: { tick: 'n += step\npush(noise, rand())', on: { ping: ['fired += 1', "emit('pong', n)"] } },
      events: [{ name: 'ping', at: [2, 5] }, { name: 'ping', rate: 0.7, from: 3 }],
    });
    const m = model(spec);
    const a = simulate(m, {});
    const b = simulate(m, {});
    assert.equal(JSON.stringify(a.snaps), JSON.stringify(b.snaps));
    assert.equal(JSON.stringify(a.emits), JSON.stringify(b.emits));
    assert.equal(JSON.stringify(a.fired), JSON.stringify(b.fired));
    const c = simulate(model({ ...spec, seed: 4 }), {});
    assert.notEqual(JSON.stringify(a.snaps), JSON.stringify(c.snaps));
  });
  test('tick rules run before the tick\'s events, and snapshots follow both', () => {
    const m = model(counterSpec());
    const tr = simulate(m, {});
    assert.equal(tr.K, 10);
    assert.equal(tr.snaps[0].n, 0);
    assert.equal(tr.snaps[2].n, 2);
    assert.equal(tr.snaps[2].fired, 1);
    assert.deepEqual(tr.emits[2].map((e) => [e.name, e.payload]), [['pong', 2]]);
    assert.deepEqual(tr.emits[5].map((e) => e.payload), [5]);
  });
  test('bursts, periodic events, seq and batch', () => {
    const m = model(counterSpec({
      state: { log: [] },
      events: [{ name: 'hit', at: 1, count: 'step * 3' }, { name: 'hit', every: 2, from: 4, until: 8 }],
      rules: { on: { hit: 'push(log, [t, seq, batch])' } },
      parts: [{ id: 'c', type: 'counter', at: [0, 0, 2, 2], value: 'len(log)' }],
      claims: [{ id: 'n', kind: 'at', t: 10, expr: 'len(log) == 6', text: 'six hits' }],
      narration: [],
    }));
    const log = simulate(m, {}).snaps[10].log;
    assert.deepEqual(log, [[1, 0, 0], [1, 1, 1], [1, 2, 2], [4, 3, 0], [6, 4, 0], [8, 5, 0]]);
    assert.equal(simulate(m, { step: 2 }).snaps[10].log.length, 9);
  });
  test('runtime errors stop the run and report where', () => {
    const m = model(counterSpec({ rules: { tick: 'n += 1 / (3 - tick)' } }));
    const tr = simulate(m, {});
    assert.equal(tr.error.code, 'E_DIV_ZERO');
    assert.equal(tr.error.at.tick, 3);
    assert.equal(tr.error.loc.path, 'rules.tick');
  });
  test('derived values are computed from state on demand', () => {
    const m = model(counterSpec({ derived: { double: 'n * 2', quad: 'double * 2' }, claims: [{ id: 'q', kind: 'at', t: 3, expr: 'quad == 12', text: 'quad' }], narration: [] }));
    assert.equal(checkClaims(m).passed, 1);
  });
});

describe('claims', () => {
  const kinds = (claims, extra = {}) => model(counterSpec({ claims, narration: [], ...extra }));
  test('at: pass and fail with a counterexample', () => {
    const m = kinds([
      { id: 'ok', kind: 'at', t: 4, expr: 'n == 4', text: 'n is four' },
      { id: 'bad', kind: 'at', t: 4, expr: 'n == 5', text: 'n is five' },
    ]);
    const r = checkClaims(m);
    assert.equal(r.passed, 1);
    const bad = r.results[1];
    assert.equal(bad.pass, false);
    assert.equal(bad.counterexample.t, 4);
    assert.deepEqual(bad.counterexample.values, { n: 4 });
    assert.equal(bad.line, 'fails at t = 4 s: n = 4');
  });
  test('always and never report the first violation', () => {
    const m = kinds([
      { id: 'a', kind: 'always', expr: 'n < 7', text: 'below seven' },
      { id: 'b', kind: 'never', expr: 'n == 3', text: 'never three' },
      { id: 'c', kind: 'always', expr: 'n < 7', until: 6, text: 'below seven early on' },
    ]);
    const r = checkClaims(m).results;
    assert.equal(r[0].counterexample.t, 7);
    assert.equal(r[1].counterexample.t, 3);
    assert.equal(r[2].pass, true);
  });
  test('eventually: deadline counterexample', () => {
    const m = kinds([
      { id: 'a', kind: 'eventually', expr: 'n >= 5', by: 6, text: 'reaches five' },
      { id: 'b', kind: 'eventually', expr: 'n >= 9', by: 6, text: 'reaches nine' },
    ]);
    const r = checkClaims(m).results;
    assert.equal(r[0].pass, true);
    assert.equal(r[0].stats.at, 5);
    assert.equal(r[1].counterexample.t, 6);
    assert.match(r[1].line, /^still false at t = 6 s: n = 6/);
  });
  test('whenever: checked right after each firing, with payload', () => {
    const m = kinds([
      { id: 'a', kind: 'whenever', event: 'pong', expr: 'payload == n', text: 'payload is n' },
      { id: 'b', kind: 'whenever', event: 'pong', expr: 'payload < 4', text: 'early pongs' },
      { id: 'c', kind: 'whenever', event: 'ping', expr: 'fired >= 1', text: 'fired counted' },
    ]);
    const r = checkClaims(m).results;
    assert.equal(r[0].pass, true);
    assert.equal(r[0].stats.fired, 2);
    assert.equal(r[1].pass, false);
    assert.equal(r[1].counterexample.t, 5);
    assert.equal(r[1].counterexample.payload, 5);
    assert.equal(r[2].pass, true);
  });
  test('whenever ... within: the response must come in time', () => {
    const m = kinds([
      { id: 'a', kind: 'whenever', event: 'ping', within: 2, expr: 'n >= 4', text: 'n reaches four soon after a ping' },
      { id: 'b', kind: 'whenever', event: 'ping', within: 1, expr: 'n >= 4', text: 'n reaches four very soon after a ping' },
    ]);
    const r = checkClaims(m).results;
    assert.equal(r[0].pass, true);
    assert.equal(r[1].pass, false);
    assert.equal(r[1].counterexample.firedAt, 2);
    assert.equal(r[1].counterexample.t, 3);
  });
  test('sweep without holdsWhen samples every param set', () => {
    const m = kinds([
      { id: 's', kind: 'sweep', samples: 10, claim: { kind: 'at', t: 10, expr: 'n == 10 * step' }, text: 'linear for any step' },
      { id: 'f', kind: 'sweep', samples: 10, claim: { kind: 'always', expr: 'n <= 20' }, text: 'stays small' },
    ]);
    const r = checkClaims(m).results;
    assert.equal(r[0].pass, true);
    assert.equal(r[0].stats.samples, 10);
    assert.equal(r[1].pass, false);
    assert.ok(r[1].counterexample.sample.step >= 3);
    assert.match(r[1].line, /^at step = \d: fails at t = \d+ s: n = \d+/);
  });
  test('sweep with holdsWhen: holds inside, fails outside, and both sides must be seen', () => {
    const exact = kinds([{ id: 'h', kind: 'sweep', samples: 12, holdsWhen: 'step >= 3', claim: { kind: 'eventually', expr: 'n >= 30' }, text: 'reaches thirty only with big steps' }]);
    const r = checkClaims(exact).results[0];
    assert.equal(r.pass, true, r.line);
    assert.ok(r.stats.inside > 0 && r.stats.outside > 0);
    const wrongBoundary = kinds([{ id: 'h', kind: 'sweep', samples: 12, holdsWhen: 'step >= 4', claim: { kind: 'eventually', expr: 'n >= 30' }, text: 'x' }]);
    const w = checkClaims(wrongBoundary).results[0];
    assert.equal(w.counterexample.note, 'outside');
    assert.match(w.line, /still holds, although holdsWhen is false/);
    const tooWide = kinds([{ id: 'h', kind: 'sweep', samples: 12, holdsWhen: 'step >= 2', claim: { kind: 'eventually', expr: 'n >= 30' }, text: 'x' }]);
    assert.equal(checkClaims(tooWide).results[0].counterexample.note, 'inside');
    const oneSided = kinds([{ id: 'h', kind: 'sweep', samples: 12, holdsWhen: 'step >= 1', claim: { kind: 'eventually', expr: 'n >= 10' }, text: 'x' }]);
    assert.equal(checkClaims(oneSided).results[0].counterexample.note, 'none-outside');
  });
  test('compare runs two param sets', () => {
    const m = kinds([
      { id: 'c', kind: 'compare', a: { step: 2 }, b: { step: 1 }, measure: { of: 'n', agg: 'final' }, expect: 'a == 2 * b', text: 'double step, double count' },
      { id: 'd', kind: 'compare', a: { step: 'step + 1' }, b: { step: 1 }, measure: { of: 'n', agg: 'max', label: 'top count' }, expect: 'a < b', text: 'x' },
    ]);
    const r = checkClaims(m).results;
    assert.equal(r[0].pass, true);
    assert.equal(r[0].stats.a, 20);
    assert.equal(r[1].pass, false);
    assert.equal(r[1].counterexample.a, 20);
    assert.equal(r[1].counterexample.b, 10);
    assert.equal(r[1].line, 'top count: a = 20 (step = 2), b = 10 (step = 1)');
  });
  test('compare aggregations', () => {
    for (const [agg, want] of [['max', 10], ['min', 0], ['mean', 5], ['sum', 55], ['final', 10]]) {
      const m = kinds([{ id: 'c', kind: 'compare', a: {}, b: {}, measure: { of: 'n', agg }, expect: `a == ${want}`, text: agg }]);
      assert.equal(checkClaims(m).results[0].pass, true, agg);
    }
  });
  test('a claim that is not true or false is an error, not a pass', () => {
    const m = kinds([{ id: 'x', kind: 'always', expr: 'n', text: 'number' }]);
    const r = checkClaims(m).results[0];
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'E_CLAIM_NOT_BOOLEAN');
  });
  test('claim text follows the params', () => {
    const m = kinds([{ id: 'x', kind: 'at', t: 10, expr: 'n == 10 * step', text: 'The {step * 10:ord} value is reached.' }]);
    assert.equal(checkClaims(m, { step: 2 }).results[0].text, 'The 20th value is reached.');
    assert.equal(explain(m, m.claims[0], checkClaims(m, { step: 2 }).results[0]), '');
  });
});

describe('lint', () => {
  test('literal numbers in text get a binding suggestion', () => {
    const m = model(counterSpec({ narration: [{ from: 0, text: 'Counting up by 1 with a 10 tick run, the 2nd pass.', cites: ['grows'] }] }));
    const issues = lintModel(m, checkClaims(m));
    const lit = issues.filter((i) => i.code === 'W_LITERAL_NUMBER');
    assert.deepEqual(lit.map((i) => i.message.match(/"(.+)"/)[1]), ['10', '2nd']);
    assert.match(lit[1].fix, /\{step \+ 1:ord\}/);
  });
  test('allowNumbers silences true constants', () => {
    const m = model(counterSpec({ narration: [{ from: 0, text: 'The rule of 72.', cites: ['grows'] }], lint: { allowNumbers: [72] } }));
    assert.equal(lintModel(m, checkClaims(m)).filter((i) => i.code === 'W_LITERAL_NUMBER').length, 0);
  });
  test('uncited claims, failing citations, constant and vacuous claims', () => {
    const m = model(counterSpec({
      claims: [
        { id: 'grows', kind: 'at', t: 10, expr: 'n == 99', text: 'wrong' },
        { id: 'lonely', kind: 'always', expr: 'step > 0', text: 'constant' },
        { id: 'quiet', kind: 'whenever', event: 'pong', expr: 'true', text: 'vacuous' },
      ],
      events: [],
      rules: { tick: 'n += step\nif n > 100 { emit(\'pong\') }' },
    }));
    const codes = lintModel(m, checkClaims(m)).map((i) => i.code + ':' + (i.path || ''));
    assert.ok(codes.includes('E_CITES_FAILING_CLAIM:narration[0].cites'));
    assert.ok(codes.includes('W_UNCITED_CLAIM:claims.lonely'));
    assert.ok(codes.includes('W_CONSTANT_CLAIM:claims.lonely.expr'));
    assert.ok(codes.includes('W_VACUOUS_CLAIM:claims.quiet'));
  });
  test('probes find the sliders that break claims', () => {
    const m = model(counterSpec({ claims: [{ id: 'small', kind: 'always', expr: 'n <= 30', text: 'stays at most thirty' }], narration: [] }));
    const probes = probeParams(m);
    assert.deepEqual(probes.map((p) => [p.param, p.value, p.failing]), [['step', 5, ['small']]]);
    const none = model(counterSpec({ claims: [{ id: 'pos', kind: 'always', expr: 'n >= 0', text: 'never negative' }], narration: [] }));
    const issues = lintModel(none, checkClaims(none), { probes: probeParams(none) });
    assert.ok(issues.some((i) => i.code === 'W_NOT_BREAKABLE'));
  });
  // regression: "{300} ms" slipped past the literal-number lint by sitting inside braces
  test('a constant inside braces is still a literal number', () => {
    const m = model(counterSpec({ narration: [{ from: 0, text: 'Within {300} ms, or {2 * 150}, but {step} and {n + 1} are bound.', cites: ['grows'] }] }));
    const issues = lintModel(m, checkClaims(m)).filter((i) => i.code === 'W_LITERAL_NUMBER');
    assert.deepEqual(issues.map((i) => i.message), ['caption has the constant {300}, which never follows the sliders', 'caption has the constant {2 * 150}, which never follows the sliders']);
  });
  test('number detection skips names like R0 and handles ordinals and percents', () => {
    assert.deepEqual(findLiteralNumbers('R0 is 2.5, the 11th of 40% and {x} {y:.1}').map((n) => n.raw), ['2.5', '11th', '40%']);
  });
});

describe('format', () => {
  test('numbers', () => {
    assert.equal(formatNumber(10.7), '10.7');
    assert.equal(formatNumber(10), '10');
    assert.equal(formatNumber(12345.6), '12,346');
    assert.equal(formatNumber(0.4166, '%'), '42%');
    assert.equal(formatNumber(0.4166, '.1%'), '41.7%');
    assert.equal(formatNumber(1234.567, ',.2'), '1,234.57');
    assert.equal(formatNumber(2.6, 'int'), '3');
    assert.equal(formatNumber(-0.0001, '.1'), '0.0');
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  });
  test('templates', () => {
    assert.deepEqual(parseTemplate('a {x > 1 ? "p" : "q"} {{b}} {y:%}', 't').map((p) => p.lit != null ? p.lit : `[${p.expr}|${p.fmt}]`), ['a ', '[x > 1 ? "p" : "q"|null]', ' {b} ', '[y|%]']);
    const f = compileTemplate('{n + 1:ord} of {cap}', 't', { state: new Set(['n']), params: new Set(['cap']) });
    assert.equal(f({ S: { n: 10 }, P: { cap: 12 }, L: [] }), '11th of 12');
  });
});

describe('limits on what a spec can make the engine do', () => {
  const errorOf = (over) => {
    const m = model(counterSpec({ narration: [], ...over }));
    const t0 = Date.now();
    const r = checkClaims(m);
    return { code: r.trace.error ? r.trace.error.code : null, ms: Date.now() - t0, r };
  };
  // regression: a burst of 1e9 with no handler, or rate 1e12, looped for minutes
  test('bursts and random arrivals are capped like periodic events', () => {
    for (const ev of [{ name: 'boom', at: 1, count: 1e9 }, { name: 'boom', rate: 1e12 }, { name: 'boom', at: [1, 2, 3], count: 100000 }]) {
      const { code, ms } = errorOf({ events: [{ name: 'ping', at: [2, 5] }, ev] });
      assert.equal(code, 'E_EVENT', JSON.stringify(ev));
      assert.ok(ms < 2000, `${ms} ms`);
    }
  });
  // regression: a 10000-item list kept for 100000 ticks ran Node out of memory
  test('the stored trace is capped', () => {
    const { code, ms } = errorOf({ dt: 1, duration: 99999, state: { n: 0, fired: 0, xs: 'fill(10000, 0)' } });
    assert.equal(code, 'E_TRACE_LIMIT');
    assert.ok(ms < 5000, `${ms} ms`);
  });
  // regression: forty 400-sample sweeps of a 100000-tick run took minutes in check and in the page
  test('all the runs of one claim check share one budget', () => {
    const claims = Array.from({ length: 40 }, (_, i) => ({ id: 's' + i, kind: 'sweep', samples: 400, vary: ['step'], claim: { kind: 'always', expr: 'n >= 0' }, text: 'x' }));
    const { r, ms } = errorOf({ dt: 0.01, duration: 1000, rules: { tick: 'n += 1' }, events: [], claims });
    assert.ok(ms < 15000, `${ms} ms`);
    const failed = r.results.filter((x) => !x.pass);
    assert.ok(failed.length > 0);
    assert.match(failed[0].line, /E_STEP_LIMIT checking the claims needs more than/);
  });
  test('names starting with "__" are refused for parts, claims, events and emits', () => {
    const codes = (spec) => compileModel(spec).errors.map((e) => e.code);
    assert.ok(codes(counterSpec({ parts: [{ id: '__proto__', type: 'counter', at: [0, 0, 2, 2], value: 'n' }] })).includes('E_NAME'));
    assert.ok(codes(counterSpec({ claims: [{ id: '__proto__', kind: 'always', expr: 'n >= 0', text: 'x' }], narration: [] })).includes('E_NAME'));
    assert.ok(codes(counterSpec({ events: [{ name: '__proto__', at: 1 }], rules: { tick: 'n += step' } })).includes('E_NAME'));
    assert.ok(codes(counterSpec({ rules: { tick: "n += step\nemit('__proto__')" } })).includes('E_EMIT_NAME'));
  });
});

describe('part expect: a binding checked against an independent expression', () => {
  const lintOf = (spec) => {
    const { model, errors } = compileModel(spec);
    assert.deepEqual(errors, []);
    return lintModel(model, checkClaims(model, {})).filter((i) => i.code === 'E_BINDING_EXPECT');
  };
  const spec = (part) => counterSpec({
    state: { n: 0, fired: 0, log: [] },
    rules: { tick: ['n += step', 'push(log, n)'], on: { ping: ['fired += 1', "emit('pong', n)"] } },
    parts: [part],
  });

  test('a counter that shows what its expect computes passes', () => {
    assert.deepEqual(lintOf(spec({ id: 'c', type: 'counter', at: [0, 0, 2, 2], value: 'n', expect: 'len(log) * step' })), []);
  });

  test('a counter that shows the wrong number is an error with the first moment it differs', () => {
    const issues = lintOf(spec({ id: 'c', type: 'counter', at: [0, 0, 2, 2], value: 'n + fired', expect: 'len(log) * step' }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'error');
    assert.equal(issues[0].path, 'parts.c.value');
    assert.match(issues[0].message, /shows value 3 at t = 2, but its expect "len\(log\) \* step" is 2/);
  });

  test('gauges and tanks take an expect too; an expect that errors is reported', () => {
    assert.equal(lintOf(spec({ id: 'g', type: 'gauge', at: [0, 0, 2, 2], value: 'n', max: 10, expect: 'n + 1' })).length, 1);
    assert.equal(lintOf(spec({ id: 'k', type: 'tank', at: [0, 0, 2, 2], level: 'n / 10', expect: 'n / 10' })).length, 0);
    const bad = lintOf(spec({ id: 'c', type: 'counter', at: [0, 0, 2, 2], value: 'n', expect: 'log[5]' }));
    assert.equal(bad.length, 1);
    assert.match(bad[0].message, /index 5 is outside/);
  });
});
