// The build --trace page without a browser: every inline script is allowed by
// its hash (no 'unsafe-inline' for scripts), nothing loads from the network,
// the private source path is not embedded, and the bundle is the engine plus
// the trace modules. Browser behaviour is in tests/e2e/reality.e2e.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realityBundle } from '../src/node/build-reality.mjs';
import { checkWithTrace } from '../src/node/reality.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RB = path.join(ROOT, 'examples', 'reality-bridge');
const CLI = path.join(ROOT, 'scripts', 'working-model.mjs');

function build(extra = []) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-rp-')), 'page.html');
  const r = spawnSync(process.execPath, [CLI, 'build', path.join(RB, 'circuit-breaker.model.json'), '--trace', path.join(RB, 'observed.normalized.json'), '--mapping', path.join(RB, 'trace-map.json'), '-o', out, ...extra], { encoding: 'utf8' });
  return { r, html: r.status === 0 ? fs.readFileSync(out, 'utf8') : null };
}

test('build --trace writes an offline page whose scripts are all allowed by hash', () => {
  const { r, html } = build();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /model 4\/4 claims pass, observed 1 pass, 2 fail, 0 inconclusive/);
  const csp = /content="(default-src 'none';[^"]*)"/.exec(html)[1];
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(inline.length, 3);
  for (const js of inline) assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(js, 'utf8').digest('base64')}'`), 'an inline script has no matching hash');
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|<img[^>]+src="http/i.test(html));
  assert.ok(!html.includes('sourcePath'));
  assert.ok(!html.includes('Bearer'));
  assert.ok(html.includes('id="wm-reality"'));
});

test('the page bundle evaluates to the same report as Node', () => {
  const ctx = vm.createContext({});
  vm.runInContext(realityBundle() + '\nthis.WM = WM;', ctx);
  const spec = JSON.parse(fs.readFileSync(path.join(RB, 'circuit-breaker.model.json'), 'utf8'));
  const { report, trace } = checkWithTrace(path.join(RB, 'circuit-breaker.model.json'), { trace: path.join(RB, 'observed.normalized.json'), mapping: path.join(RB, 'trace-map.json'), probe: false });
  const mapping = JSON.parse(fs.readFileSync(path.join(RB, 'trace-map.json'), 'utf8'));
  const res = vm.runInContext('(function (spec, trace, mapping) { var m = WM.compileModel(spec).model; return JSON.stringify(WM.evaluateReality(m, trace, WM.validateMapping(mapping, m)).report); })', ctx)(spec, trace, mapping);
  const b = JSON.parse(res);
  assert.equal(b.status, report.status);
  assert.deepEqual(b.observedAssertions, JSON.parse(JSON.stringify(report.observedAssertions)));
  assert.deepEqual(b.firstMismatch, report.firstMismatch);
  assert.deepEqual(b.outputs, JSON.parse(JSON.stringify(report.outputs)));
});

test('build --trace refuses a model whose claims fail, unless forced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-rp-'));
  const spec = JSON.parse(fs.readFileSync(path.join(RB, 'circuit-breaker.model.json'), 'utf8'));
  spec.claims[0].expr = 'trips == 1';
  delete spec.reality;
  const f = path.join(dir, 'bad.model.json');
  fs.writeFileSync(f, JSON.stringify(spec));
  const args = ['build', f, '--trace', path.join(RB, 'observed.normalized.json'), '--mapping', path.join(RB, 'trace-map.json'), '-o', path.join(dir, 'p.html')];
  assert.equal(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [CLI, ...args, '--force'], { encoding: 'utf8' }).status, 0);
});
