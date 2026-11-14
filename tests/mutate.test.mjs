// check --mutate: mutation operators, their locations, equivalent mutants,
// the cap and its seeded sample, the report, the CLI, and the scores shown
// in the gallery and the README.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileModel } from '../src/engine/model.mjs';
import { simulate } from '../src/engine/simulate.mjs';
import { enumerateMutants, buildMutant, mutateClaims, scorePercent } from '../src/engine/mutate.mjs';
import { pageMutation } from '../src/node/build.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'working-model.mjs');
const FIFO = path.join(ROOT, 'tests', 'fixtures', 'mutate', 'fifo-lock.model.json');

function compile(spec) {
  const { model, errors } = compileModel(spec);
  assert.deepEqual(errors.map((e) => e.message), []);
  return model;
}

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

// Every operator appears in this rule code at a known line and column.
function operatorSpec() {
  return {
    title: 'Operators',
    dt: 1,
    duration: 5,
    state: { a: 0, b: true, x: 0, xs: [1, 2], n: 0 },
    events: [{ name: 'go', at: 2 }],
    rules: {
      tick: [
        'if a < 3 and b {',
        '  x = min(x + 1, 10)',
        '} else {',
        '  x = clamp(x * 2, 0, 5)',
        '}',
        'push(xs, x)',
        'let y = shift(xs)',
        'remove(xs, y)',
        "emit('ping', y)",
        'n -= 1',
      ],
      on: { go: 'a += 1' },
    },
    parts: [{ id: 'c', type: 'counter', at: [0, 0, 2, 2], value: 'x' }],
    claims: [{ id: 'x-grows', kind: 'at', t: 5, expr: 'x == 5', text: 'x counts the ticks.' }],
  };
}

function find(mutants, op, at, change) {
  const m = mutants.find((x) => x.op === op && x.at === at && x.change === change);
  assert.ok(m, `no ${op} mutant "${at} ${change}" in:\n` + mutants.map((x) => `  ${x.op} ${x.key}`).join('\n'));
  return m;
}

describe('mutation operators', () => {
  const model = compile(operatorSpec());
  const ms = enumerateMutants(model);

  test('relational boundary and equality swaps', () => {
    find(ms, 'relational', 'rules.tick:1:6', 'a < 3 → a <= 3');
    const m = compileModel({ ...operatorSpec(), rules: { tick: ['if a <= 1 or a > 2 or a >= 3 or a == 4 or a != 5 {', '  n += 1', '}'] } }).model;
    const all = enumerateMutants(m).filter((x) => x.op === 'relational').map((x) => x.change);
    assert.deepEqual(all, ['a <= 1 → a < 1', 'a > 2 → a >= 2', 'a >= 3 → a > 3', 'a == 4 → a != 4', 'a != 5 → a == 5']);
  });

  test('arithmetic swaps, including compound assignment', () => {
    find(ms, 'arithmetic', 'rules.tick:2:13', 'x + 1 → x - 1');
    find(ms, 'arithmetic', 'rules.tick:4:15', 'x * 2 → x / 2');
    find(ms, 'arithmetic', 'rules.tick:10:3', 'n -= 1 → n += 1');
    find(ms, 'arithmetic', 'rules.on.go:1:3', 'a += 1 → a -= 1');
  });

  test('off-by-one constants', () => {
    find(ms, 'constant', 'rules.tick:1:8', '3 → 4');
    find(ms, 'constant', 'rules.tick:1:8', '3 → 2');
    find(ms, 'constant', 'rules.tick:4:20', '0 → 1');
    find(ms, 'constant', 'rules.tick:2:15', '1 → 0');
  });

  test('min, max and clamp: dropped and swapped', () => {
    find(ms, 'bound', 'rules.tick:2:7', 'min(x + 1, 10) → max(x + 1, 10)');
    find(ms, 'bound', 'rules.tick:2:7', 'min(x + 1, 10) → x + 1');
    find(ms, 'bound', 'rules.tick:2:7', 'min(x + 1, 10) → 10');
    find(ms, 'bound', 'rules.tick:4:7', 'clamp(x * 2, 0, 5) → x * 2');
  });

  test('list order: shift and pop, push to the front, a remove dropped', () => {
    find(ms, 'list-order', 'rules.tick:6:1', 'push(xs, x) → unshift(xs, x)');
    find(ms, 'list-order', 'rules.tick:7:9', 'shift(xs) → pop(xs)');
    find(ms, 'list-order', 'rules.tick:8:1', 'remove(xs, y) → (removed)');
  });

  test('if negated, else dropped, a statement deleted (never a let)', () => {
    find(ms, 'negate-if', 'rules.tick:1:1', 'if a < 3 and b → if not (a < 3 and b)');
    find(ms, 'drop-else', 'rules.tick:1:1', 'if a < 3 and b { … } else { … } → if a < 3 and b { … }');
    find(ms, 'delete-statement', 'rules.tick:2:3', 'x = min(x + 1, 10) → (deleted)');
    find(ms, 'delete-statement', 'rules.tick:10:1', 'n -= 1 → (deleted)');
    assert.equal(ms.filter((x) => x.op === 'delete-statement' && x.at.startsWith('rules.tick:7:')).length, 0);
  });

  test('and and or swapped, an emit removed, an event moved a tick', () => {
    find(ms, 'logical', 'rules.tick:1:10', 'a < 3 and b → a < 3 or b');
    find(ms, 'emit', 'rules.tick:9:1', "emit('ping', y) → (removed)");
    find(ms, 'event-time', 'events[0].at', 'go at 2 → one tick later');
  });

  test('mutants are numbered in a stable order with a key of location and change', () => {
    const again = enumerateMutants(compile(operatorSpec()));
    assert.deepEqual(again.map((x) => x.key), ms.map((x) => x.key));
    assert.deepEqual(ms.map((x) => x.id), ms.map((_, i) => 'M' + (i + 1)));
    for (const m of ms) assert.equal(m.key, `${m.at} ${m.change}`);
  });

  test('mutants change the parsed tree, so they run as intended', () => {
    const fifo = compile(JSON.parse(fs.readFileSync(FIFO, 'utf8')));
    const lifo = enumerateMutants(fifo).find((x) => x.change === 'shift(waiting) → pop(waiting)');
    const enters = (mdl) => simulate(mdl, {}).emits.flat().filter((e) => e.name === 'enter').map((e) => e.payload);
    assert.deepEqual(enters(fifo), [0, 1, 2, 3, 4]);
    assert.deepEqual(enters(buildMutant(fifo, lifo)), [4, 3, 2, 1, 0]);
    // the original model is untouched
    assert.deepEqual(enters(fifo), [0, 1, 2, 3, 4]);
    const later = enumerateMutants(model).find((x) => x.op === 'event-time');
    const firedAt = (mdl) => simulate(mdl, {}).fired.findIndex((f) => f.some((x) => x.name === 'go'));
    assert.equal(firedAt(model), 2);
    assert.equal(firedAt(buildMutant(model, later)), 3);
  });
});

describe('mutation report', () => {
  const spec = () => ({
    title: 'Counter',
    dt: 1,
    duration: 10,
    params: [{ id: 'step', label: 'Step', min: 1, max: 5, step: 1, default: 1 }],
    state: { x: 0, y: 0, s: "''" },
    rules: { tick: ['x = max(x + 1, 0)', 'if step > 4 {', '  y += 1', '}', "s = 'a' + 'b'", "emit('tick', x)"] },
    parts: [{ id: 'c', type: 'counter', at: [0, 0, 2, 2], value: 'x' }],
    claims: [
      { id: 'counts', kind: 'at', t: 10, expr: 'x == 10', text: 'x counts the ticks.' },
      { id: 'positive', kind: 'sweep', vary: ['step'], samples: 10, claim: { kind: 'always', expr: 'y >= 0 or step <= 4' }, text: 'y is never negative.' },
    ],
  });

  test('equivalent, visual-only, engine-killed and surviving mutants are told apart', () => {
    const r = mutateClaims(compile(spec()));
    const by = (change) => r.mutants.find((x) => x.change === change);
    assert.equal(by('max(x + 1, 0) → x + 1').status, 'equivalent');
    assert.equal(by("emit('tick', x) → (removed)").status, 'visual');
    const eng = by("'a' + 'b' → 'a' - 'b'");
    assert.equal(eng.status, 'engine');
    assert.equal(eng.engine, 'runtime');
    assert.equal(eng.error.code, 'E_TYPE');
    assert.equal(by('x = max(x + 1, 0) → (deleted)').status, 'killed');
    assert.deepEqual(by('x = max(x + 1, 0) → (deleted)').killedBy, ['counts']);
    // y only changes at sweep samples with step 5: not equivalent, it is a mutant the sweep kills
    assert.equal(by('y += 1 → y -= 1').status, 'killed');
    assert.deepEqual(by('y += 1 → y -= 1').killedBy, ['positive']);
    // deleting it is not caught: the state differs at step 5, so it survives
    assert.equal(by('y += 1 → (deleted)').status, 'survived');
    assert.equal(r.scored, r.killed + r.engine + r.survived);
    assert.equal(r.score, (r.killed + r.engine) / r.scored);
    assert.equal(scorePercent(r), Math.floor(100 * r.score));
  });

  test('display state is visual only; state that decides what claims read is not', () => {
    const s = {
      title: 'Display', dt: 1, duration: 10,
      state: { n: 0, shown: 0, k: 0, flag: false },
      rules: { tick: ['n += 1', 'shown = n * 10', 'k = n * 2', 'if k > 4 {', '  flag = true', '}'] },
      parts: [{ id: 'c', type: 'counter', at: [0, 0, 2, 2], value: 'shown' }],
      claims: [
        { id: 'counts', kind: 'at', t: 10, expr: 'n == 10', text: 'n counts the ticks.' },
        { id: 'flags', kind: 'eventually', expr: 'flag', text: 'The flag goes up.' },
      ],
    };
    const r = mutateClaims(compile(s));
    const by = (change) => r.mutants.find((x) => x.change === change);
    // only a part reads "shown"
    assert.equal(by('shown = n * 10 → (deleted)').status, 'visual');
    assert.equal(by('10 → 11').status, 'visual');
    // "k" decides "flag", which a claim reads: the flag goes up a tick earlier and no claim notices
    assert.equal(by('k = n * 2 → (deleted)').status, 'killed');
    assert.equal(by('2 → 3').status, 'survived');
    assert.equal(by('k > 4 → k >= 4').status, 'survived');
  });

  test('a mutant is equivalent only if no sweep sample can see it', () => {
    const s = spec();
    s.claims = [s.claims[0]];
    const r = mutateClaims(compile(s));
    // without the sweep, only the default step = 1 is run, where the branch never runs
    assert.equal(r.mutants.find((x) => x.change === 'y += 1 → (deleted)').status, 'equivalent');
    assert.equal(r.paramSets, 1);
  });

  test('claims that never fail are listed with a hint', () => {
    const s = spec();
    s.claims.push({ id: 'trivial', kind: 'always', expr: 'step >= 1', text: 'The step is at least one.' });
    const r = mutateClaims(compile(s));
    assert.deepEqual(r.neverFailed.map((x) => x.id), ['trivial']);
    assert.match(r.neverFailed[0].hint, /restate a rule|never exercises/);
    const counts = r.claims.find((c) => c.id === 'counts');
    assert.ok(counts.kills > 0);
    assert.ok(counts.example && /^M\d+$/.test(counts.example.id));
  });

  test('mutate.ignore takes a survivor out of the score; an unused entry is a warning', () => {
    const s = spec();
    s.mutate = { ignore: [
      { mutant: 'rules.tick:3:3 y += 1 → (deleted)', reason: 'y is bookkeeping for the sweep' },
      { mutant: 'rules.tick:9:9 nothing → here', reason: 'stale' },
    ] };
    const base = mutateClaims(compile(spec()));
    const r = mutateClaims(compile(s));
    const m = r.mutants.find((x) => x.change === 'y += 1 → (deleted)');
    assert.equal(m.status, 'ignored');
    assert.equal(m.reason, 'y is bookkeeping for the sweep');
    assert.equal(r.scored, base.scored - 1);
    assert.equal(r.ignored, 1);
    assert.deepEqual(r.warnings.map((w) => w.code), ['W_MUTATE_IGNORE_UNUSED']);
  });

  test('the cap samples mutants with a seeded generator: same seed, same sample', () => {
    const model = compile(operatorSpec());
    const all = enumerateMutants(model);
    const a = mutateClaims(model, { cap: 5 });
    const b = mutateClaims(model, { cap: 5 });
    const c = mutateClaims(model, { cap: 5, seed: 'other' });
    assert.equal(a.total, all.length);
    assert.equal(a.tested, 5);
    assert.equal(a.sampled, true);
    assert.deepEqual(a.mutants.map((x) => x.id), b.mutants.map((x) => x.id));
    assert.notDeepEqual(a.mutants.map((x) => x.id), c.mutants.map((x) => x.id));
    // the sample keeps the ids and keys of the full numbering
    for (const m of a.mutants) assert.equal(all.find((x) => x.id === m.id).key, m.key);
    const full = mutateClaims(model, { cap: 1000 });
    assert.equal(full.tested, all.length);
    assert.equal(full.sampled, false);
  });

  test('a runaway mutant stops at the step budget and counts as killed by the engine', () => {
    const s = {
      title: 'Loop', dt: 1, duration: 5,
      state: { i: 0, n: 0 },
      rules: { tick: ['i = 0', 'while i < 3 {', '  i += 1', '}', 'n += 1'] },
      parts: [{ id: 'c', type: 'counter', at: [0, 0, 2, 2], value: 'n' }],
      claims: [{ id: 'n', kind: 'at', t: 5, expr: 'n == 5', text: 'n counts.' }],
    };
    const r = mutateClaims(compile(s));
    const loop = r.mutants.find((x) => x.change === 'i += 1 → i -= 1');
    assert.equal(loop.status, 'engine');
    assert.equal(loop.error.code, 'E_STEP_LIMIT');
  });

  test('mutation testing waits until every claim passes', () => {
    const s = spec();
    s.claims[0].expr = 'x == 11';
    const r = mutateClaims(compile(s));
    assert.equal(r.ok, false);
    assert.match(r.error, /every claim must pass first/);
  });
});

describe('the FIFO teaching case in references/claims.md', () => {
  const load = () => JSON.parse(fs.readFileSync(FIFO, 'utf8'));
  const lifo = (r) => r.mutants.find((x) => x.change === 'shift(waiting) → pop(waiting)');

  test('with every thread arriving at once, the FIFO claim survives shift → pop', () => {
    const r = mutateClaims(compile(load()));
    assert.equal(lifo(r).status, 'survived');
    assert.deepEqual(r.neverFailed.map((x) => x.id), ['fifo']);
  });

  test('with staggered arrivals, the same claim kills it', () => {
    const s = load();
    s.events = [{ name: 'arrive', every: 0.5, from: 1, until: '1 + 0.5 * (threads - 1)' }];
    const r = mutateClaims(compile(s));
    assert.equal(lifo(r).status, 'killed');
    assert.deepEqual(lifo(r).killedBy, ['fifo']);
    assert.deepEqual(r.neverFailed, []);
  });
});

describe('cli --mutate', () => {
  test('--json carries the full report', () => {
    const p = cli(['check', FIFO, '--mutate', '--json', '--no-probe']);
    assert.equal(p.status, 0, p.stderr);
    const j = JSON.parse(p.stdout);
    const m = j.mutation;
    assert.equal(m.ok, true);
    for (const k of ['total', 'tested', 'killed', 'engine', 'equivalent', 'visual', 'ignored', 'survived', 'scored', 'score', 'scorePercent', 'claims', 'neverFailed', 'mutants']) assert.ok(k in m, k);
    assert.equal(m.scorePercent, Math.floor(m.score * 100));
    const x = m.mutants.find((y) => y.change === 'shift(waiting) → pop(waiting)');
    assert.deepEqual({ id: x.id, op: x.op, at: x.at, status: x.status }, { id: 'M21', op: 'list-order', at: 'rules.tick:5:12', status: 'survived' });
    assert.deepEqual(m.neverFailed.map((y) => y.id), ['fifo']);
  });

  test('human output lists kills, claims that never failed and survivors by rule', () => {
    const p = cli(['check', FIFO, '--mutate', '--no-probe']);
    assert.equal(p.status, 0);
    assert.match(p.stdout, /Mutation testing/);
    assert.match(p.stdout, /Claims that never failed:\n\s+fifo: /);
    assert.match(p.stdout, /Survived mutants[^\n]*\n\s+rules\.tick\n/);
    assert.match(p.stdout, /M21\s+rules\.tick:5:12 shift\(waiting\) → pop\(waiting\)/);
    assert.match(p.stdout, /mutation score \d+% \(\d+ of \d+ mutants killed\)/);
  });

  test('--mutate-strict exits 1 when a claim never fails or the score is low', () => {
    assert.equal(cli(['check', FIFO, '--mutate-strict', '--no-probe']).status, 1);
    const tb = path.join(ROOT, 'examples', 'token-bucket.model.json');
    const j = JSON.parse(cli(['check', tb, '--mutate', '--json', '--no-probe']).stdout).mutation;
    assert.deepEqual(j.neverFailed, []);
    assert.equal(cli(['check', tb, '--mutate-strict', '--min-score', String(j.scorePercent), '--no-probe']).status, 0);
    assert.equal(cli(['check', tb, '--mutate-strict', '--min-score', String(j.scorePercent + 1), '--no-probe']).status, 1);
    assert.equal(cli(['check', tb, '--mutate=abc']).status, 64);
  });

  test('--mutate=N caps the number of mutants', () => {
    const j = JSON.parse(cli(['check', FIFO, '--mutate=4', '--json', '--no-probe']).stdout).mutation;
    assert.equal(j.tested, 4);
    assert.equal(j.sampled, true);
  });

  test('build --mutate stores the score in the page; plain build stores none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-mut-'));
    try {
      const out = path.join(dir, 'fifo.html');
      assert.equal(cli(['build', FIFO, '-o', out, '--mutate']).status, 0);
      const stored = storedMutation(fs.readFileSync(out, 'utf8'));
      const r = mutateClaims(compile(JSON.parse(fs.readFileSync(FIFO, 'utf8'))));
      assert.deepEqual(stored, pageMutation(r));
      assert.equal(cli(['build', FIFO, '-o', out]).status, 0);
      assert.equal(storedMutation(fs.readFileSync(out, 'utf8')), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function storedMutation(html) {
  const m = /<script type="application\/json" id="wm-mutation">([^<]*)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

describe('published mutation scores match the CLI', () => {
  const examples = fs.readdirSync(path.join(ROOT, 'examples')).filter((f) => f.endsWith('.model.json')).sort();
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'gallery', 'index.html'), 'utf8');
  for (const f of examples) {
    const name = f.replace(/\.model\.json$/, '');
    test(name, () => {
      const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', f), 'utf8'));
      const model = compile(spec);
      const r = mutateClaims(model);
      assert.equal(r.ok, true);
      const pct = scorePercent(r);
      // the page stores what the CLI computes
      const page = storedMutation(fs.readFileSync(path.join(ROOT, 'gallery', name + '.html'), 'utf8'));
      assert.deepEqual(page, pageMutation(r), `gallery/${name}.html is stale: run npm run gallery`);
      // the gallery card
      const card = new RegExp(`href="${name}\\.html"[\\s\\S]*?data-mutation-score="(\\d+)"`).exec(index);
      assert.ok(card, `no mutation score on the ${name} card`);
      assert.equal(Number(card[1]), pct);
      // the README row: "| [Title](...) | ... | 6/6 claims, 94% |"
      const row = readme.split('\n').find((l) => l.startsWith('|') && l.includes(`examples/${f}`));
      assert.ok(row, `no README gallery row links examples/${f}`);
      const cell = /(\d+)\/(\d+) claims, mutation score (\d+)%/.exec(row);
      assert.ok(cell, `README row for ${name} has no "N/N claims, mutation score P%" cell`);
      assert.deepEqual([Number(cell[1]), Number(cell[2]), Number(cell[3])], [model.claims.length, model.claims.length, pct]);
    });
  }
});
