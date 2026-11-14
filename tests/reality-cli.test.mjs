// The mapping file and the Reality Bridge CLI: validation errors, safe
// paths from a spec, exit codes, --json errors as { code, message,
// location, fix }, and the report file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileModel } from '../src/engine/model.mjs';
import { validateMapping } from '../src/trace/mapping.mjs';
import { resolveSpecPath } from '../src/node/reality.mjs';
import { counterSpec } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'working-model.mjs');
const RB = path.join(ROOT, 'examples', 'reality-bridge');

function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: opts.cwd || ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wm-reality-')); }

const model = compileModel(counterSpec({ rules: { tick: 'n += step', on: { ping: ['fired += 1', "emit('pong', n)"] } } })).model;
const base = { schemaVersion: 1, msPerModelUnit: 1000, inputs: [{ observedKind: 'req', modelEvent: 'ping' }] };
const codeOf = (raw) => { try { validateMapping(raw, model); } catch (e) { return `${e.code} @ ${e.location}`; } return 'ok'; };

describe('mapping validation', () => {
  test('names must exist in the model', () => {
    assert.equal(codeOf({ ...base, inputs: [{ observedKind: 'req', modelEvent: 'nope' }] }), 'E_MAPPING_UNKNOWN_EVENT @ inputs[0].modelEvent');
    assert.equal(codeOf({ ...base, outputs: [{ modelEmit: 'nope', observedKind: 'x' }] }), 'E_MAPPING_UNKNOWN_EMIT @ outputs[0].modelEmit');
  });
  test('selectors are fixed forms, never expressions', () => {
    assert.equal(codeOf({ ...base, inputs: [{ observedKind: 'req', modelEvent: 'ping', subjectFrom: 'attrs.a + 1' }] }), 'E_MAPPING_SELECTOR @ inputs[0].subjectFrom');
    assert.equal(codeOf({ ...base, outputs: [{ modelEmit: 'pong', observedKind: 'x', modelSubjectFrom: 'payload.constructor', observedSubjectFrom: 'subject' }] }), 'E_MAPPING_SELECTOR @ outputs[0].modelSubjectFrom');
    assert.equal(codeOf({ ...base, outputs: [{ modelEmit: 'pong', observedKind: 'x', modelSubjectFrom: 'event.rid', observedSubjectFrom: 'subject' }] }), 'E_MAPPING_SELECTOR @ outputs[0].modelSubjectFrom');
    assert.equal(codeOf({ ...base, outputs: [{ modelEmit: 'pong', observedKind: 'x', modelSubjectFrom: 'payload' }] }), 'E_MAPPING_SELECTOR @ outputs[0]');
  });
  test('unknown keys, versions, units and limits are refused', () => {
    assert.equal(codeOf({ ...base, extra: 1 }), 'E_MAPPING_SCHEMA @ (root)');
    assert.equal(codeOf({ ...base, schemaVersion: 2 }), 'E_MAPPING_SCHEMA @ schemaVersion');
    assert.equal(codeOf({ schemaVersion: 1, modelTimeUnit: 'ms', inputs: base.inputs }), 'E_MAPPING_TIME_UNIT @ modelTimeUnit');
    assert.equal(codeOf({ ...base, outputs: [{ modelEmit: 'pong', observedKind: 'x', withinMs: 1e9 }] }), 'E_MAPPING_SCHEMA @ outputs[0].withinMs');
    assert.equal(codeOf({ ...base, assertions: [{ id: 'a', kind: 'event-correspondence', modelEmit: 'pong' }] }), 'E_MAPPING_SCHEMA @ assertions[0].modelEmit');
    assert.equal(codeOf({ ...base, assertions: [{ id: 'a', kind: 'proves-everything' }] }), 'E_MAPPING_SCHEMA @ assertions[0].kind');
    assert.equal(codeOf({ ...base, inputs: [base.inputs[0], base.inputs[0]] }), 'E_MAPPING_DUPLICATE @ inputs[1]');
  });
  test('the default window is one tick in milliseconds, at least 1 ms', () => {
    const m = validateMapping({ ...base, outputs: [{ modelEmit: 'pong', observedKind: 'x' }] }, model);
    assert.equal(m.outputs[0].withinMs, 1000);
    assert.equal(m.dtMs, 1000);
  });
});

describe('paths named in a spec', () => {
  test('stay inside the spec folder: no URLs, no absolute paths, no ".."', () => {
    const spec = path.join(RB, 'circuit-breaker.model.json');
    assert.equal(resolveSpecPath(spec, 'trace-map.json', 'x'), path.join(RB, 'trace-map.json'));
    for (const bad of ['../circuit-breaker.model.json', 'https://example.com/trace.json', path.join(ROOT, 'package.json'), 'sub/../../x.json', 'file:///etc/passwd']) {
      assert.throws(() => resolveSpecPath(spec, bad, 'reality.mapping'), (e) => e.code === 'E_REALITY_PATH', bad);
    }
  });
});

describe('trace import and check --trace on the command line', () => {
  test('import reports what was and was not mapped, and drops unlisted attributes', () => {
    const dir = tmp();
    const out = path.join(dir, 'n.json');
    const r = cli(['trace', 'import', path.join(RB, 'observed.jsonl'), '--mapping', path.join(RB, 'trace-map.json'), '--complete', '--out', out, '--json']);
    assert.equal(r.code, 0, r.err);
    const s = JSON.parse(r.out);
    assert.equal(s.completeness, 'declared-complete');
    assert.equal(s.kinds.heartbeat.mapped, false);
    assert.equal(s.kinds.call_failed.mapped, true);
    assert.deepEqual(s.keptAttrs, ['route']);
    const text = fs.readFileSync(out, 'utf8');
    for (const secret of ['Bearer', '203.0.113', '@example.com']) assert.ok(!text.includes(secret), secret);
    // the same input gives the same bytes
    const again = path.join(dir, 'n2.json');
    cli(['trace', 'import', path.join(RB, 'observed.jsonl'), '--mapping', path.join(RB, 'trace-map.json'), '--complete', '--out', again]);
    assert.equal(fs.readFileSync(again, 'utf8'), text);
  });

  test('a bad trace exits 2 with { code, message, location, fix }', () => {
    const dir = tmp();
    const f = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(f, '{"timeMs":0,"kind":"a"}\n{oops\n');
    const r = cli(['trace', 'import', f, '--json', '--out', path.join(dir, 'x.json')]);
    assert.equal(r.code, 2);
    const j = JSON.parse(r.out);
    assert.deepEqual(Object.keys(j.error).sort(), ['code', 'fix', 'location', 'message']);
    assert.equal(j.error.code, 'E_TRACE_JSON');
    assert.equal(j.error.location, 'line 2');
  });

  test('a missing trace file exits 3', () => {
    const r = cli(['trace', 'import', path.join(tmp(), 'missing.jsonl'), '--json']);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.out).error.code, 'E_READ');
  });

  test('check --trace: model claims pass, the observed assertion fails, exit 1, report written', () => {
    const dir = tmp();
    const report = path.join(dir, 'reality-report.json');
    const r = cli(['check', path.join(RB, 'circuit-breaker.model.json'), '--trace', path.join(RB, 'observed.normalized.json'), '--mapping', path.join(RB, 'trace-map.json'), '--report', report]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /Model: 4\/4 claims pass \| Observed: 1 pass, 2 fail, 0 inconclusive \| status fail/);
    assert.match(r.out, /unexpected_observed_output at 1800 ms/);
    const rep = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(rep.status, 'fail');
    assert.equal(rep.modelClaims.status, 'pass');
    assert.ok(!JSON.stringify(rep).includes('Bearer'));
  });

  test('check --trace uses the reality block of the spec when no files are given', () => {
    const dir = tmp();
    const r = cli(['check', path.join(RB, 'circuit-breaker-window.model.json'), '--trace', '--json', '--report', path.join(dir, 'r.json')]);
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(JSON.parse(r.out).status, 'pass');
  });

  test('a mapping that names an unknown model event exits 2', () => {
    const dir = tmp();
    const m = path.join(dir, 'map.json');
    fs.writeFileSync(m, JSON.stringify({ schemaVersion: 1, inputs: [{ observedKind: 'x', modelEvent: 'nope' }] }));
    const r = cli(['check', path.join(RB, 'circuit-breaker.model.json'), '--trace', path.join(RB, 'observed.normalized.json'), '--mapping', m, '--json', '--report', path.join(dir, 'r.json')]);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).error.code, 'E_MAPPING_UNKNOWN_EVENT');
  });

  test('a bare --trace before -o reads the spec reality block, and --preview before -o is a flag', () => {
    const dir = tmp();
    const page = path.join(dir, 'p.html');
    const r = cli(['build', path.join(RB, 'circuit-breaker-window.model.json'), '--trace', '-o', page]);
    assert.equal(r.code, 0, r.err + r.out);
    assert.ok(fs.existsSync(page));
    const pv = cli(['bundle', path.join(RB, 'circuit-breaker.model.json'), '--public', '--trace', path.join(RB, 'observed.normalized.json'), '--mapping', path.join(RB, 'trace-map.json'), '--synthetic', '--preview', '-o', path.join(dir, 'pv')]);
    assert.equal(pv.code, 0, pv.err);
    assert.ok(!fs.existsSync(path.join(dir, 'pv')));
  });

  test('plain check is unchanged by the reality block', () => {
    const r = cli(['check', path.join(RB, 'circuit-breaker.model.json'), '--json']);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).passed, 4);
  });
});

describe('JSON Schemas for editors', () => {
  test('the demo files validate, and broken ones do not', async () => {
    const { validateSchema } = await import('../src/node/validate-schema.mjs');
    const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
    const S = (n) => load(path.join(ROOT, 'schema', n + '.schema.json'));
    assert.deepEqual(validateSchema(load(path.join(RB, 'trace-map.json')), S('trace-map')), []);
    assert.deepEqual(validateSchema(load(path.join(RB, 'observed.normalized.json')), S('normalized-trace')), []);
    assert.deepEqual(validateSchema(load(path.join(ROOT, '.working-model-ci.json')), S('working-model-ci')), []);
    assert.ok(validateSchema({ schemaVersion: 1, inputs: [{ observedKind: 'a', modelEvent: 'b', bogus: 1 }] }, S('trace-map')).length > 0);
    assert.ok(validateSchema({ schemaVersion: 1, checks: { mutation: { minScore: 101 } } }, S('working-model-ci')).length > 0);
    // the command line accepts a $schema key, as editors add one
    const m = load(path.join(RB, 'trace-map.json'));
    m.$schema = '../../schema/trace-map.schema.json';
    assert.doesNotThrow(() => validateMapping(m, compileModel(load(path.join(RB, 'circuit-breaker.model.json'))).model));
  });
});
