// Trace import: JSONL parsing, ordering, ids, time forms, limits and the
// attribute allowlist. Every bad input is a stable error code with a line.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJsonl, validateNormalized, parseIsoMs, TRACE_LIMITS } from '../src/trace/normalize.mjs';
import { canonicalJSON } from '../src/trace/errors.mjs';

const jsonl = (recs) => recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code + (e.location ? ' @ ' + e.location : ''); } return 'no error'; };

describe('trace import (JSONL)', () => {
  test('equal timestamps keep record order; times sort; ids are stable', () => {
    const t = normalizeJsonl(jsonl([
      { timeMs: 20, kind: 'b' }, { timeMs: 10, kind: 'a' }, { timeMs: 20, kind: 'c' }, { timeMs: 10, kind: 'd' },
    ]));
    assert.deepEqual(t.events.map((e) => e.kind), ['a', 'd', 'b', 'c']);
    assert.deepEqual(t.events.map((e) => e.id), ['ev-00002', 'ev-00004', 'ev-00001', 'ev-00003']);
    assert.ok(t.warnings.some((w) => w.code === 'W_TRACE_REORDERED'));
  });

  test('strict mode refuses records out of time order and unknown kinds', () => {
    assert.match(codeOf(() => normalizeJsonl(jsonl([{ timeMs: 20, kind: 'a' }, { timeMs: 10, kind: 'a' }]), { strict: true })), /^E_TRACE_NOT_MONOTONIC @ line 2/);
    assert.match(codeOf(() => normalizeJsonl(jsonl([{ timeMs: 1, kind: 'a' }, { timeMs: 2, kind: 'zzz' }]), { strict: true, knownKinds: new Set(['a']) })), /^E_TRACE_UNKNOWN_KIND @ line 2/);
  });

  test('absolute UTC times need a declared origin, and then become relative', () => {
    const text = jsonl([{ ts: '2026-11-14T10:00:00.250Z', kind: 'a' }, { ts: '2026-11-14T11:00:00.000+01:00', kind: 'b' }]);
    assert.match(codeOf(() => normalizeJsonl(text)), /^E_TRACE_ABSOLUTE_TIME/);
    const t = normalizeJsonl(text, { origin: 'first-event' });
    assert.deepEqual(t.events.map((e) => [e.kind, e.timeMs]), [['b', 0], ['a', 250]]);
    const t2 = normalizeJsonl(text, { origin: '2026-11-14T09:59:59Z' });
    assert.deepEqual(t2.events.map((e) => e.timeMs), [1000, 1250]);
    assert.equal(parseIsoMs('2026-11-14 10:00'), null);
    assert.match(codeOf(() => normalizeJsonl(jsonl([{ ts: '2026-11-14T10:00:00Z', kind: 'a' }, { timeMs: 3, kind: 'b' }]), { origin: 'first-event' })), /^E_TRACE_TIME/);
  });

  test('Unicode kinds, subjects and attribute values survive', () => {
    const t = normalizeJsonl(jsonl([{ timeMs: 0, kind: 'zahlung_fehlgeschlagen', subject: 'Kunde-Ü-7', attrs: { route: 'パス' } }]), { allowAttrs: ['route'] });
    assert.equal(t.events[0].subject, 'Kunde-Ü-7');
    assert.equal(t.events[0].attrs.route, 'パス');
  });

  test('bad lines fail with their line number', () => {
    assert.equal(codeOf(() => normalizeJsonl('{"timeMs":0,"kind":"a"}\n{not json}\n')), 'E_TRACE_JSON @ line 2');
    assert.equal(codeOf(() => normalizeJsonl(jsonl([{ timeMs: 0, kind: 'a', id: 'x' }, { timeMs: 1, kind: 'a', id: 'x' }]))), 'E_TRACE_DUPLICATE_ID @ line 2');
    assert.equal(codeOf(() => normalizeJsonl('{"timeMs":1e999,"kind":"a"}\n')), 'E_TRACE_NONFINITE @ line 1');
    assert.equal(codeOf(() => normalizeJsonl('{"timeMs":1,"kind":"a","attrs":{"n":-1e999}}\n')), 'E_TRACE_NONFINITE @ line 1');
    assert.equal(codeOf(() => normalizeJsonl(jsonl([{ kind: 'a' }]))), 'E_TRACE_TIME @ line 1');
    assert.equal(codeOf(() => normalizeJsonl(jsonl([{ timeMs: -5, kind: 'a' }]))), 'E_TRACE_NEGATIVE_TIME @ line 1');
    assert.equal(codeOf(() => normalizeJsonl(jsonl([{ timeMs: 0, kind: '' }]))), 'E_TRACE_KIND @ line 1');
    assert.equal(codeOf(() => normalizeJsonl(jsonl([{ timeMs: 0, kind: 'a', attrs: { deep: { x: 1 } } }]))), 'E_TRACE_NESTED @ line 1');
    assert.equal(codeOf(() => normalizeJsonl(jsonl([{ timeMs: 0, kind: 'a', attrs: { list: [1, 2] } }]))), 'E_TRACE_NESTED @ line 1');
    assert.equal(codeOf(() => normalizeJsonl(jsonl(['[1,2]']))), 'E_TRACE_RECORD @ line 1');
    assert.equal(codeOf(() => normalizeJsonl(jsonl([{ timeMs: 0, kind: 'a', subject: 'x'.repeat(300) }]))), 'E_TRACE_SUBJECT @ line 1');
  });

  test('a file over the byte limit is refused; over the event limit it is truncated and marked incomplete', () => {
    assert.match(codeOf(() => normalizeJsonl('x', { bytes: TRACE_LIMITS.defaultBytes + 1 })), /^E_TRACE_TOO_LARGE/);
    assert.match(codeOf(() => normalizeJsonl('x', { maxEvents: TRACE_LIMITS.hardEvents + 1 })), /^E_TRACE_LIMIT/);
    const many = jsonl(Array.from({ length: 30 }, (_, i) => ({ timeMs: i, kind: 'a' })));
    const t = normalizeJsonl(many, { maxEvents: 10, complete: true });
    assert.equal(t.events.length, 10);
    assert.equal(t.completeness, 'known-incomplete');
    assert.ok(t.warnings.some((w) => w.code === 'W_TRACE_TRUNCATED'));
    assert.ok(t.warnings.some((w) => w.code === 'W_COMPLETE_IGNORED'));
  });

  test('attributes are kept only when allowlisted; the rest are dropped and counted', () => {
    const t = normalizeJsonl(jsonl([{ timeMs: 0, kind: 'a', attrs: { route: '/x', authorization: 'Bearer abc', ip: '203.0.113.9' }, extra: 1 }]), { allowAttrs: ['route'] });
    assert.deepEqual(t.events[0].attrs, { route: '/x' });
    assert.equal(t.stats.droppedAttrs, 2);
    assert.equal(t.stats.droppedFields, 1);
    assert.ok(!JSON.stringify(t.events).includes('Bearer'));
    assert.ok(t.warnings.some((w) => w.code === 'W_ATTRS_DROPPED'));
  });

  test('completeness is unknown unless declared, and never guessed', () => {
    const recs = jsonl([{ timeMs: 0, kind: 'a' }]);
    assert.equal(normalizeJsonl(recs).completeness, 'unknown');
    assert.equal(normalizeJsonl(recs, { complete: true }).completeness, 'declared-complete');
  });

  test('a normalized trace read back is validated again', () => {
    const t = normalizeJsonl(jsonl([{ timeMs: 0, kind: 'a' }, { timeMs: 5, kind: 'b' }]));
    assert.doesNotThrow(() => validateNormalized(JSON.parse(JSON.stringify(t))));
    const bad = JSON.parse(JSON.stringify(t));
    bad.events[1].timeMs = -1;
    assert.match(codeOf(() => validateNormalized(bad)), /^E_TRACE_SCHEMA/);
    const dup = JSON.parse(JSON.stringify(t));
    dup.events[1].id = dup.events[0].id;
    assert.match(codeOf(() => validateNormalized(dup)), /^E_TRACE_DUPLICATE_ID/);
    const nested = JSON.parse(JSON.stringify(t));
    nested.events[0].attrs = { x: { y: 1 } };
    assert.match(codeOf(() => validateNormalized(nested)), /^E_TRACE_NESTED/);
  });

  test('canonical JSON sorts keys and is stable', () => {
    assert.equal(canonicalJSON({ b: 1, a: [0.1, -0, { d: true, c: null }] }), '{"a":[0.1,0,{"c":null,"d":true}],"b":1}');
    assert.throws(() => canonicalJSON({ x: NaN }), /non-finite/);
  });
});

describe('optional recording adapter', () => {
  test('writes JSONL that trace import reads, and stops at its byte limit', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { openRecorder } = await import('../examples/reality-bridge/recording-adapter.mjs');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-rec-')), 't.jsonl');
    let clock = 0;
    const rec = openRecorder(file, { maxBytes: 400, now: () => clock });
    for (let i = 0; i < 20; i++) { clock += 5; rec.event({ kind: 'request', subject: 'r' + i, attrs: { route: '/x', nested: { no: 1 } } }); }
    const s = rec.close();
    assert.ok(s.dropped > 0);
    const t = normalizeJsonl(fs.readFileSync(file, 'utf8'), { allowAttrs: ['route'] });
    assert.equal(t.events[0].timeMs, 5);
    assert.deepEqual(t.events[0].attrs, { route: '/x' });
    assert.equal(t.events.length, 20 - s.dropped);
  });
});
