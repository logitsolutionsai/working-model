import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSchema } from '../src/node/schema.mjs';
import { validateSchema } from '../src/node/validate-schema.mjs';
import { checkFile, checkSpec, listSpecFiles } from '../src/node/check.mjs';
import { engineBundle, renderPage } from '../src/node/build.mjs';
import { analyze } from '../src/engine/index.mjs';
import { scaffold } from '../src/node/scaffold.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'working-model.mjs');
const EXAMPLES = listSpecFiles(path.join(ROOT, 'examples'));
const BROKEN = path.join(ROOT, 'tests', 'fixtures', 'broken');

describe('schema', () => {
  test('schema/model.schema.json is up to date with the code that builds it', () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'model.schema.json'), 'utf8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(buildSchema())));
  });
  test('every example validates against the schema file', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'model.schema.json'), 'utf8'));
    for (const f of EXAMPLES) assert.deepEqual(validateSchema(JSON.parse(fs.readFileSync(f, 'utf8')), schema), [], f);
  });
  const expected = JSON.parse(fs.readFileSync(path.join(BROKEN, 'expected.json'), 'utf8'));
  for (const [file, want] of Object.entries(expected)) {
    test(`broken fixture ${file} fails with ${want.codes.join(', ')}`, () => {
      const r = checkFile(path.join(BROKEN, file), { probe: false });
      assert.equal(r.exit, 2, 'exit code 2 for an invalid spec');
      const codes = r.errors.map((e) => e.code);
      for (const c of want.codes) assert.ok(codes.includes(c), `${file}: got ${codes.join(', ')}`);
      if (want.path) assert.ok(r.errors.some((e) => e.path === want.path), `${file}: paths ${r.errors.map((e) => e.path).join(', ')}`);
      if (want.line) assert.equal(r.errors[0].line, want.line);
    });
  }
});

// regression: keys inherited from Object.prototype slipped past "unknown key"
describe('schema edge cases', () => {
  test('keys such as constructor and toString are unknown keys, not inherited ones', () => {
    const spec = JSON.parse(fs.readFileSync(EXAMPLES[0], 'utf8'));
    spec.constructor = 1;
    spec.params[0].toString = 'x';
    const r = checkSpec(spec, { probe: false });
    assert.equal(r.exit, 2);
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]).sort(), [['E_SCHEMA_UNKNOWN_KEY', 'constructor'], ['E_SCHEMA_UNKNOWN_KEY', 'params[0].toString']]);
  });
  // regression: very deep JSON overflowed the stack with a bare RangeError
  test('very deep JSON is refused with a clear error', () => {
    const spec = JSON.parse(fs.readFileSync(EXAMPLES[0], 'utf8'));
    spec.state.deep = JSON.parse('['.repeat(5000) + ']'.repeat(5000));
    const r = checkSpec(spec, { probe: false });
    assert.equal(r.exit, 2);
    assert.equal(r.errors[0].code, 'E_TOO_DEEP');
  });
});

describe('examples', () => {
  const reports = EXAMPLES.map((f) => checkFile(f));
  test('there are at least eight examples', () => assert.ok(EXAMPLES.length >= 8));
  for (const r of reports) {
    const name = path.basename(r.file);
    test(`${name} passes check with no lint errors`, () => {
      assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
      assert.equal(r.passed, r.total, r.results.filter((x) => !x.pass).map((x) => x.id + ': ' + x.line).join('; '));
      assert.equal(r.exit, 0);
      assert.deepEqual(r.lint.filter((i) => i.severity === 'error'), []);
      assert.deepEqual(r.lint.filter((i) => i.code === 'W_LITERAL_NUMBER' || i.code === 'W_UNCITED_CLAIM'), []);
    });
    test(`${name} has a claim a reader can break with a slider, and cites sources`, () => {
      assert.ok(r.probes.some((p) => p.failing.length > 0), 'no slider breaks any claim');
      assert.ok(r.spec.sources && r.spec.sources.length > 0);
      assert.ok(r.total >= 3 && r.total <= 8, `${r.total} claims`);
    });
  }
  test('together the examples use every part type and every claim kind', () => {
    const parts = new Set();
    const kinds = new Set();
    for (const r of reports) {
      for (const p of r.spec.parts) parts.add(p.type);
      for (const c of r.spec.claims) { kinds.add(c.kind); if (c.claim) kinds.add(c.claim.kind); }
    }
    assert.deepEqual([...parts].sort(), ['box', 'chart', 'counter', 'gauge', 'grid', 'group', 'label', 'lamp', 'link', 'node', 'queue', 'stack', 'tank'].sort());
    assert.deepEqual([...kinds].sort(), ['always', 'at', 'compare', 'eventually', 'never', 'sweep', 'whenever'].sort());
  });
});

describe('one engine for Node and the page', () => {
  test('the inlined bundle gives the same results as the modules', () => {
    const bundle = engineBundle();
    for (const f of EXAMPLES) {
      const spec = JSON.parse(fs.readFileSync(f, 'utf8'));
      const ctx = vm.createContext({ performance });
      // JSON round trip: arrays made inside the vm belong to another realm
      const code = bundle + '\nJSON.stringify(WM.analyze(' + JSON.stringify(spec) + ', { probe: false }).results)';
      const page = { results: JSON.parse(vm.runInContext(code, ctx)) };
      page.passed = page.results.filter((r) => r.pass).length;
      const node = analyze(spec, { probe: false });
      assert.equal(page.passed, node.passed, f);
      assert.deepEqual(page.results.map((r) => [r.id, r.status, r.line]), node.results.map((r) => [r.id, r.status, r.line]), f);
    }
  });
  test('a built page is offline: one file, a strict CSP, no external loads', () => {
    const spec = JSON.parse(fs.readFileSync(EXAMPLES[0], 'utf8'));
    const html = renderPage(spec);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+href=/i);
    assert.doesNotMatch(html, /url\(\s*['"]?https?:/i);
    assert.doesNotMatch(html, /@import/);
    assert.equal((html.match(/<\/script>/g) || []).length, 3, 'only the three inline script blocks close');
  });
  // regression: script-src allowed 'unsafe-inline', so any injected markup could have run script
  test('the CSP allows exactly the two inline scripts, by hash', async () => {
    const crypto = await import('node:crypto');
    const spec = JSON.parse(fs.readFileSync(EXAMPLES[0], 'utf8'));
    const html = renderPage(spec);
    const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
    const scriptSrc = policy.split(';').map((x) => x.trim()).find((x) => x.startsWith('script-src'));
    assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval|\*|https?:/);
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(inline.length, 2);
    for (const js of inline) {
      const hash = crypto.createHash('sha256').update(js, 'utf8').digest('base64');
      assert.ok(scriptSrc.includes(`'sha256-${hash}'`), 'hash of an inline script is in the policy');
    }
  });
  test('text containing </script> cannot break out of the page', () => {
    const spec = JSON.parse(fs.readFileSync(EXAMPLES[0], 'utf8'));
    spec.title = 'Evil </script><script>alert(1)</script>';
    const html = renderPage(spec);
    assert.equal((html.match(/<\/script>/g) || []).length, 3);
  });
});

describe('cli', () => {
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } });
  test('check prints the summary and exits 0', () => {
    const r = cli('check', 'examples/token-bucket.model.json', '--no-probe');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /6\/6 claims pass/);
  });
  test('check --json', () => {
    const r = cli('check', 'examples/token-bucket.model.json', '--json', '--no-probe');
    const j = JSON.parse(r.stdout);
    assert.equal(j.summary, '6/6 claims pass');
    assert.equal(j.results.length, 6);
  });
  test('check --set exits 1 and shows the counterexample', () => {
    const r = cli('check', 'examples/token-bucket.model.json', '--set', 'burst=5', '--no-probe');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+burst-passes/);
    assert.match(r.stdout, /fails at t = 1 s: accepted = 5, capacity = 10/);
    assert.match(r.stdout, /4\/6 claims pass/);
  });
  test('check exits 2 on an invalid spec and 64 on bad usage', () => {
    assert.equal(cli('check', 'tests/fixtures/broken/unknown-name.model.json').status, 2);
    assert.equal(cli('frobnicate').status, 64);
  });
  test('new scaffolds a spec that passes check', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'tests', 'output-tmp-'));
    try {
      const r = cli('new', 'water tank', '--dir', dir);
      assert.equal(r.status, 0, r.stderr);
      const file = path.join(dir, 'water-tank.model.json');
      const c = checkFile(file);
      assert.equal(c.exit, 0, JSON.stringify(c.errors) + c.results.map((x) => x.line).join(';'));
      assert.deepEqual(scaffold('water tank').id, 'water-tank');
      const b = cli('build', file, '-o', path.join(dir, 'page.html'));
      assert.equal(b.status, 0, b.stderr);
      assert.ok(fs.statSync(path.join(dir, 'page.html')).size > 50000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  // regression: the "next:" line could not be pasted when the folder had a space in it
  test('new quotes a path with spaces in its next step', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'tests', 'output-tmp-'));
    try {
      const sub = path.join(dir, 'my models');
      const r = cli('new', 'tank', '--dir', sub);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(`check "${path.join(sub, 'tank.model.json')}"`), r.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  // regression: a misspelt --set name was silently ignored
  test('check --set warns about a name that is not a param', () => {
    const r = cli('check', 'examples/token-bucket.model.json', '--set', 'capcity=5', '--no-probe');
    assert.equal(r.status, 0);
    assert.match(r.stderr, /--set capcity: token-bucket\.model\.json has no param "capcity" \(params: capacity, refill, burst, rate\)/);
  });
  // regression: snap reported a misspelt --set name as a page error with a stack trace
  test('snap and gif refuse a name that is not a param before starting Chrome', () => {
    const r = cli('snap', 'examples/token-bucket.model.json', '--set', 'nope=1', '-o', path.join(ROOT, 'tests', 'output', 'never.png'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--set nope: the spec has no param "nope" \(params: capacity, refill, burst, rate\)/);
    assert.doesNotMatch(r.stderr, /at Object\.setParam/);
  });
  // regression: a folder in WORKING_MODEL_CHROME gave "spawn ... ENOENT"
  test('a bad WORKING_MODEL_CHROME gets a message that says how to fix it', async () => {
    const { findChrome } = await import('../src/node/chrome.mjs');
    const saved = process.env.WORKING_MODEL_CHROME;
    try {
      process.env.WORKING_MODEL_CHROME = ROOT;
      assert.throws(() => findChrome(), /is a folder, not a program\. Set it to the Chrome, Edge or Chromium executable/);
      process.env.WORKING_MODEL_CHROME = path.join(ROOT, 'no such chrome.exe');
      assert.throws(() => findChrome(), /does not exist\. Set it to/);
    } finally {
      if (saved == null) delete process.env.WORKING_MODEL_CHROME; else process.env.WORKING_MODEL_CHROME = saved;
    }
  });
  test('build refuses a spec with failing claims unless forced', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'tests', 'output-tmp-'));
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'token-bucket.model.json'), 'utf8'));
      spec.claims[0].expr = 'accepted == 99';
      const file = path.join(dir, 'bad.model.json');
      fs.writeFileSync(file, JSON.stringify(spec));
      const r = cli('build', file, '-o', path.join(dir, 'bad.html'));
      assert.equal(r.status, 1);
      assert.equal(fs.existsSync(path.join(dir, 'bad.html')), false);
      const f = cli('build', file, '-o', path.join(dir, 'bad.html'), '--force');
      assert.equal(f.status, 1);
      assert.equal(fs.existsSync(path.join(dir, 'bad.html')), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
