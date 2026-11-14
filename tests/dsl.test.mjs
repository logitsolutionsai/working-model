import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/engine/lexer.mjs';
import { parseExpression, parseProgram } from '../src/engine/parser.mjs';
import { compileExpressionSource, nameProblem } from '../src/engine/compile.mjs';
import { run, ev, codeOf } from './helpers.mjs';

describe('lexer', () => {
  test('numbers, strings, names, operators and comments', () => {
    const toks = tokenize("x = 1.5e2 + .5 # comment\ny += 'a\\'b' // more", 't');
    const vals = toks.map((t) => t.type + ':' + t.value);
    assert.deepEqual(vals, ['ident:x', 'op:=', 'num:150', 'op:+', 'num:0.5', 'nl:\n', 'ident:y', 'op:+=', "str:a'b", 'eof:null']);
  });
  test('newlines inside brackets are ignored', () => {
    const toks = tokenize('f(1,\n2)\n[3,\n4]', 't');
    assert.equal(toks.filter((t) => t.type === 'nl').length, 1);
  });
  test('errors carry codes and positions', () => {
    const e = codeOf(() => tokenize("x = 'open", 'rules.tick'));
    assert.equal(e.code, 'E_UNTERMINATED_STRING');
    assert.equal(e.loc.line, 1);
    assert.equal(e.loc.col, 5);
    assert.equal(codeOf(() => tokenize('a.b', 't')).code, 'E_SYNTAX');
    assert.equal(codeOf(() => tokenize('a @ b', 't')).code, 'E_SYNTAX');
    assert.equal(codeOf(() => tokenize('1abc', 't')).code, 'E_SYNTAX');
  });
});

describe('precedence', () => {
  const cases = [
    ['1 + 2 * 3', 7], ['(1 + 2) * 3', 9], ['10 - 2 - 3', 5], ['2 ** 3 ** 2', 512], ['-2 ** 2', -4], ['2 ** -1', 0.5],
    ['7 % 3', 1], ['-7 % 3', 2], ['8 / 4 / 2', 1], ['-(3 - 5)', 2], ['+3', 3],
    ['not 1 == 2', true], ['!(1 < 2)', false], ['true or false and false', true], ['(true or false) and false', false],
    ['false ? 1 : true ? 2 : 3', 2], ['1 < 2 ? 10 : 20', 10], ['true && !false', true], ['false || 2 >= 2', true],
    ['1 + 2 == 3 and 4 != 5', true], ["'ab' + 'c' == 'abc'", true], ["'a' < 'b'", true], ['[1, 2] + [3]', [1, 2, 3]],
    ['[1, [2, 3]] == [1, [2, 3]]', true], ['[1, 2][1]', 2], ['[1, 2, 3][-1]', 3], ["'hey'[1]", 'e'], ['null == null', true],
    ['min(3, 1, 2) + max([4, 9])', 10], ['clamp(15, 0, 10)', 10], ['round(2.567, 2)', 2.57], ['abs(-3) + floor(2.7) + ceil(0.2)', 6],
    ['sqrt(16) + pow(2, 3) + log(exp(2))', 14], ['sign(-4)', -1], ['pi > 3.14 and pi < 3.15', true],
  ];
  for (const [src, want] of cases) {
    test(src, () => assert.deepEqual(ev(src), want));
  }
  test('chained comparisons are rejected', () => {
    assert.equal(codeOf(() => parseExpression('1 < 2 < 3', 't')).code, 'E_CHAINED_COMPARISON');
    assert.equal(codeOf(() => parseExpression('a == b == c', 't')).code, 'E_CHAINED_COMPARISON');
  });
  test('the parse tree groups as documented', () => {
    const e = parseExpression('a or b and not c == d', 't');
    assert.equal(e.k, 'or');
    assert.equal(e.r.k, 'and');
    assert.equal(e.r.r.k, 'not');
    assert.equal(e.r.r.e.k, 'bin');
  });
});

describe('statements', () => {
  test('let and every assignment operator', () => {
    const { S } = run('let a = 2\nx = a\nx += 3\nx -= 1\nx *= 4\nx /= 2\nx %= 5\nx **= 2', { x: 0 });
    assert.equal(S.x, 9);
  });
  test('if, else if and else', () => {
    const src = 'if x > 5 { y = 1 } else if x > 2 { y = 2 }\nelse { y = 3 }';
    assert.equal(run(src, { x: 9, y: 0 }).S.y, 1);
    assert.equal(run(src, { x: 3, y: 0 }).S.y, 2);
    assert.equal(run(src, { x: 0, y: 0 }).S.y, 3);
  });
  test('while with break, for with continue', () => {
    const { S } = run('while true {\n  n += 1\n  if n >= 4 { break }\n}\nfor v in [1, 2, 3, 4] {\n  if v % 2 == 0 { continue }\n  s += v\n}', { n: 0, s: 0 });
    assert.equal(S.n, 4);
    assert.equal(S.s, 4);
  });
  test('list element assignment, nested and compound', () => {
    const { S } = run('xs[1] = 5\ngrid[0][1] += 2\nlet i = 0\nxs[i] -= 1', { xs: [1, 2, 3], grid: [[0, 0], [0, 0]] });
    assert.deepEqual(S.xs, [0, 5, 3]);
    assert.deepEqual(S.grid, [[0, 2], [0, 0]]);
  });
  test('emit with and without payload', () => {
    const { emitted } = run("emit('a')\nemit('b', [1, 2])");
    assert.deepEqual(emitted, [{ name: 'a', payload: null }, { name: 'b', payload: [1, 2] }]);
  });
  test('semicolons separate statements; else may follow a newline', () => {
    assert.equal(run('a = 1; b = 2; c = a + b', { a: 0, b: 0, c: 0 }).S.c, 3);
  });
  test('a bare value is not a statement', () => {
    assert.equal(codeOf(() => parseProgram('x + 1', 't')).code, 'E_USELESS_EXPRESSION');
  });
  test('expressions cannot assign', () => {
    assert.equal(codeOf(() => parseExpression('x = 1', 't')).code, 'E_ASSIGN_IN_EXPRESSION');
  });
});

describe('list functions', () => {
  test('mutating functions', () => {
    const { S } = run([
      'push(xs, 4)', 'unshift(xs, 0)', 'insert(xs, 2, 9)', 'a = pop(xs)', 'b = shift(xs)', 'c = remove(xs, 9)', 'd = remove(xs, 42)', 'e = removeAt(xs, 0)',
    ].join('\n'), { xs: [1, 2, 3], a: 0, b: 0, c: false, d: false, e: 0 });
    assert.deepEqual(S.xs, [2, 3]);
    assert.equal(S.a, 4);
    assert.equal(S.b, 0);
    assert.equal(S.c, true);
    assert.equal(S.d, false);
    assert.equal(S.e, 1);
  });
  test('pure functions', () => {
    assert.equal(ev('len([1, 2, 3]) + len("ab")'), 5);
    assert.equal(ev('contains([1, [2]], [2])'), true);
    assert.equal(ev('indexOf(["a", "b"], "b")'), 1);
    assert.equal(ev('indexOf([1], 7)'), -1);
    assert.equal(ev('count([1, 2, 1], 1)'), 2);
    assert.deepEqual(ev('slice([1, 2, 3, 4], 1, 3)'), [2, 3]);
    assert.equal(ev('slice("hello", 1)'), 'ello');
    assert.equal(ev('sum([1, 2, 3]) + mean([2, 4])'), 9);
    assert.deepEqual(ev('range(3)'), [0, 1, 2]);
    assert.deepEqual(ev('range(2, 5)'), [2, 3, 4]);
    assert.deepEqual(ev('fill(2, "x")'), ['x', 'x']);
    assert.deepEqual(ev('sorted([3, 1, 2])'), [1, 2, 3]);
    assert.deepEqual(ev('reversed([1, 2])'), [2, 1]);
    assert.equal(ev('str(3) + "!"'), '3!');
  });
  test('slice and fill return copies', () => {
    const { S } = run('let c = slice(xs, 0)\npush(c, 9)', { xs: [1] });
    assert.deepEqual(S.xs, [1]);
  });
  test('random functions are seeded and repeatable', () => {
    const a = run('r = [rand(), randint(1, 6), chance(0.5), pick([1, 2, 3]), rand(5, 6)]', { r: [] }).S.r;
    const b = run('r = [rand(), randint(1, 6), chance(0.5), pick([1, 2, 3]), rand(5, 6)]', { r: [] }).S.r;
    assert.deepEqual(a, b);
    assert.ok(a[1] >= 1 && a[1] <= 6 && Number.isInteger(a[1]));
    assert.ok(a[4] >= 5 && a[4] < 6);
  });
});

describe('errors with codes and locations', () => {
  const at = (src, state = {}, params = {}) => codeOf(() => run(src, state, params));
  test('unknown name with a suggestion and exact line and column', () => {
    const e = at('x = 1\ny = tokns + 1', { x: 0, y: 0, tokens: 0 });
    assert.equal(e.code, 'E_UNKNOWN_NAME');
    assert.match(e.message, /did you mean "tokens"/);
    assert.equal(e.loc.path, 'test');
    assert.equal(e.loc.line, 2);
    assert.equal(e.loc.col, 5);
  });
  const cases = [
    ['frob(1)', {}, {}, 'E_UNKNOWN_FUNCTION'],
    ['x = min()', { x: 0 }, {}, 'E_ARITY'],
    ['x = len(1, 2)', { x: 0 }, {}, 'E_ARITY'],
    ["x = 1 + 'a'", { x: 0 }, {}, 'E_TYPE'],
    ['if 1 { x = 1 }', { x: 0 }, {}, 'E_TYPE'],
    ['x = 1 / 0', { x: 0 }, {}, 'E_DIV_ZERO'],
    ['x = 5 % 0', { x: 0 }, {}, 'E_DIV_ZERO'],
    ['x = xs[5]', { x: 0, xs: [1] }, {}, 'E_INDEX'],
    ['x = xs[0.5]', { x: 0, xs: [1] }, {}, 'E_INDEX'],
    ['x = pop(xs)', { x: 0, xs: [] }, {}, 'E_EMPTY_LIST'],
    ['rate = 2', {}, { rate: 1 }, 'E_ASSIGN_READONLY'],
    ['t = 2', {}, {}, 'E_ASSIGN_READONLY'],
    ['break', {}, {}, 'E_BREAK_OUTSIDE_LOOP'],
    ['let x = 1', { x: 0 }, {}, 'E_SHADOW'],
    ['let a = 1\nlet a = 2', {}, {}, 'E_DUPLICATE_LET'],
    ["emit(name)", {}, {}, 'E_EMIT_NAME'],
    ["x = 'text'", { x: 0 }, {}, 'E_TYPE_CHANGE'],
    ['x = 10 ** 400', { x: 0 }, {}, 'E_NONFINITE'],
    ['x = sqrt(-1)', { x: 0 }, {}, 'E_DOMAIN'],
    ['x = log(0)', { x: 0 }, {}, 'E_DOMAIN'],
    ['if x { ', { x: true }, {}, 'E_SYNTAX'],
  ];
  for (const [src, state, params, code] of cases) {
    test(`${code}: ${src.replace(/\n/g, ' / ')}`, () => assert.equal(at(src, state, params).code, code));
  }
  test('impure functions are refused in expressions', () => {
    for (const src of ['rand()', 'push(xs, 1)', "emit('x')", 'pop(xs)']) {
      const e = codeOf(() => compileExpressionSource(src, 'claims.c.expr', { state: new Set(['xs']) }));
      assert.equal(e.code, 'E_IMPURE', src);
    }
  });
});

describe('security', () => {
  const hostile = ['constructor', '__proto__', 'prototype', 'globalThis', 'window', 'process', 'require', 'Function', 'eval', 'Object', 'this', 'toString', 'valueOf'];
  for (const name of hostile) {
    test(`"${name}" cannot be read`, () => {
      const e = codeOf(() => ev(name));
      assert.ok(['E_UNKNOWN_NAME', 'E_SYNTAX'].includes(e.code), e.code);
    });
    test(`"${name}" cannot be called`, () => {
      const e = codeOf(() => ev(`${name}()`));
      assert.ok(['E_UNKNOWN_FUNCTION', 'E_SYNTAX'].includes(e.code), e.code);
    });
    test(`"${name}" cannot be assigned`, () => {
      const e = codeOf(() => run(`${name} = 1`));
      assert.ok(['E_UNKNOWN_NAME', 'E_SYNTAX'].includes(e.code), e.code);
    });
  }
  test('no member access, so no path to prototypes', () => {
    assert.equal(codeOf(() => ev('xs.constructor', { xs: [] })).code, 'E_SYNTAX');
    assert.equal(codeOf(() => ev("xs['constructor']", { xs: [] })).code, 'E_TYPE');
    assert.equal(codeOf(() => ev("'abc'['length']")).code, 'E_TYPE');
    assert.equal(codeOf(() => run("xs['__proto__'] = 1", { xs: [] })).code, 'E_TYPE');
  });
  test('spec names that shadow JavaScript internals are refused', () => {
    for (const name of ['__proto__', 'constructor', 'prototype', '__x', 't', 'if', 'hasOwnProperty']) {
      assert.ok(nameProblem(name), name);
    }
    assert.equal(nameProblem('tokens'), null);
  });
  test('running hostile code leaves Object.prototype untouched', () => {
    try { run('__proto__ = 1'); } catch { /* expected */ }
    try { run("xs[0] = 'polluted'", { xs: [] }); } catch { /* expected */ }
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.toString.call([]), '[object Array]');
  });
  test('runaway loops hit the step limit', () => {
    const e = codeOf(() => run('while true { x += 1 }', { x: 0 }, {}, { maxSteps: 10000 }));
    assert.equal(e.code, 'E_STEP_LIMIT');
    const f = codeOf(() => run('for i in range(10000) { for j in range(10000) { x += 1 } }', { x: 0 }, {}, { maxSteps: 50000 }));
    assert.equal(f.code, 'E_STEP_LIMIT');
  });
  test('deep nesting is refused at parse time', () => {
    const deep = '('.repeat(300) + '1' + ')'.repeat(300);
    assert.equal(codeOf(() => parseExpression(deep, 't')).code, 'E_TOO_DEEP');
    const blocks = 'if true { '.repeat(150) + 'x = 1' + ' }'.repeat(150);
    assert.equal(codeOf(() => parseProgram(blocks, 't')).code, 'E_TOO_DEEP');
    const unary = '-'.repeat(500) + '1';
    assert.equal(codeOf(() => parseExpression(unary, 't')).code, 'E_TOO_DEEP');
  });
  test('huge lists and strings are bounded', () => {
    assert.equal(codeOf(() => ev('fill(1000000, 0)')).code, 'E_LIST_LIMIT');
    assert.equal(codeOf(() => ev('range(1000000000)')).code, 'E_LIST_LIMIT');
    assert.equal(codeOf(() => run('while true { push(xs, 1) }', { xs: [] })).code, 'E_LIST_LIMIT');
    assert.equal(codeOf(() => run("while true { s = s + s }", { s: 'ab' })).code, 'E_STRING_LIMIT');
    assert.equal(codeOf(() => tokenize('x'.repeat(30000), 't')).code, 'E_TOO_LONG');
  });
  // regression: fill(10000, fill(10000, 0)) ran Node out of memory in one line
  test('a list of lists cannot grow past the value limit', () => {
    const t0 = Date.now();
    assert.equal(codeOf(() => run('xs = fill(10000, fill(10000, 0))', { xs: [] })).code, 'E_LIST_LIMIT');
    // [xs, xs] used to share structure, so 40 doublings built 2^40 items when copied
    const e = codeOf(() => run('let i = 0\nwhile i < 40 { xs = [xs, xs]; i += 1 }\npush(ys, xs)', { xs: [1], ys: [] }));
    assert.ok(['E_STEP_LIMIT', 'E_LIST_LIMIT'].includes(e.code), e.code);
    assert.ok(Date.now() - t0 < 5000, 'fails fast');
  });
  // regression: each statement was one step however big its lists, so this ran for minutes
  test('list work counts towards the step limit', () => {
    const t0 = Date.now();
    const e = codeOf(() => run('let r = range(10000)\nwhile true { n = sum(sorted(r)) }', { n: 0 }));
    assert.equal(e.code, 'E_STEP_LIMIT');
    assert.match(e.message, /one step per item/);
    assert.ok(Date.now() - t0 < 5000, `stopped after ${Date.now() - t0} ms`);
    // ordinary list code stays far below the limit
    const { env: ok } = run('let xs = range(100)\nlet n = 0\nfor x in xs { if contains(xs, x) { n += 1 } }', {});
    assert.ok(ok.steps < 20000, `${ok.steps} steps`);
  });
});

// regression: "a = b" stored the same list under two names, so push(a, 1) changed b too
describe('lists are values', () => {
  test('assignment, let and list literals copy lists', () => {
    assert.deepEqual(run('a = b\npush(a, 1)', { a: [], b: [] }).S.b, []);
    assert.deepEqual(run('let x = b\npush(x, 1)\na = x', { a: [], b: [] }).S.b, []);
    assert.deepEqual(run('a = [b, b]\npush(b, 1)', { a: [], b: [] }).S.a, [[], []]);
    assert.deepEqual(run('a = [b]\npush(a[0], 1)', { a: [], b: [] }).S.b, []);
  });
  test('for iterates a copy, and nested lists still change through an index', () => {
    assert.deepEqual(run('for q in qs { push(q, 9) }', { qs: [[1], [2]] }).S.qs, [[1], [2]]);
    assert.deepEqual(run('push(qs[0], 9)\nqs[1][0] += 1', { qs: [[1], [2]] }).S.qs, [[1, 9], [3]]);
  });
  test('emit payloads are copies', () => {
    const { emitted } = run("emit('x', xs)\npush(xs, 2)", { xs: [1] });
    assert.deepEqual(emitted[0].payload, [1]);
  });
});
