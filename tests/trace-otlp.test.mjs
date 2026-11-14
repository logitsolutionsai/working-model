// The OTLP JSON subset: only spans and span events with the configured kind
// attribute become events; span names are never read as domain events;
// nanosecond times convert exactly; unsupported parts are reported.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeOtlp } from '../src/trace/otlp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'working-model.mjs');
const s = (v) => ({ stringValue: v });

function doc() {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: s('payments') }] },
      scopeSpans: [{
        scope: { name: 'demo' },
        spans: [
          { traceId: 'a1', spanId: 'span01', name: 'POST /pay accepted', startTimeUnixNano: '1763114400000000000', endTimeUnixNano: '1763114400020000000',
            attributes: [{ key: 'wm.event', value: s('request') }, { key: 'request.id', value: s('req-1') }, { key: 'http.route', value: s('/pay') }, { key: 'http.request.header.authorization', value: s('Bearer x') }, { key: 'tags', value: { arrayValue: { values: [] } } }],
            events: [{ timeUnixNano: '1763114400020500000', name: 'done', attributes: [{ key: 'wm.event', value: s('accepted') }, { key: 'request.id', value: s('req-1') }] }] },
          { traceId: 'a1', spanId: 'span02', name: 'accepted', startTimeUnixNano: '1763114400030000000', attributes: [{ key: 'http.route', value: s('/pay') }] },
        ],
      }],
    }],
    resourceLogs: [],
  };
}

describe('OTLP subset', () => {
  test('reads spans and span events by the kind attribute, never by span name', () => {
    const t = normalizeOtlp(doc(), { origin: 'first-event', subjectAttribute: 'request.id', allowAttrs: ['http.route'] });
    assert.deepEqual(t.events.map((e) => [e.id, e.kind, e.timeMs, e.subject]), [['span01', 'request', 0, 'req-1'], ['span01.e0', 'accepted', 20.5, 'req-1']]);
    assert.deepEqual(t.events[0].attrs, { 'http.route': '/pay' });
    const codes = t.warnings.map((w) => w.code);
    for (const c of ['W_OTLP_UNSUPPORTED', 'W_OTLP_NO_KIND', 'W_ATTRS_DROPPED', 'W_OTLP_SAMPLED']) assert.ok(codes.includes(c), c);
    assert.equal(t.completeness, 'unknown');
    assert.ok(!JSON.stringify(t).includes('Bearer'));
  });

  test('nanoseconds convert exactly, far from the Unix epoch', () => {
    const d = doc();
    d.resourceSpans[0].scopeSpans[0].spans[0].events[0].timeUnixNano = '1763114400000000001';
    const t = normalizeOtlp(d, { origin: 'first-event' });
    assert.equal(t.events[1].timeMs, 0.000001);
  });

  test('absolute times need an origin; logs-only documents are refused', () => {
    assert.throws(() => normalizeOtlp(doc(), {}), (e) => e.code === 'E_TRACE_ABSOLUTE_TIME');
    assert.throws(() => normalizeOtlp({ resourceLogs: [] }, {}), (e) => e.code === 'E_OTLP_SCHEMA');
    const bad = doc();
    bad.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano = '12.5';
    assert.throws(() => normalizeOtlp(bad, { origin: 'first-event' }), (e) => e.code === 'E_TRACE_TIME');
    const late = normalizeOtlp(doc(), { origin: '2025-11-14T09:59:59Z' });
    assert.equal(late.events[0].timeMs, 1000);
    assert.throws(() => normalizeOtlp(doc(), { origin: '2025-11-14T10:00:01Z' }), (e) => e.code === 'E_TRACE_NEGATIVE_TIME');
  });

  test('trace import --format otlp on the command line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-otlp-'));
    const f = path.join(dir, 'spans.json');
    fs.writeFileSync(f, JSON.stringify(doc()));
    const r = spawnSync(process.execPath, [CLI, 'trace', 'import', f, '--format', 'otlp', '--origin', 'first-event', '--subject-attribute', 'request.id', '--out', path.join(dir, 'n.json'), '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.format, 'otlp');
    assert.equal(j.events, 2);
  });
});
