// Explanation CI: true pass, fail and inconclusive results, valid JSON and
// JUnit XML, explicit thresholds, changes against a base report, an honest
// skip without a browser, and a read-only workflow.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toJUnit, toMarkdown, aggregate, diffAgainst } from '../src/ci/report.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'working-model.mjs');
const RB = path.join(ROOT, 'examples', 'reality-bridge');

function runCi(config, extra = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-ci-'));
  const file = path.join(dir, 'ci.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, ...config }));
  const r = spawnSync(process.execPath, [CLI, 'ci', '--config', file, ...extra], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, dir };
}

// A tiny well-formedness check: every tag closes in order, attributes are quoted.
function wellFormed(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"<]*")*)\s*(\/?)>/g;
  let m;
  let last = 0;
  while ((m = re.exec(body))) {
    if (/[<>]/.test(body.slice(last, m.index))) return false;
    last = re.lastIndex;
    if (m[4]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return stack.length === 0 && !/[<>]/.test(body.slice(last));
}

describe('ci', () => {
  test('the failing demo fails the gate; the corrected model passes it', () => {
    const fail = runCi({ models: [path.join(RB, 'circuit-breaker.model.json')], checks: { reality: { enabled: true } } }, ['--format', 'json']);
    assert.equal(fail.code, 1, fail.err);
    const rep = JSON.parse(fail.out);
    assert.equal(rep.status, 'fail');
    assert.deepEqual(rep.models[0].checks.map((c) => [c.name, c.status]), [['claims', 'pass'], ['reality', 'fail']]);
    assert.equal(rep.models[0].firstMismatch.atMs, 1800);
    const pass = runCi({ models: [path.join(RB, 'circuit-breaker-window.model.json')] }, ['--format', 'json']);
    assert.equal(pass.code, 0, pass.err);
    assert.equal(JSON.parse(pass.out).status, 'pass');
  });

  test('inconclusive stays inconclusive unless strictObserved makes it fail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-ci-'));
    for (const f of ['circuit-breaker.model.json', 'trace-map.json', 'observed-unknown.normalized.json']) fs.copyFileSync(path.join(RB, f), path.join(dir, f));
    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'circuit-breaker.model.json'), 'utf8'));
    spec.reality.observedTrace = 'observed-unknown.normalized.json';
    fs.writeFileSync(path.join(dir, 'circuit-breaker.model.json'), JSON.stringify(spec));
    const loose = runCi({ models: [path.join(dir, 'circuit-breaker.model.json')] }, ['--format', 'json']);
    assert.equal(loose.code, 0, loose.err);
    const lr = JSON.parse(loose.out);
    assert.equal(lr.models[0].checks[1].status, 'inconclusive');
    assert.equal(lr.status, 'pass-with-inconclusive');
    const strict = runCi({ models: [path.join(dir, 'circuit-breaker.model.json')], checks: { reality: { strictObserved: true } } }, ['--format', 'json']);
    assert.equal(strict.code, 1);
    assert.equal(JSON.parse(strict.out).models[0].checks[1].status, 'fail');
  });

  test('a mutation threshold from the config gates, and is printed with the result', () => {
    const r = runCi({ models: [path.join(RB, 'circuit-breaker.model.json')], checks: { reality: { enabled: false }, mutation: { enabled: true, minScore: 99 } } }, ['--format', 'json']);
    assert.equal(r.code, 1);
    const m = JSON.parse(r.out).models[0].checks.find((c) => c.name === 'mutation');
    assert.equal(m.status, 'fail');
    assert.match(m.detail, /minimum 99%/);
  });

  test('without a browser the parity check is skipped, never passed', () => {
    // WORKING_MODEL_CHROME pointing at nothing means no browser, so no Chrome is started here
    const r = runCi({ models: [path.join(RB, 'circuit-breaker-window.model.json')], checks: { parity: { enabled: true } } }, ['--format', 'json'], { WORKING_MODEL_CHROME: path.join(os.tmpdir(), 'no-such-chrome.exe') });
    assert.equal(r.code, 0, r.err);
    const rep = JSON.parse(r.out);
    const p = rep.models[0].checks.find((c) => c.name === 'parity');
    assert.equal(p.status, 'skipped');
    assert.match(p.detail, /no Chrome/);
    assert.equal(rep.counts.skipped, 1);
  });

  test('JUnit XML and Markdown are valid and escaped', () => {
    const rep = {
      status: 'fail', engineVersion: '0.1.0', counts: { pass: 1, fail: 1, inconclusive: 1, skipped: 1, error: 0 },
      models: [{ file: 'a&b<c>.model.json', checks: [{ name: 'claims', status: 'pass', detail: 'ok' }, { name: 'reality', status: 'fail', detail: 'x < y & "z"' }, { name: 'fuzz', status: 'inconclusive', detail: "it's" }, { name: 'parity', status: 'skipped', detail: 'no Chrome' }], reproduce: ['node x'] }],
    };
    const xml = toJUnit(rep);
    assert.ok(wellFormed(xml), xml);
    assert.match(xml, /tests="4" failures="1" skipped="2"/);
    assert.match(xml, /a&amp;b&lt;c&gt;\.model\.json/);
    assert.ok(!wellFormed('<a><b></a></b>'));
    const md = toMarkdown(rep);
    assert.match(md, /\| a&b\\<c\\>\.model\.json \| reality \| fail \|/);
    assert.equal(aggregate(rep.models).status, 'fail');
  });

  test('changes against a base report name what changed, not just that text differs', () => {
    const a = [{ file: 'm', digests: { claims: '1', rules: '1', mapping: '1', trace: '1' }, checks: [{ name: 'reality', status: 'pass' }] }];
    const b = [{ file: 'm', digests: { claims: '1', rules: '2', mapping: '1', trace: '1' }, checks: [{ name: 'reality', status: 'fail' }] }, { file: 'n', digests: {}, checks: [] }];
    const d = diffAgainst({ models: a }, b).map((x) => x.change);
    assert.deepEqual(d, ['model rules changed', 'reality: pass -> fail', 'model added']);
  });

  test('unknown config keys and out-of-range thresholds are refused', () => {
    assert.equal(runCi({ models: [RB], extra: 1 }, ['--json']).code, 2);
    assert.equal(runCi({ models: [RB], checks: { mutation: { minScore: 140 } } }, ['--json']).code, 2);
    assert.equal(runCi({ models: [RB], checks: { telepathy: {} } }, ['--json']).code, 2);
  });

  test('the workflow example is read-only', () => {
    const y = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'working-model-ci.example.yml'), 'utf8');
    const code = y.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.match(code, /^on:\n  pull_request:/m);
    assert.ok(!/pull_request_target/.test(code));
    assert.match(code, /^permissions:\n  contents: read\n/m);
    assert.ok(!/secrets\.|GITHUB_TOKEN|write-all|: write/.test(code));
    assert.match(code, /persist-credentials: false/);
    assert.ok(!/npm (install|ci)/.test(code));
  });
});
