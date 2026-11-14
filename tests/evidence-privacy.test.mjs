// bundle --public: identifying trace data never reaches the public files,
// even when the user kept every attribute at import; an unmarked trace is
// refused; the preview lists the keys and writes nothing; the page runs no
// script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keyPaths } from '../src/evidence/bundle.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'working-model.mjs');
const RB = path.join(ROOT, 'examples', 'reality-bridge');
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });

const SECRETS = {
  ip: '198.51.100.23',
  header: 'Bearer abc.def.ghi',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl',
  email: 'alice.customer@example.com',
  secret: 'sk_live_51Hsecretvalue',
  subject: 'customer-4711-alice',
  file: 'C:/Users/alice/private/orders.sql',
  url: 'https://internal.example.com/admin?token=zzz',
};

const ALLOWED_KEYS = new Set(['assumptions', 'assumptions[].id', 'assumptions[].scope', 'assumptions[].text', 'completeness', 'coverage', 'coverage.inputMapped', 'coverage.modelOutputs',
  'coverage.observedEvents', 'coverage.observedUnmapped', 'coverage.outputMapped', 'coverage.uncorrelated', 'engineVersion', 'evidenceType', 'firstMismatch', 'firstMismatch.assertionId',
  'firstMismatch.bucket', 'firstMismatch.cause', 'firstMismatch.expectedKind', 'firstMismatch.observedKind', 'firstMismatch.type', 'kind', 'model', 'model.modelDigest', 'model.title',
  'modelClaims', 'modelClaims.passed', 'modelClaims.status', 'modelClaims.total', 'note', 'observedAssertions', 'observedAssertions.failed', 'observedAssertions.inconclusive',
  'observedAssertions.passed', 'observedAssertions.results', 'observedAssertions.results[].firstFailure', 'observedAssertions.results[].firstFailure.bucket',
  'observedAssertions.results[].firstFailure.expectedKind', 'observedAssertions.results[].firstFailure.observedKind', 'observedAssertions.results[].firstFailure.type',
  'observedAssertions.results[].id', 'observedAssertions.results[].inconclusiveReason', 'observedAssertions.results[].kind', 'observedAssertions.results[].required',
  'observedAssertions.results[].status', 'observedAssertions.results[].test', 'schemaVersion', 'status', 'synthetic', 'timeline', 'timeline.bucketMs', 'timeline.rows',
  'timeline.rows[].bucket', 'timeline.rows[].count', 'timeline.rows[].kind', 'timeline.rows[].lane', 'verificationVersion']);

function hostileSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-priv-'));
  // the demo trace, with identifying data in every field a trace can hold
  const lines = fs.readFileSync(path.join(RB, 'observed.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const r of lines) {
    r.attrs = { ...r.attrs, client_ip: SECRETS.ip, authorization: SECRETS.header, jwt: SECRETS.jwt, user_email: SECRETS.email, api_secret: SECRETS.secret, source_file: SECRETS.file, referrer: SECRETS.url };
    if (r.kind.startsWith('call_')) r.subject = SECRETS.subject + '-' + r.timeMs;
    if (r.kind.startsWith('breaker_')) r.subject = SECRETS.subject;
  }
  const trace = path.join(dir, 'real.jsonl');
  fs.writeFileSync(trace, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const map = JSON.parse(fs.readFileSync(path.join(RB, 'trace-map.json'), 'utf8'));
  map.outputs.forEach((o) => { o.modelSubjectFrom = 'literal:' + SECRETS.subject; });
  map.assertions[2].by = 'literal:' + SECRETS.subject;
  const mapFile = path.join(dir, 'map.json');
  fs.writeFileSync(mapFile, JSON.stringify(map));
  const norm = path.join(dir, 'n.json');
  const keep = ['client_ip', 'authorization', 'jwt', 'user_email', 'api_secret', 'source_file', 'referrer'].flatMap((k) => ['--keep-attr', k]);
  const r = cli(['trace', 'import', trace, '--mapping', mapFile, '--complete', '--out', norm, ...keep]);
  assert.equal(r.status, 0, r.stderr);
  // the worst case: the local normalized trace really does hold the secrets
  const local = fs.readFileSync(norm, 'utf8');
  assert.ok(local.includes(SECRETS.jwt) && local.includes(SECRETS.subject));
  return { dir, norm, mapFile, trace };
}

test('nothing identifying reaches evidence.json, evidence.html or manifest.json', () => {
  const { dir, norm, mapFile, trace } = hostileSetup();
  const out = path.join(dir, 'public');
  const r = cli(['bundle', path.join(RB, 'circuit-breaker.model.json'), '--public', '--trace', norm, '--mapping', mapFile, '--acknowledge-privacy', '--out', out]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const files = ['evidence.json', 'evidence.html', 'manifest.json'].map((f) => fs.readFileSync(path.join(out, f), 'utf8'));
  for (const text of files) {
    for (const [what, value] of Object.entries(SECRETS)) assert.ok(!text.includes(value), `${what} leaked`);
    for (const p of [dir, trace, norm, ROOT, 'real.jsonl', 'ev-000']) assert.ok(!text.includes(p) && !text.includes(p.split(path.sep).join('/')), `path or id leaked: ${p}`);
    assert.ok(!/timeMs|subject"|attrs/.test(text));
  }
  const ev = JSON.parse(files[0]);
  for (const k of keyPaths(ev)) assert.ok(ALLOWED_KEYS.has(k), `unexpected key ${k}`);
  assert.equal(ev.status, 'fail');
  assert.ok(!/<script/i.test(files[1]));
  assert.match(files[1], /default-src 'none'/);
  assert.match(files[2], /not that the evidence is true/);
});

test('an observed trace without --synthetic or --acknowledge-privacy is refused', () => {
  const { dir, norm, mapFile } = hostileSetup();
  const r = cli(['bundle', path.join(RB, 'circuit-breaker.model.json'), '--public', '--trace', norm, '--mapping', mapFile, '--out', path.join(dir, 'x'), '--json']);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).error.code, 'E_PRIVACY_ACK');
  assert.ok(!fs.existsSync(path.join(dir, 'x')));
  assert.equal(cli(['bundle', path.join(RB, 'circuit-breaker.model.json'), '--trace', norm, '--mapping', mapFile, '--synthetic']).status, 2, 'without --public');
});

test('--preview lists the exact keys and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-priv-'));
  const out = path.join(dir, 'p');
  const r = cli(['bundle', path.join(RB, 'circuit-breaker.model.json'), '--public', '--trace', path.join(RB, 'observed.normalized.json'), '--mapping', path.join(RB, 'trace-map.json'), '--synthetic', '--preview', '--json', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(j.includedKeys.includes('timeline.rows[].bucket'));
  assert.ok(!j.includedKeys.some((k) => /subject|attrs|timeMs|id$/.test(k) && k !== 'assumptions[].id' && k !== 'observedAssertions.results[].id'));
  assert.ok(!fs.existsSync(out));
});

test('a simulated counterexample bundles without trace data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-priv-'));
  const spec = path.join(RB, 'circuit-breaker.model.json');
  assert.equal(cli(['fuzz', spec, '--cases', '60', '--seed', '7', '--out', dir]).status, 0);
  const r = cli(['bundle', spec, '--public', '--case', path.join(dir, 'first-failure.json'), '--out', path.join(dir, 'pub')]);
  assert.equal(r.status, 0, r.stderr);
  const ev = JSON.parse(fs.readFileSync(path.join(dir, 'pub', 'evidence.json'), 'utf8'));
  assert.equal(ev.evidenceType, 'simulated');
  assert.ok(!JSON.stringify(ev).includes('replay'));
});
