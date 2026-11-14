// Compiles parsed rule code into plain JavaScript closures.
// There is no eval and no Function constructor: every node becomes a small
// closure over the environment object below, and names are resolved at
// compile time against the spec (locals, state, params, derived values and a
// handful of implicit names). Nothing else is reachable, so code such as
// constructor, __proto__ or globalThis is simply an unknown name.
//
// Runtime environment:
//   env.S  state values (null-prototype object)       env.P  params (null-prototype)
//   env.L  local slots for let and for                env.t, env.dt, env.tick
//   env.seq, env.batch, env.payload                   env.rng() seeded random
//   env.emit(name, payload)                           env.steps / env.maxSteps

import { ModelError, closest } from './errors.mjs';
import { parseProgram, parseExpression, isKeyword } from './parser.mjs';

export const LIMITS = {
  listLength: 10000,
  stringLength: 10000,
  steps: 2000000,
  cells: 1000000, // items in one list value, counting the items of nested lists
  depth: 100, // nesting of list values
  traceCells: 10000000, // values stored across all snapshots of one run
  checkSteps: 200000000, // rule steps plus ticks across every run one claim check makes (sweeps, compares)
};

const IMPLICIT = new Set(['t', 'dt', 'tick', 'seq', 'batch', 'payload', 'pi']);
const JS_MEMBERS = new Set(['constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

// Why a spec name is not allowed, or null when it is fine.
export function nameProblem(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return 'must start with a letter or "_" and use only letters, digits and "_" (at most 40 characters)';
  if (name.startsWith('__')) return 'names starting with "__" are reserved';
  if (isKeyword(name)) return `"${name}" is a keyword of the rule language`;
  if (IMPLICIT.has(name)) return `"${name}" is a built-in name (${[...IMPLICIT].join(', ')})`;
  if (JS_MEMBERS.has(name)) return `"${name}" is reserved`;
  return null;
}

// ---------------------------------------------------------------- values --

export function kindOf(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'list';
  const k = typeof v;
  if (k === 'number' || k === 'boolean' || k === 'string') return k;
  return 'invalid';
}

export function deepCopy(v) {
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = deepCopy(v[i]);
    return out;
  }
  return v;
}

// box (optional) counts the items compared, so callers can charge the work.
export function deepEqual(a, b, box) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    if (box) box.n += a.length;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], box)) return false;
    return true;
  }
  return false;
}

// Copy a list value, counting its items into box.n. Returns undefined (and
// sets box.over to 'cells' or 'depth') when the value is too big or too deep.
export function copyBounded(v, box, max, depth = 0) {
  if (!Array.isArray(v)) return v;
  if (depth >= LIMITS.depth) { box.over = 'depth'; return undefined; }
  box.n += v.length;
  if (box.n > max) { box.over = 'cells'; return undefined; }
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (Array.isArray(x)) {
      const c = copyBounded(x, box, max, depth + 1);
      if (c === undefined) return undefined;
      out[i] = c;
    } else out[i] = x;
  }
  return out;
}

export function showValue(v) {
  const k = kindOf(v);
  if (k === 'number') return fmtNum(v);
  if (k === 'string') return JSON.stringify(v);
  if (k === 'list') {
    const items = v.slice(0, 8).map(showValue);
    return '[' + items.join(', ') + (v.length > 8 ? `, … ${v.length} items` : '') + ']';
  }
  return String(v);
}

function fmtNum(x) {
  if (Number.isInteger(x)) return String(x);
  const a = Math.abs(x);
  if (a >= 1000) return x.toFixed(0);
  if (a >= 10) return String(Math.round(x * 100) / 100);
  if (a >= 0.01) return String(Math.round(x * 1000) / 1000);
  return x.toPrecision(3);
}

// ------------------------------------------------------------ builtins --

function typeErr(node, sc, msg) {
  return new ModelError('E_TYPE', msg, loc(sc, node.pos));
}
function loc(sc, pos) { return { path: sc.path, src: sc.src, pos }; }

function needNum(v, node, sc, what) {
  if (typeof v !== 'number') throw typeErr(node, sc, `${what} needs a number, got ${kindOf(v)} ${showValue(v)}`);
  return v;
}
function needList(v, node, sc, what) {
  if (!Array.isArray(v)) throw typeErr(node, sc, `${what} needs a list, got ${kindOf(v)} ${showValue(v)}`);
  return v;
}
function needBool(v, node, sc, what) {
  if (typeof v !== 'boolean') throw typeErr(node, sc, `${what} needs true or false, got ${kindOf(v)} ${showValue(v)}`);
  return v;
}
function finite(x, node, sc) {
  if (!Number.isFinite(x)) throw new ModelError('E_NONFINITE', 'the result is not a finite number (overflow or an undefined operation)', loc(sc, node.pos));
  return x;
}
function checkListSize(list, node, sc) {
  if (list.length > LIMITS.listLength) throw new ModelError('E_LIST_LIMIT', `a list grew past ${LIMITS.listLength} items`, loc(sc, node.pos));
  return list;
}

// Work accounting. Every statement costs one step, and a builtin that walks or
// builds a list costs one step per item, so rules cannot do unbounded work
// inside the step limit (a loop of sorted(range(10000)) used to run for minutes).
function stepLimitError(env, sc, node) {
  return new ModelError('E_STEP_LIMIT', `the rules ran more than ${env.maxSteps} steps in one simulation (copying or scanning a list costs one step per item); is there a loop that never ends, or a big list copied every tick?`, loc(sc, node.pos));
}
function charge(env, n, node, sc) {
  if (!env || !(n > 0)) return;
  env.steps += n;
  if (env.steps > env.maxSteps) throw stepLimitError(env, sc, node);
}
// Strings are capped at LIMITS.stringLength; charge them by the 64 characters.
function chargeText(env, s, node, sc) { charge(env, Math.ceil(s.length / 64), node, sc); }

// Lists are values: storing one (assignment, let, push, a list literal, an
// emit payload) stores a copy. The copy is charged and bounded.
function copyIn(v, env, node, sc) {
  if (!Array.isArray(v)) return v;
  const box = { n: 0, over: null };
  const out = copyBounded(v, box, LIMITS.cells);
  if (out === undefined) {
    if (box.over === 'depth') throw new ModelError('E_TOO_DEEP', `a list is nested more than ${LIMITS.depth} levels deep`, loc(sc, node.pos));
    throw new ModelError('E_LIST_LIMIT', `a list would hold more than ${LIMITS.cells} values, counting the items of nested lists`, loc(sc, node.pos));
  }
  charge(env, box.n, node, sc);
  return out;
}
function equalCharged(a, b, env, node, sc) {
  if (!Array.isArray(a) || !Array.isArray(b)) return deepEqual(a, b);
  const box = { n: 0 };
  const r = deepEqual(a, b, box);
  charge(env, box.n, node, sc);
  return r;
}

function findIndex(list, x, env, node, sc) {
  const box = { n: list.length };
  let found = -1;
  for (let i = 0; i < list.length; i++) if (deepEqual(list[i], x, box)) { found = i; break; }
  charge(env, box.n, node, sc);
  return found;
}

function numsOf(args, node, sc, name, env) {
  const xs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  if (xs.length === 0) throw new ModelError('E_EMPTY_LIST', `${name}() of an empty list`, loc(sc, node.pos));
  charge(env, xs.length, node, sc);
  for (const x of xs) needNum(x, node, sc, name + '()');
  return xs;
}
function listIndex(list, i, node, sc, what) {
  needNum(i, node, sc, what);
  if (!Number.isInteger(i)) throw new ModelError('E_INDEX', `${what} needs a whole number, got ${showValue(i)}`, loc(sc, node.pos));
  const j = i < 0 ? list.length + i : i;
  if (j < 0 || j >= list.length) throw new ModelError('E_INDEX', `index ${i} is outside a list of ${list.length} items`, loc(sc, node.pos));
  return j;
}

// pure: allowed in bindings, captions and claims. Impure functions mutate a
// list or draw random numbers, so they only make sense inside rules.
const BUILTINS = Object.assign(Object.create(null), {
  min: { min: 1, max: 99, pure: true, fn: (a, n, sc, env) => Math.min(...numsOf(a, n, sc, 'min', env)) },
  max: { min: 1, max: 99, pure: true, fn: (a, n, sc, env) => Math.max(...numsOf(a, n, sc, 'max', env)) },
  abs: { min: 1, max: 1, pure: true, fn: (a, n, sc) => Math.abs(needNum(a[0], n, sc, 'abs()')) },
  floor: { min: 1, max: 1, pure: true, fn: (a, n, sc) => Math.floor(needNum(a[0], n, sc, 'floor()')) },
  ceil: { min: 1, max: 1, pure: true, fn: (a, n, sc) => Math.ceil(needNum(a[0], n, sc, 'ceil()')) },
  round: {
    min: 1, max: 2, pure: true, fn: (a, n, sc) => {
      const x = needNum(a[0], n, sc, 'round()');
      if (a.length === 1) return Math.round(x);
      const d = needNum(a[1], n, sc, 'round()');
      const f = Math.pow(10, Math.max(0, Math.min(10, Math.floor(d))));
      return Math.round(x * f) / f;
    },
  },
  sqrt: {
    min: 1, max: 1, pure: true, fn: (a, n, sc) => {
      const x = needNum(a[0], n, sc, 'sqrt()');
      if (x < 0) throw new ModelError('E_DOMAIN', `sqrt() of a negative number (${showValue(x)})`, loc(sc, n.pos));
      return Math.sqrt(x);
    },
  },
  pow: { min: 2, max: 2, pure: true, fn: (a, n, sc) => finite(Math.pow(needNum(a[0], n, sc, 'pow()'), needNum(a[1], n, sc, 'pow()')), n, sc) },
  exp: { min: 1, max: 1, pure: true, fn: (a, n, sc) => finite(Math.exp(needNum(a[0], n, sc, 'exp()')), n, sc) },
  log: {
    min: 1, max: 2, pure: true, fn: (a, n, sc) => {
      const x = needNum(a[0], n, sc, 'log()');
      if (x <= 0) throw new ModelError('E_DOMAIN', `log() of a number that is not positive (${showValue(x)})`, loc(sc, n.pos));
      if (a.length === 1) return Math.log(x);
      const b = needNum(a[1], n, sc, 'log()');
      if (b <= 0 || b === 1) throw new ModelError('E_DOMAIN', 'log() base must be positive and not 1', loc(sc, n.pos));
      return Math.log(x) / Math.log(b);
    },
  },
  clamp: {
    min: 3, max: 3, pure: true, fn: (a, n, sc) => {
      const x = needNum(a[0], n, sc, 'clamp()');
      const lo = needNum(a[1], n, sc, 'clamp()');
      const hi = needNum(a[2], n, sc, 'clamp()');
      return Math.min(hi, Math.max(lo, x));
    },
  },
  sign: { min: 1, max: 1, pure: true, fn: (a, n, sc) => Math.sign(needNum(a[0], n, sc, 'sign()')) },
  sin: { min: 1, max: 1, pure: true, fn: (a, n, sc) => Math.sin(needNum(a[0], n, sc, 'sin()')) },
  cos: { min: 1, max: 1, pure: true, fn: (a, n, sc) => Math.cos(needNum(a[0], n, sc, 'cos()')) },

  rand: {
    min: 0, max: 2, pure: false, random: true, fn: (a, n, sc, env) => {
      const u = env.rng();
      if (a.length === 0) return u;
      if (a.length === 1) return u * needNum(a[0], n, sc, 'rand()');
      const lo = needNum(a[0], n, sc, 'rand()');
      return lo + u * (needNum(a[1], n, sc, 'rand()') - lo);
    },
  },
  randint: {
    min: 2, max: 2, pure: false, random: true, fn: (a, n, sc, env) => {
      const lo = Math.ceil(needNum(a[0], n, sc, 'randint()'));
      const hi = Math.floor(needNum(a[1], n, sc, 'randint()'));
      if (hi < lo) throw new ModelError('E_DOMAIN', `randint(${lo}, ${hi}) has no whole numbers to pick from`, loc(sc, n.pos));
      return lo + Math.floor(env.rng() * (hi - lo + 1));
    },
  },
  chance: { min: 1, max: 1, pure: false, random: true, fn: (a, n, sc, env) => env.rng() < needNum(a[0], n, sc, 'chance()') },
  pick: {
    min: 1, max: 1, pure: false, random: true, fn: (a, n, sc, env) => {
      const l = needList(a[0], n, sc, 'pick()');
      if (l.length === 0) throw new ModelError('E_EMPTY_LIST', 'pick() from an empty list', loc(sc, n.pos));
      return l[Math.floor(env.rng() * l.length)];
    },
  },

  len: {
    min: 1, max: 1, pure: true, fn: (a, n, sc) => {
      const v = a[0];
      if (Array.isArray(v) || typeof v === 'string') return v.length;
      throw typeErr(n, sc, `len() needs a list or a string, got ${kindOf(v)}`);
    },
  },
  push: {
    min: 2, max: 2, pure: false, fn: (a, n, sc, env) => {
      const l = needList(a[0], n, sc, 'push()');
      l.push(copyIn(a[1], env, n, sc));
      checkListSize(l, n, sc);
      return null;
    },
  },
  unshift: {
    min: 2, max: 2, pure: false, fn: (a, n, sc, env) => {
      const l = needList(a[0], n, sc, 'unshift()');
      l.unshift(copyIn(a[1], env, n, sc));
      checkListSize(l, n, sc);
      return null;
    },
  },
  insert: {
    min: 3, max: 3, pure: false, fn: (a, n, sc, env) => {
      const l = needList(a[0], n, sc, 'insert()');
      const i = needNum(a[1], n, sc, 'insert()');
      if (!Number.isInteger(i) || i < 0 || i > l.length) throw new ModelError('E_INDEX', `insert() position ${showValue(i)} is outside 0..${l.length}`, loc(sc, n.pos));
      l.splice(i, 0, copyIn(a[2], env, n, sc));
      checkListSize(l, n, sc);
      return null;
    },
  },
  pop: {
    min: 1, max: 1, pure: false, fn: (a, n, sc) => {
      const l = needList(a[0], n, sc, 'pop()');
      if (l.length === 0) throw new ModelError('E_EMPTY_LIST', 'pop() from an empty list', loc(sc, n.pos));
      return l.pop();
    },
  },
  shift: {
    min: 1, max: 1, pure: false, fn: (a, n, sc) => {
      const l = needList(a[0], n, sc, 'shift()');
      if (l.length === 0) throw new ModelError('E_EMPTY_LIST', 'shift() from an empty list', loc(sc, n.pos));
      return l.shift();
    },
  },
  remove: {
    min: 2, max: 2, pure: false, fn: (a, n, sc, env) => {
      const l = needList(a[0], n, sc, 'remove()');
      const i = findIndex(l, a[1], env, n, sc);
      if (i < 0) return false;
      l.splice(i, 1);
      return true;
    },
  },
  removeAt: {
    min: 2, max: 2, pure: false, fn: (a, n, sc) => {
      const l = needList(a[0], n, sc, 'removeAt()');
      const j = listIndex(l, a[1], n, sc, 'removeAt()');
      return l.splice(j, 1)[0];
    },
  },
  contains: {
    min: 2, max: 2, pure: true, fn: (a, n, sc, env) => findIndex(needList(a[0], n, sc, 'contains()'), a[1], env, n, sc) >= 0,
  },
  indexOf: {
    min: 2, max: 2, pure: true, fn: (a, n, sc, env) => findIndex(needList(a[0], n, sc, 'indexOf()'), a[1], env, n, sc),
  },
  count: {
    min: 2, max: 2, pure: true, fn: (a, n, sc, env) => {
      const l = needList(a[0], n, sc, 'count()');
      const box = { n: l.length };
      let c = 0;
      for (const x of l) if (deepEqual(x, a[1], box)) c++;
      charge(env, box.n, n, sc);
      return c;
    },
  },
  slice: {
    min: 2, max: 3, pure: true, fn: (a, n, sc, env) => {
      const l = a[0];
      if (!Array.isArray(l) && typeof l !== 'string') throw typeErr(n, sc, 'slice() needs a list or a string');
      const s = needNum(a[1], n, sc, 'slice()');
      const e = a.length > 2 ? needNum(a[2], n, sc, 'slice()') : l.length;
      if (Array.isArray(l)) return copyIn(l.slice(s, e), env, n, sc);
      const out = l.slice(s, e);
      chargeText(env, out, n, sc);
      return out;
    },
  },
  sum: {
    min: 1, max: 1, pure: true, fn: (a, n, sc, env) => {
      const l = needList(a[0], n, sc, 'sum()');
      charge(env, l.length, n, sc);
      let s = 0;
      for (const x of l) s += needNum(x, n, sc, 'sum()');
      return finite(s, n, sc);
    },
  },
  mean: {
    min: 1, max: 1, pure: true, fn: (a, n, sc, env) => {
      const l = needList(a[0], n, sc, 'mean()');
      if (l.length === 0) throw new ModelError('E_EMPTY_LIST', 'mean() of an empty list', loc(sc, n.pos));
      charge(env, l.length, n, sc);
      let s = 0;
      for (const x of l) s += needNum(x, n, sc, 'mean()');
      return s / l.length;
    },
  },
  range: {
    min: 1, max: 2, pure: true, fn: (a, n, sc, env) => {
      let lo = 0;
      let hi = needNum(a[0], n, sc, 'range()');
      if (a.length === 2) { lo = hi; hi = needNum(a[1], n, sc, 'range()'); }
      lo = Math.ceil(lo); hi = Math.ceil(hi);
      if (hi - lo > LIMITS.listLength) throw new ModelError('E_LIST_LIMIT', `range() would make more than ${LIMITS.listLength} items`, loc(sc, n.pos));
      charge(env, hi - lo, n, sc);
      const out = [];
      for (let i = lo; i < hi; i++) out.push(i);
      return out;
    },
  },
  fill: {
    min: 2, max: 2, pure: true, fn: (a, n, sc, env) => {
      const k = needNum(a[0], n, sc, 'fill()');
      if (!Number.isInteger(k) || k < 0) throw new ModelError('E_DOMAIN', 'fill() needs a whole number of items', loc(sc, n.pos));
      if (k > LIMITS.listLength) throw new ModelError('E_LIST_LIMIT', `fill() would make more than ${LIMITS.listLength} items`, loc(sc, n.pos));
      const out = new Array(k);
      if (!Array.isArray(a[1])) {
        charge(env, k, n, sc);
        return out.fill(a[1]);
      }
      // a list of lists: check the total size before building anything
      const one = copyIn(a[1], null, n, sc);
      const box = { n: 0 };
      copyBounded(one, box, LIMITS.cells);
      if ((box.n + 1) * k > LIMITS.cells) throw new ModelError('E_LIST_LIMIT', `fill() would make more than ${LIMITS.cells} values, counting the items of nested lists`, loc(sc, n.pos));
      charge(env, (box.n + 1) * k, n, sc);
      for (let i = 0; i < k; i++) out[i] = copyBounded(one, { n: 0 }, LIMITS.cells);
      return out;
    },
  },
  sorted: {
    min: 1, max: 1, pure: true, fn: (a, n, sc, env) => {
      const l = needList(a[0], n, sc, 'sorted()');
      charge(env, l.length * Math.max(1, Math.ceil(Math.log2(l.length + 1))), n, sc);
      const c = l.slice();
      const allNum = c.every((x) => typeof x === 'number');
      const allStr = c.every((x) => typeof x === 'string');
      if (!allNum && !allStr) throw typeErr(n, sc, 'sorted() needs a list of only numbers or only strings');
      return c.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    },
  },
  reversed: { min: 1, max: 1, pure: true, fn: (a, n, sc, env) => copyIn(needList(a[0], n, sc, 'reversed()'), env, n, sc).reverse() },
  str: {
    min: 1, max: 1, pure: true, fn: (a, n, sc, env) => {
      if (typeof a[0] === 'string') return a[0];
      const out = showValue(a[0]);
      chargeText(env, out, n, sc);
      return out;
    },
  },
  emit: { min: 1, max: 2, pure: false, emit: true, fn: null },
});

export function builtinNames() { return Object.keys(BUILTINS); }

// ------------------------------------------------------------- compiler --

// sc (compile scope):
//   path, src, mode ('rules' | 'expr'), state:Set, params:Set,
//   derived: Map(name -> closure getter), implicit:Set (extra names allowed),
//   extra: Map(name -> getter) for special scopes such as compare's a and b
//   locals: [Map], slots: {n}, loops: number, emits: Set, refs: Set
export function makeScope(base, path, src, mode) {
  return {
    path, src, mode,
    state: base.state || new Set(),
    params: base.params || new Set(),
    derived: base.derived || new Map(),
    implicit: base.implicit || new Set(['t', 'dt', 'tick', 'pi']),
    extra: base.extra || new Map(),
    readonlyState: !!base.readonlyState,
    what: base.what,
    locals: [new Map()],
    slots: { n: 0 },
    loops: 0,
    emits: base.emits || new Set(),
    refs: new Set(),
  };
}

export function compileProgramSource(src, path, base) {
  return compileProgramAst(parseProgram(src, path), src, path, base);
}

// Compile an already parsed program. `check --mutate` uses this to compile
// rule code whose syntax tree it has changed on purpose.
export function compileProgramAst(ast, src, path, base) {
  const sc = makeScope(base, path, src, 'rules');
  const run = compileBlock(ast, sc);
  const nslots = () => sc.slots.n;
  const fn = (env) => {
    env.L = new Array(nslots());
    run(env);
  };
  fn.refs = sc.refs;
  fn.emits = sc.emits;
  return fn;
}

export function compileExpressionSource(src, path, base) {
  const sc = makeScope(base, path, src, 'expr');
  const ast = parseExpression(src, path);
  const f = compileExpr(ast, sc);
  const fn = (env) => {
    if (!env.L) env.L = [];
    return f(env);
  };
  fn.refs = sc.refs;
  fn.ast = ast;
  return fn;
}

function lookupLocal(sc, name) {
  for (let i = sc.locals.length - 1; i >= 0; i--) {
    const m = sc.locals[i];
    if (m.has(name)) return m.get(name);
  }
  return undefined;
}

function unknownName(sc, node, name) {
  const pool = [...sc.state, ...sc.params, ...sc.derived.keys(), ...sc.implicit, ...sc.extra.keys()];
  for (const m of sc.locals) pool.push(...m.keys());
  const guess = closest(name, pool);
  const e = new ModelError('E_UNKNOWN_NAME', `unknown name "${name}"` + (guess ? `; did you mean "${guess}"?` : ''), loc(sc, node.pos));
  e.hint = guess ? `use ${guess}` : (sc.mode === 'rules' ? 'declare it in "state", or create a local with let' : 'only state, params, derived values and t can be used here');
  return e;
}

function compileName(node, sc) {
  const name = node.name;
  const slot = lookupLocal(sc, name);
  if (slot !== undefined) return (env) => env.L[slot];
  if (sc.extra.has(name)) { sc.refs.add(name); return sc.extra.get(name); }
  if (sc.implicit.has(name)) {
    sc.refs.add(name);
    switch (name) {
      case 't': return (env) => env.t;
      case 'dt': return (env) => env.dt;
      case 'tick': return (env) => env.tick;
      case 'seq': return (env) => env.seq;
      case 'batch': return (env) => env.batch;
      case 'payload': return (env) => (env.payload === undefined ? null : env.payload);
      case 'pi': return () => Math.PI;
      default: break;
    }
  }
  if (sc.state.has(name)) { sc.refs.add(name); return (env) => env.S[name]; }
  if (sc.params.has(name)) { sc.refs.add(name); return (env) => env.P[name]; }
  if (sc.derived.has(name)) { sc.refs.add(name); const g = sc.derived.get(name); return (env) => g(env); }
  throw unknownName(sc, node, name);
}

export function compileExpr(node, sc) {
  switch (node.k) {
    case 'num': { const v = node.v; return () => v; }
    case 'str': { const v = node.v; return () => v; }
    case 'bool': { const v = node.v; return () => v; }
    case 'null': return () => null;
    case 'name': return compileName(node, sc);
    case 'list': {
      const items = node.items.map((x) => compileExpr(x, sc));
      return (env) => {
        const out = new Array(items.length);
        for (let i = 0; i < items.length; i++) out[i] = copyIn(items[i](env), env, node, sc);
        return checkListSize(out, node, sc);
      };
    }
    case 'un': {
      const e = compileExpr(node.e, sc);
      if (node.op === '-') return (env) => -needNum(e(env), node, sc, 'unary "-"');
      return (env) => needNum(e(env), node, sc, 'unary "+"');
    }
    case 'not': {
      const e = compileExpr(node.e, sc);
      return (env) => !needBool(e(env), node, sc, '"not"');
    }
    case 'and': {
      const l = compileExpr(node.l, sc);
      const r = compileExpr(node.r, sc);
      return (env) => needBool(l(env), node, sc, '"and"') && needBool(r(env), node, sc, '"and"');
    }
    case 'or': {
      const l = compileExpr(node.l, sc);
      const r = compileExpr(node.r, sc);
      return (env) => needBool(l(env), node, sc, '"or"') || needBool(r(env), node, sc, '"or"');
    }
    case 'tern': {
      const c = compileExpr(node.c, sc);
      const a = compileExpr(node.a, sc);
      const b = compileExpr(node.b, sc);
      return (env) => (needBool(c(env), node, sc, 'the condition of "? :"') ? a(env) : b(env));
    }
    case 'bin': return compileBinary(node, sc);
    case 'index': {
      const o = compileExpr(node.obj, sc);
      const ix = compileExpr(node.idx, sc);
      return (env) => {
        const v = o(env);
        if (!Array.isArray(v) && typeof v !== 'string') throw typeErr(node, sc, `only lists and strings can be indexed, got ${kindOf(v)}`);
        const j = listIndex(v, ix(env), node, sc, 'an index');
        return v[j];
      };
    }
    case 'call': return compileCall(node, sc);
    default:
      throw new ModelError('E_SYNTAX', `unsupported expression "${node.k}"`, loc(sc, node.pos));
  }
}

function arith(op, a, b, node, sc, env) {
  switch (op) {
    case '+':
      if (typeof a === 'number' && typeof b === 'number') return finite(a + b, node, sc);
      if (typeof a === 'string' && typeof b === 'string') {
        const s = a + b;
        if (s.length > LIMITS.stringLength) throw new ModelError('E_STRING_LIMIT', `a string grew past ${LIMITS.stringLength} characters`, loc(sc, node.pos));
        chargeText(env, s, node, sc);
        return s;
      }
      if (Array.isArray(a) && Array.isArray(b)) return checkListSize(copyIn(a.concat(b), env, node, sc), node, sc);
      throw typeErr(node, sc, `"+" needs two numbers, two strings or two lists, got ${kindOf(a)} and ${kindOf(b)} (use str() to turn a number into text)`);
    case '-': return finite(needNum(a, node, sc, '"-"') - needNum(b, node, sc, '"-"'), node, sc);
    case '*': return finite(needNum(a, node, sc, '"*"') * needNum(b, node, sc, '"*"'), node, sc);
    case '/': {
      const x = needNum(a, node, sc, '"/"');
      const y = needNum(b, node, sc, '"/"');
      if (y === 0) throw new ModelError('E_DIV_ZERO', 'division by zero', loc(sc, node.pos));
      return finite(x / y, node, sc);
    }
    case '%': {
      const x = needNum(a, node, sc, '"%"');
      const y = needNum(b, node, sc, '"%"');
      if (y === 0) throw new ModelError('E_DIV_ZERO', 'remainder by zero', loc(sc, node.pos));
      return finite(x - y * Math.floor(x / y), node, sc);
    }
    case '**': return finite(Math.pow(needNum(a, node, sc, '"**"'), needNum(b, node, sc, '"**"')), node, sc);
    default: throw new ModelError('E_SYNTAX', `unknown operator ${op}`, loc(sc, node.pos));
  }
}

function compare(op, a, b, node, sc, env) {
  if (op === '==') return equalCharged(a, b, env, node, sc);
  if (op === '!=') return !equalCharged(a, b, env, node, sc);
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (!((ka === 'number' && kb === 'number') || (ka === 'string' && kb === 'string'))) {
    throw typeErr(node, sc, `"${op}" compares two numbers or two strings, got ${ka} and ${kb}`);
  }
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    default: return a >= b;
  }
}

function compileBinary(node, sc) {
  const l = compileExpr(node.l, sc);
  const r = compileExpr(node.r, sc);
  const op = node.op;
  if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    return (env) => compare(op, l(env), r(env), node, sc, env);
  }
  return (env) => arith(op, l(env), r(env), node, sc, env);
}

function compileCall(node, sc) {
  const b = BUILTINS[node.name];
  if (!b) {
    const guess = closest(node.name, Object.keys(BUILTINS));
    const e = new ModelError('E_UNKNOWN_FUNCTION', `unknown function "${node.name}"` + (guess ? `; did you mean "${guess}"?` : ''), loc(sc, node.pos));
    e.hint = 'available: ' + Object.keys(BUILTINS).join(', ');
    throw e;
  }
  const n = node.args.length;
  if (n < b.min || n > b.max) {
    const want = b.min === b.max ? `${b.min}` : b.max >= 99 ? `at least ${b.min}` : `${b.min} to ${b.max}`;
    throw new ModelError('E_ARITY', `${node.name}() takes ${want} argument${want === '1' ? '' : 's'}, got ${n}`, loc(sc, node.pos));
  }
  if (!b.pure && sc.mode !== 'rules') {
    throw new ModelError('E_IMPURE', `${node.name}() ${b.random ? 'draws random numbers' : b.emit ? 'fires an effect' : 'changes a list'}, so it can only be used in rules, not in ${sc.what || 'an expression'}`, loc(sc, node.pos));
  }
  if (b.emit) {
    const nameArg = node.args[0];
    if (nameArg.k !== 'str') throw new ModelError('E_EMIT_NAME', 'emit() needs a quoted name as its first argument, such as emit(\'accept\')', loc(sc, nameArg.pos));
    const ename = nameArg.v;
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,39}$/.test(ename) || ename.startsWith('__')) throw new ModelError('E_EMIT_NAME', `emit name "${ename}" must use letters, digits, "-" and "_", and not start with "__"`, loc(sc, nameArg.pos));
    sc.emits.add(ename);
    const p = node.args[1] ? compileExpr(node.args[1], sc) : null;
    return (env) => { env.emit(ename, p ? copyIn(p(env), env, node, sc) : null); return null; };
  }
  const args = node.args.map((a) => compileExpr(a, sc));
  const fn = b.fn;
  if (args.length === 1) {
    const a0 = args[0];
    return (env) => fn([a0(env)], node, sc, env);
  }
  return (env) => {
    const vals = new Array(args.length);
    for (let i = 0; i < args.length; i++) vals[i] = args[i](env);
    return fn(vals, node, sc, env);
  };
}

// ---------------------------------------------------------- statements --

const NORMAL = 0;
const BREAK = 1;
const CONTINUE = 2;

function tick(env, node, sc) {
  if (++env.steps > env.maxSteps) throw stepLimitError(env, sc, node);
}

function compileBlock(stmts, sc) {
  sc.locals.push(new Map());
  const fns = stmts.map((s) => compileStmt(s, sc));
  sc.locals.pop();
  const n = fns.length;
  return (env) => {
    for (let i = 0; i < n; i++) {
      const sig = fns[i](env);
      if (sig !== NORMAL) return sig;
    }
    return NORMAL;
  };
}

function declareLocal(sc, name, node) {
  const where = loc(sc, node.namePos != null ? node.namePos : node.pos);
  if (sc.state.has(name) || sc.params.has(name) || sc.derived.has(name) || sc.implicit.has(name) || sc.extra.has(name)) {
    throw new ModelError('E_SHADOW', `"${name}" is already a ${sc.state.has(name) ? 'state value' : sc.params.has(name) ? 'param' : sc.derived.has(name) ? 'derived value' : 'built-in name'}; pick another name for the local`, where);
  }
  const top = sc.locals[sc.locals.length - 1];
  if (top.has(name)) throw new ModelError('E_DUPLICATE_LET', `"${name}" is already declared in this block`, where);
  const slot = sc.slots.n++;
  top.set(name, slot);
  return slot;
}

function stateWriter(sc, name, node) {
  return (env, v) => {
    const k = kindOf(v);
    if (k === 'number' && !Number.isFinite(v)) throw new ModelError('E_NONFINITE', `"${name}" would become a non-finite number`, loc(sc, node.pos));
    const want = env.kinds && env.kinds[name];
    if (want && want !== k && !(want === 'null' || k === 'null')) {
      throw new ModelError('E_TYPE_CHANGE', `"${name}" holds a ${want} but this assigns a ${k} (${showValue(v)})`, loc(sc, node.pos));
    }
    env.S[name] = v;
  };
}

function compileStmt(node, sc) {
  switch (node.k) {
    case 'let': {
      const e = compileExpr(node.e, sc);
      const slot = declareLocal(sc, node.name, node);
      return (env) => { tick(env, node, sc); env.L[slot] = copyIn(e(env), env, node, sc); return NORMAL; };
    }
    case 'assign': return compileAssign(node, sc);
    case 'if': {
      const c = compileExpr(node.c, sc);
      const a = compileBlock(node.then, sc);
      const b = node.else ? compileBlock(node.else, sc) : null;
      return (env) => {
        tick(env, node, sc);
        if (needBool(c(env), node, sc, 'the condition of "if"')) return a(env);
        return b ? b(env) : NORMAL;
      };
    }
    case 'while': {
      const c = compileExpr(node.c, sc);
      sc.loops++;
      const body = compileBlock(node.body, sc);
      sc.loops--;
      return (env) => {
        while (true) {
          tick(env, node, sc);
          if (!needBool(c(env), node, sc, 'the condition of "while"')) break;
          const sig = body(env);
          if (sig === BREAK) break;
        }
        return NORMAL;
      };
    }
    case 'for': {
      const it = compileExpr(node.iter, sc);
      sc.locals.push(new Map());
      const slot = declareLocal(sc, node.name, node);
      sc.loops++;
      const body = compileBlock(node.body, sc);
      sc.loops--;
      sc.locals.pop();
      return (env) => {
        const list = it(env);
        if (!Array.isArray(list)) throw typeErr(node, sc, `"for ... in" needs a list, got ${kindOf(list)}`);
        const items = copyIn(list, env, node, sc);
        for (let i = 0; i < items.length; i++) {
          tick(env, node, sc);
          env.L[slot] = items[i];
          const sig = body(env);
          if (sig === BREAK) break;
        }
        return NORMAL;
      };
    }
    case 'break':
    case 'continue': {
      if (sc.loops === 0) throw new ModelError('E_BREAK_OUTSIDE_LOOP', `"${node.k}" can only be used inside a loop`, loc(sc, node.pos));
      const sig = node.k === 'break' ? BREAK : CONTINUE;
      return () => sig;
    }
    case 'expr': {
      const e = compileExpr(node.e, sc);
      return (env) => { tick(env, node, sc); e(env); return NORMAL; };
    }
    default:
      throw new ModelError('E_SYNTAX', `unsupported statement "${node.k}"`, loc(sc, node.pos));
  }
}

function compileAssign(node, sc) {
  const op = node.op;
  const rhs = compileExpr(node.e, sc);
  const bop = op === '=' ? null : op.slice(0, -1);
  const tgt = node.target;
  if (tgt.k === 'name') {
    const name = tgt.name;
    const slot = lookupLocal(sc, name);
    if (slot !== undefined) {
      return (env) => {
        tick(env, node, sc);
        const v = rhs(env);
        env.L[slot] = bop ? arith(bop, env.L[slot], v, node, sc, env) : copyIn(v, env, node, sc);
        return NORMAL;
      };
    }
    if (sc.state.has(name)) {
      if (sc.readonlyState) throw new ModelError('E_ASSIGN_READONLY', `"${name}" cannot be changed here`, loc(sc, tgt.pos));
      sc.refs.add(name);
      const write = stateWriter(sc, name, node);
      return (env) => {
        tick(env, node, sc);
        const v = rhs(env);
        write(env, bop ? arith(bop, env.S[name], v, node, sc, env) : copyIn(v, env, node, sc));
        return NORMAL;
      };
    }
    if (sc.params.has(name)) throw new ModelError('E_ASSIGN_READONLY', `"${name}" is a param (a slider), so rules cannot change it; copy it into state if it must change`, loc(sc, tgt.pos));
    if (sc.derived.has(name)) throw new ModelError('E_ASSIGN_READONLY', `"${name}" is a derived value, computed from state; change the state it depends on instead`, loc(sc, tgt.pos));
    if (sc.implicit.has(name) || sc.extra.has(name)) throw new ModelError('E_ASSIGN_READONLY', `"${name}" is a built-in name and cannot be assigned`, loc(sc, tgt.pos));
    throw unknownName(sc, tgt, name);
  }
  // list element: a[i] = v, a[i][j] += v
  const obj = compileExpr(tgt.obj, sc);
  const idx = compileExpr(tgt.idx, sc);
  if (sc.readonlyState) {
    let root = tgt;
    while (root.k === 'index') root = root.obj;
    if (root.k === 'name' && sc.state.has(root.name)) throw new ModelError('E_ASSIGN_READONLY', `"${root.name}" cannot be changed here`, loc(sc, tgt.pos));
  }
  return (env) => {
    tick(env, node, sc);
    const list = obj(env);
    if (!Array.isArray(list)) throw typeErr(tgt, sc, `only list elements can be assigned with [ ], got ${kindOf(list)}`);
    const j = listIndex(list, idx(env), tgt, sc, 'an index');
    const v = rhs(env);
    const nv = bop ? arith(bop, list[j], v, node, sc, env) : copyIn(v, env, node, sc);
    if (typeof nv === 'number' && !Number.isFinite(nv)) throw new ModelError('E_NONFINITE', 'a list element would become a non-finite number', loc(sc, node.pos));
    list[j] = nv;
    return NORMAL;
  };
}
