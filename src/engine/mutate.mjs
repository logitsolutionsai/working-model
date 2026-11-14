// Mutation testing for claims (`working-model check --mutate`).
//
// A claim is a test, so the claims themselves can be tested: break the
// mechanism on purpose in many small ways and see which claims notice. Each
// mutant changes one thing in the parsed rule code (never the source text) or
// moves one scheduled event by a tick. Every claim is then checked against
// every mutant, at the current params, with sweeps and compares as usual.
//
//   killed       some claim fails on the mutant: a claim caught the bug
//   engine       the mutant does not compile or hits a runtime error
//   equivalent   the whole state trace and every signal are identical to the
//                original at every param set the claims look at: nothing
//                observable changed, so it is left out of the score
//   visual       what claims can see is identical, but display state (values
//                only parts read) or an unwatched signal differs: it only
//                changes what the page draws; also left out of the score
//   ignored      survived, but listed in the spec's mutate.ignore with a reason
//   survived     something a claim can see changes and no claim notices
//
// Score = (killed + engine) / (killed + engine + survived).

import { ModelError, withLineCol } from './errors.mjs';
import { parseProgram } from './parser.mjs';
import { compileProgramAst, LIMITS } from './compile.mjs';
import { codeText } from './model.mjs';
import { checkClaims, sweepSamples } from './claims.mjs';
import { simulate, resolveParams, makeBudget } from './simulate.mjs';
import { makeRng, hashSeed } from './rng.mjs';

export const MUTATE_DEFAULT_CAP = 200;

export const OPERATORS = {
  relational: 'boundary and equality swaps (< <=, > >=, == !=)',
  arithmetic: 'arithmetic swaps (+ -, * /, += -=, *= /=)',
  constant: 'off-by-one constants (n to n + 1 and n - 1)',
  bound: 'a min, max or clamp dropped, or min and max swapped',
  'list-order': 'shift and pop swapped, push to the front, a remove dropped',
  'negate-if': 'an if condition negated',
  'drop-else': 'an else branch dropped',
  'delete-statement': 'one statement deleted',
  logical: 'and and or swapped',
  emit: 'an emit removed',
  'event-time': 'a scheduled event moved one tick later',
};

const REL_SWAP = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '!=': '==' };
const ARITH_SWAP = { '+': '-', '-': '+', '*': '/', '/': '*' };
const ASSIGN_SWAP = { '+=': '-=', '-=': '+=', '*=': '/=', '/=': '*=' };
const LIST_SWAP = { shift: 'pop', pop: 'shift', push: 'unshift', unshift: 'push' };

// ---------------------------------------------------------------- AST walk --

function exprChildren(n) {
  switch (n.k) {
    case 'list': return n.items;
    case 'un': case 'not': return [n.e];
    case 'and': case 'or': case 'bin': return [n.l, n.r];
    case 'tern': return [n.c, n.a, n.b];
    case 'index': return [n.obj, n.idx];
    case 'call': return n.args;
    default: return [];
  }
}

// Pre-order walk over statements and expressions. fn(node, ctx) where ctx
// says whether the node is a statement and, for statements, which block it
// sits in. The order is fixed, so the n-th node of a copy of the tree is the
// same node as the n-th node of the original.
function walk(stmts, fn) {
  let ord = 0;
  const visitExpr = (n) => {
    fn(n, { ord: ord++, stmt: false });
    for (const c of exprChildren(n)) visitExpr(c);
  };
  const visitBlock = (block, owner) => {
    for (const s of block) {
      fn(s, { ord: ord++, stmt: true, block, owner });
      switch (s.k) {
        case 'let': visitExpr(s.e); break;
        case 'assign': visitExpr(s.target); visitExpr(s.e); break;
        case 'if':
          visitExpr(s.c); visitBlock(s.then, s);
          if (s.else) visitBlock(s.else, { elseOf: s });
          break;
        case 'while': visitExpr(s.c); visitBlock(s.body, s); break;
        case 'for': visitExpr(s.iter); visitBlock(s.body, s); break;
        case 'expr': visitExpr(s.e); break;
        default: break;
      }
    }
  };
  visitBlock(stmts, null);
}

function nodeAt(ast, ord) {
  let found = null;
  walk(ast, (n, ctx) => { if (ctx.ord === ord) found = n; });
  return found;
}

function replaceNode(node, repl) {
  for (const k of Object.keys(node)) delete node[k];
  Object.assign(node, JSON.parse(JSON.stringify(repl)));
}

// A statement's own position: assignments store the position of their "=".
function stmtPos(s) {
  if (s.k === 'assign') return s.target.pos;
  if (s.k === 'expr') return s.e.pos;
  return s.pos;
}

const NOP = (pos) => ({ k: 'if', c: { k: 'bool', v: false, pos }, then: [], else: null, pos });

// ----------------------------------------------------------- text of code --

const PREC = { tern: 1, or: 2, and: 3, not: 4, cmp: 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, un: 8, '**': 9 };
function precOf(n) {
  if (n.k === 'tern' || n.k === 'or' || n.k === 'and' || n.k === 'not' || n.k === 'un') return PREC[n.k];
  if (n.k === 'bin') return REL_SWAP[n.op] ? PREC.cmp : PREC[n.op];
  return 10;
}
function num(v) { return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e9) / 1e9); }

export function showExpr(n) {
  const sub = (c, p) => (precOf(c) < p ? '(' + showExpr(c) + ')' : showExpr(c));
  switch (n.k) {
    case 'num': return num(n.v);
    case 'str': return "'" + n.v + "'";
    case 'bool': return String(n.v);
    case 'null': return 'null';
    case 'name': return n.name;
    case 'list': return '[' + n.items.map(showExpr).join(', ') + ']';
    case 'un': return n.op + sub(n.e, PREC.un + 1);
    case 'not': return 'not ' + sub(n.e, PREC.not + 1);
    case 'and': return sub(n.l, PREC.and) + ' and ' + sub(n.r, PREC.and + 1);
    case 'or': return sub(n.l, PREC.or) + ' or ' + sub(n.r, PREC.or + 1);
    case 'tern': return sub(n.c, PREC.tern + 1) + ' ? ' + showExpr(n.a) + ' : ' + showExpr(n.b);
    case 'bin': { const p = precOf(n); return sub(n.l, p) + ' ' + n.op + ' ' + sub(n.r, p + 1); }
    case 'index': return sub(n.obj, 10) + '[' + showExpr(n.idx) + ']';
    case 'call': return n.name + '(' + n.args.map(showExpr).join(', ') + ')';
    default: return n.k;
  }
}

function clip(s, max = 44) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function showStmt(s) {
  switch (s.k) {
    case 'let': return `let ${s.name} = ${showExpr(s.e)}`;
    case 'assign': return `${showExpr(s.target)} ${s.op} ${showExpr(s.e)}`;
    case 'if': return `if ${showExpr(s.c)} { … }`;
    case 'while': return `while ${showExpr(s.c)} { … }`;
    case 'for': return `for ${s.name} in ${showExpr(s.iter)} { … }`;
    case 'expr': return showExpr(s.e);
    default: return s.k;
  }
}

// ------------------------------------------------------------ enumerating --

function rulePrograms(model) {
  const R = model.spec.rules || {};
  const out = [];
  const add = (path, code, implicit) => {
    if (code == null) return;
    const src = codeText(code);
    out.push({ path, src, ast: parseProgram(src, path), implicit });
  };
  add('rules.init', R.init, ['t', 'dt', 'tick', 'pi']);
  add('rules.tick', R.tick, ['t', 'dt', 'tick', 'pi']);
  for (const [name, code] of Object.entries(R.on || {})) {
    if (model.rules.on.has(name)) add(`rules.on.${name}`, code, ['t', 'dt', 'tick', 'pi', 'seq', 'batch']);
  }
  return out;
}

// Every mutant of the model, in a fixed order, numbered M1, M2, ...
// Each one names its operator, its place in the spec and the change.
export function enumerateMutants(model) {
  const progs = rulePrograms(model);
  const out = [];
  for (const prog of progs) {
    walk(prog.ast, (n, ctx) => {
      const loc = withLineCol({ path: prog.path, src: prog.src, pos: ctx.stmt ? stmtPos(n) : n.pos });
      const at = `${prog.path}:${loc.line}:${loc.col}`;
      const add = (op, before, after, transform) => out.push({ op, path: prog.path, at, before: clip(before), after: clip(after), ord: ctx.ord, transform, prog });
      if (ctx.stmt) {
        const isEmit = n.k === 'expr' && n.e.k === 'call' && n.e.name === 'emit';
        const isRemove = n.k === 'expr' && n.e.k === 'call' && (n.e.name === 'remove' || n.e.name === 'removeAt');
        if (n.k === 'if') {
          add('negate-if', `if ${showExpr(n.c)}`, `if not (${showExpr(n.c)})`, (x) => { x.c = { k: 'not', e: x.c, pos: x.pos }; });
          if (n.else) add('drop-else', `if ${showExpr(n.c)} { … } else { … }`, `if ${showExpr(n.c)} { … }`, (x) => { x.else = null; });
        }
        if (n.k === 'assign' && ASSIGN_SWAP[n.op]) {
          const to = ASSIGN_SWAP[n.op];
          const opLoc = withLineCol({ path: prog.path, src: prog.src, pos: n.pos });
          out.push({ op: 'arithmetic', path: prog.path, at: `${prog.path}:${opLoc.line}:${opLoc.col}`, before: clip(showStmt(n)), after: clip(showStmt({ ...n, op: to })), ord: ctx.ord, transform: (x) => { x.op = to; }, prog });
        }
        // a lone if inside an else block is an "else if": deleting it is the same as dropping the else
        const elseIf = ctx.owner && ctx.owner.elseOf && ctx.block.length === 1 && n.k === 'if';
        if (isEmit) add('emit', showStmt(n), '(removed)', (x) => replaceNode(x, NOP(x.pos)));
        else if (isRemove) add('list-order', showStmt(n), '(removed)', (x) => replaceNode(x, NOP(x.pos)));
        else if (n.k !== 'let' && !elseIf) add('delete-statement', showStmt(n), '(deleted)', (x) => replaceNode(x, NOP(x.pos)));
        return;
      }
      switch (n.k) {
        case 'bin':
          if (REL_SWAP[n.op]) { const to = REL_SWAP[n.op]; add('relational', showExpr(n), showExpr({ ...n, op: to }), (x) => { x.op = to; }); }
          else if (ARITH_SWAP[n.op]) { const to = ARITH_SWAP[n.op]; add('arithmetic', showExpr(n), showExpr({ ...n, op: to }), (x) => { x.op = to; }); }
          break;
        case 'and': case 'or': {
          const to = n.k === 'and' ? 'or' : 'and';
          add('logical', showExpr(n), showExpr({ ...n, k: to }), (x) => { x.k = to; });
          break;
        }
        case 'num':
          for (const d of [1, -1]) {
            const v = n.v + d;
            add('constant', num(n.v), num(v), (x) => { x.v = v; });
          }
          break;
        case 'call': {
          if ((n.name === 'min' || n.name === 'max') && n.args.length >= 2) {
            const to = n.name === 'min' ? 'max' : 'min';
            add('bound', showExpr(n), showExpr({ ...n, name: to }), (x) => { x.name = to; });
            n.args.forEach((a, i) => add('bound', showExpr(n), showExpr(a), (x) => replaceNode(x, x.args[i])));
          } else if (n.name === 'clamp' && n.args.length === 3) {
            add('bound', showExpr(n), showExpr(n.args[0]), (x) => replaceNode(x, x.args[0]));
          } else if (LIST_SWAP[n.name]) {
            const to = LIST_SWAP[n.name];
            add('list-order', showExpr(n), showExpr({ ...n, name: to }), (x) => { x.name = to; });
          }
          break;
        }
        default: break;
      }
    });
  }
  // scheduled events: one tick later
  model.events.forEach((ev, i) => {
    if (ev.mode === 'rate') return;
    const raw = model.spec.events[ev.index];
    const field = ev.mode === 'at' ? 'at' : 'from';
    const was = raw[field] == null ? 0 : raw[field];
    out.push({
      op: 'event-time', path: `events[${ev.index}]`, at: `events[${ev.index}].${field}`,
      before: clip(`${ev.name} ${field} ${Array.isArray(was) ? '[' + was.join(', ') + ']' : was}`), after: 'one tick later', eventIndex: i,
    });
  });
  out.forEach((m, i) => {
    m.id = 'M' + (i + 1);
    m.change = `${m.before} → ${m.after}`;
    m.key = `${m.at} ${m.change}`;
  });
  return out;
}

// The mutated model: a shallow copy with one rule program recompiled from a
// changed syntax tree, or one event moved.
export function buildMutant(model, m) {
  if (m.op === 'event-time') {
    const dt = model.dt;
    const events = model.events.map((ev, i) => {
      if (i !== m.eventIndex) return ev;
      const e = { ...ev };
      if (e.mode === 'at') {
        if (e.atList) e.atList = e.atList.map((x) => x + dt);
        else { const f = ev.at; e.at = (env) => f(env) + dt; }
      } else {
        const f = ev.from;
        e.from = (env) => (f ? f(env) : 0) + dt;
      }
      return e;
    });
    return { ...model, events };
  }
  const prog = m.prog;
  const ast = JSON.parse(JSON.stringify(prog.ast));
  const node = nodeAt(ast, m.ord);
  m.transform(node);
  const fn = compileProgramAst(ast, prog.src, prog.path, {
    params: model.paramIds, state: new Set(model.stateNames), derived: model.derivedGetters,
    implicit: new Set(prog.implicit), emits: new Set(),
  });
  const rules = { init: model.rules.init, tick: model.rules.tick, on: new Map(model.rules.on) };
  if (prog.path === 'rules.init') rules.init = fn;
  else if (prog.path === 'rules.tick') rules.tick = fn;
  else rules.on.set(prog.path.slice('rules.on.'.length), fn);
  return { ...model, rules };
}

// ------------------------------------------------------------ fingerprints --

function fnv(h, s) {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

// Two hashes of one run. `claims` covers what claims can see: the state
// values in seen.state and the signals in seen.signals. `all` covers the
// whole state trace and every signal, which the page also draws.
export function fingerprint(trace, seen) {
  if (trace.error) return { error: trace.error, claims: 'error', all: 'error' };
  let hc = 0x811c9dc5;
  let ha = 0x811c9dc5;
  const names = seen ? trace.model.stateNames.filter((n) => seen.state.has(n)) : trace.model.stateNames;
  for (let k = 0; k <= trace.K; k++) {
    const s = trace.snaps[k];
    ha = fnv(ha, JSON.stringify(s) + '|');
    hc = fnv(hc, JSON.stringify(names.map((n) => s[n])) + '|');
    const em = trace.emits[k];
    if (em && em.length) {
      ha = fnv(ha, k + ':' + JSON.stringify(em.map((e) => [e.name, e.payload])) + '|');
      const watched = seen ? em.filter((e) => seen.signals.has(e.name)) : em;
      if (watched.length) hc = fnv(hc, k + ':' + JSON.stringify(watched.map((e) => [e.name, e.payload])) + '|');
    }
  }
  return { error: null, claims: hc.toString(16) + ':' + trace.K, all: ha.toString(16) + ':' + trace.K };
}

// ----------------------------------------------------- what claims can see --

const MUTATING = new Set(['push', 'unshift', 'insert', 'pop', 'shift', 'remove', 'removeAt']);

function namesIn(n, out) {
  if (!n) return out;
  if (n.k === 'name') out.add(n.name);
  for (const c of exprChildren(n)) namesIn(c, out);
  return out;
}
function rootName(n) {
  while (n && n.k === 'index') n = n.obj;
  return n && n.k === 'name' ? n.name : null;
}
function hasJump(block) {
  for (const s of block) {
    if (s.k === 'break' || s.k === 'continue') return true;
    if (s.k === 'if' && (hasJump(s.then) || (s.else && hasJump(s.else)))) return true;
  }
  return false;
}

// The state values and signals claims can depend on: every name a claim
// reads and, through the rules, every name those values are computed from or
// decided by (data and control dependence, to a fixed point). The rest is
// display state that only parts read. It over-approximates on purpose: a name
// in doubt counts as seen, so a change is never wrongly called visual only.
export function claimVisible(model, progs) {
  const derivedRefs = new Map(model.derived.map((d) => [d.name, d.fn.refs || new Set()]));
  const seen = new Set();
  const add = (names) => {
    for (const r of names) {
      if (seen.has(r)) continue;
      seen.add(r);
      if (derivedRefs.has(r)) add(derivedRefs.get(r));
    }
  };
  const signals = new Set();
  const claimRefs = (c) => {
    for (const k of ['expr', 'holdsWhen']) if (c[k] && c[k].refs) add(c[k].refs);
    if (c.measure && c.measure.of && c.measure.of.refs) add(c.measure.of.refs);
    if (c.inner) claimRefs(c.inner);
    if (c.kind === 'whenever') signals.add(c.event);
  };
  model.claims.forEach(claimRefs);
  const edges = []; // a name written, and the names it is computed from or decided by
  const exprEdges = (n, ctx) => {
    if (!n) return;
    if (n.k === 'call' && MUTATING.has(n.name) && n.args.length) {
      const w = rootName(n.args[0]);
      const reads = new Set(ctx);
      for (const a of n.args) namesIn(a, reads);
      if (w) edges.push({ writes: w, reads });
    }
    if (n.k === 'call' && n.name === 'emit' && n.args[0] && n.args[0].k === 'str' && signals.has(n.args[0].v)) {
      // when a watched signal fires, and its payload, are seen by a whenever claim
      edges.push({ writes: '__signal', reads: namesIn(n.args[1], new Set(ctx)) });
    }
    for (const c of exprChildren(n)) exprEdges(c, ctx);
  };
  const block = (stmts, ctx) => {
    for (const s of stmts) {
      switch (s.k) {
        case 'let': edges.push({ writes: s.name, reads: namesIn(s.e, new Set(ctx)) }); exprEdges(s.e, ctx); break;
        case 'assign': {
          const w = rootName(s.target);
          const reads = namesIn(s.e, new Set(ctx));
          if (s.target.k === 'index') namesIn(s.target, reads);
          if (w) edges.push({ writes: w, reads });
          exprEdges(s.e, ctx);
          break;
        }
        case 'if': {
          exprEdges(s.c, ctx);
          const c2 = namesIn(s.c, new Set(ctx));
          block(s.then, c2);
          if (s.else) block(s.else, c2);
          break;
        }
        case 'while': case 'for': {
          const head = s.k === 'while' ? s.c : s.iter;
          exprEdges(head, ctx);
          const c2 = namesIn(head, new Set(ctx));
          // with a break or continue, every condition in the loop decides the whole body
          if (hasJump(s.body)) walk(s.body, (n, cx) => { if (cx.stmt && (n.k === 'if' || n.k === 'while')) namesIn(n.c, c2); });
          if (s.k === 'for') edges.push({ writes: s.name, reads: new Set(c2) });
          block(s.body, c2);
          break;
        }
        case 'expr': exprEdges(s.e, ctx); break;
        default: break;
      }
    }
  };
  for (const prog of progs) block(prog.ast, new Set());
  if (signals.size) seen.add('__signal');
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      if (!seen.has(e.writes)) continue;
      const before = seen.size;
      add(e.reads);
      if (seen.size !== before) changed = true;
    }
  }
  return { state: new Set(model.stateNames.filter((n) => seen.has(n))), signals };
}

// Every param set the claims look at: the current one, every sweep sample,
// and both sides of every compare.
export function paramSets(model, P) {
  const sets = [];
  const seen = new Set();
  const add = (o) => {
    const key = JSON.stringify(model.params.map((p) => o[p.id]));
    if (seen.has(key)) return;
    seen.add(key);
    sets.push(o);
  };
  add({ ...P });
  for (const c of model.claims) {
    if (c.kind === 'sweep') for (const s of sweepSamples(model, c, { ...P })) add(s);
    if (c.kind === 'compare') {
      for (const side of ['a', 'b']) {
        const o = { ...P };
        const env = { S: Object.create(null), P, L: [], t: 0, dt: model.dt, tick: 0, seq: 0, batch: 0, payload: null, rng: () => 0, steps: 0, maxSteps: 1e6, kinds: null, emit: null, cmp: null };
        try { for (const r of c.runs[side]) o[r.id] = r.fn(env); } catch { continue; }
        add(o);
      }
    }
  }
  return sets;
}

// ------------------------------------------------------------------ run --

function errInfo(e) {
  if (!e) return null;
  return { code: e.code, message: e.message, path: e.loc ? e.loc.path : null };
}

function pick(list, cap, seed) {
  if (list.length <= cap) return { chosen: list, sampled: false };
  const rng = makeRng(`mutate:${hashSeed(seed)}`);
  const idx = list.map((_, i) => i);
  for (let i = 0; i < cap; i++) {
    const j = i + Math.floor(rng() * (idx.length - i));
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  const keep = idx.slice(0, cap).sort((a, b) => a - b);
  return { chosen: keep.map((i) => list[i]), sampled: true };
}

function hintFor(c) {
  if (c.kind === 'whenever') return 'this claim may restate a rule, its event may fire too rarely, or the scenario never exercises it; see references/claims.md';
  if (c.kind === 'sweep' && !c.holdsWhen) return 'this sweep may restate a rule; a holdsWhen boundary or a stronger inner claim tests more; see references/claims.md';
  return 'this claim may restate a rule, or the scenario never exercises it; see references/claims.md';
}

// Mutation-test the claims of a compiled model.
// opts: params (overrides), cap (max mutants, default 200), seed (sampling),
//       ignore (list of { mutant, reason }, default spec.mutate.ignore).
export function mutateClaims(model, opts = {}) {
  const t0 = Date.now();
  const P = resolveParams(model, opts.params);
  // what one check of the original costs, so a mutant that loops forever stops early
  const probe = makeBudget();
  const base = checkClaims(model, P, { budget: probe });
  if (base.trace.error || base.passed !== base.total) {
    return { ok: false, error: 'every claim must pass first', passed: base.passed, total: base.total };
  }
  const used = probe.total - probe.left;
  const mutantSteps = Math.min(LIMITS.checkSteps, Math.max(4 * used, 4000000));

  const all = enumerateMutants(model);
  const cap = opts.cap > 0 ? Math.floor(opts.cap) : MUTATE_DEFAULT_CAP;
  const seed = opts.seed != null ? opts.seed : model.seed;
  const { chosen, sampled } = pick(all, cap, seed);

  const ignoreList = opts.ignore || (model.spec.mutate && model.spec.mutate.ignore) || [];
  const ignoreUsed = new Set();

  const sets = paramSets(model, P);
  const seen = claimVisible(model, rulePrograms(model));
  const original = new Map();
  const originalPrint = (i) => {
    if (!original.has(i)) original.set(i, fingerprint(simulate(model, sets[i], { budget: makeBudget() }), seen));
    return original.get(i);
  };

  const claimIds = model.claims.map((c) => c.id);
  const kills = new Map(claimIds.map((id) => [id, []]));
  const mutants = [];
  const chosenSet = new Set(chosen);
  for (const m of all.filter((x) => chosenSet.has(x))) {
    const rec = { id: m.id, op: m.op, at: m.at, path: m.path, change: m.change, key: m.key, status: 'survived', killedBy: [] };
    mutants.push(rec);
    let mm;
    try { mm = buildMutant(model, m); } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      rec.status = 'engine'; rec.engine = 'compile'; rec.error = errInfo(e);
      continue;
    }
    const budget = makeBudget(mutantSteps);
    const res = checkClaims(mm, P, { budget });
    if (res.trace.error) {
      rec.status = 'engine'; rec.engine = 'runtime'; rec.error = errInfo(res.trace.error);
      continue;
    }
    let firstError = null;
    for (const r of res.results) {
      const isErr = r.status === 'error' || (r.counterexample && r.counterexample.note === 'error');
      if (isErr) { if (!firstError) firstError = r.error || (r.counterexample && r.counterexample.error) || null; continue; }
      if (!r.pass) rec.killedBy.push(r.id);
    }
    if (rec.killedBy.length) {
      rec.status = 'killed';
      for (const id of rec.killedBy) kills.get(id).push(rec);
      continue;
    }
    if (firstError) {
      rec.status = 'engine'; rec.engine = 'runtime';
      rec.error = firstError.code ? { code: firstError.code, message: firstError.message, path: firstError.path || null } : errInfo(firstError);
      continue;
    }
    // no claim noticed: could any claim see the change at all?
    let claimDiff = false;
    let shownDiff = false;
    let runError = null;
    for (let i = 0; i < sets.length && !claimDiff; i++) {
      const fp = i === 0 ? fingerprint(res.trace, seen) : fingerprint(simulate(mm, sets[i], { budget: makeBudget(mutantSteps) }), seen);
      const op = originalPrint(i);
      if (fp.error) { runError = fp.error; break; }
      if (fp.claims !== op.claims) claimDiff = true;
      else if (fp.all !== op.all) shownDiff = true;
    }
    if (runError) { rec.status = 'engine'; rec.engine = 'runtime'; rec.error = errInfo(runError); continue; }
    if (!claimDiff) { rec.status = shownDiff ? 'visual' : 'equivalent'; continue; }
    const ig = ignoreList.find((x) => x && x.mutant === m.key);
    if (ig) { rec.status = 'ignored'; rec.reason = ig.reason || ''; ignoreUsed.add(ig.mutant); }
  }

  const count = (s) => mutants.filter((x) => x.status === s).length;
  const killed = count('killed');
  const engine = count('engine');
  const survived = count('survived');
  const scored = killed + engine + survived;
  const claims = model.claims.map((c) => {
    const ks = kills.get(c.id);
    // the example is the mutant fewest other claims catch: what this claim adds
    let ex = null;
    for (const x of ks) if (!ex || x.killedBy.length < ex.killedBy.length) ex = x;
    return { id: c.id, kind: c.kind, kills: ks.length, unique: ks.filter((x) => x.killedBy.length === 1).length, example: ex ? { id: ex.id, at: ex.at, change: ex.change } : null };
  });
  const neverFailed = claims.filter((c) => c.kills === 0).map((c) => ({ id: c.id, hint: hintFor(model.claims.find((q) => q.id === c.id)) }));
  const warnings = ignoreList.filter((x) => x && !ignoreUsed.has(x.mutant)).map((x) => ({
    code: 'W_MUTATE_IGNORE_UNUSED', severity: 'warning', path: 'mutate.ignore',
    message: `"${x.mutant}" matches no surviving mutant (it is killed now, the rule changed, or it was not sampled); remove it`,
  }));
  return {
    ok: true,
    total: all.length, tested: mutants.length, sampled, cap, seed: sampled ? seed : null,
    killed, engine, equivalent: count('equivalent'), visual: count('visual'), ignored: count('ignored'), survived,
    scored, score: scored ? (killed + engine) / scored : 1,
    paramSets: sets.length,
    claims, neverFailed, mutants, warnings,
    ms: Date.now() - t0,
  };
}

// Whole percent, rounded down, so 99.6% never shows as 100%.
export function scorePercent(rep) {
  return Math.floor(rep.score * 100 + 1e-9);
}
