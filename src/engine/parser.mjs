// Pratt parser for the rule language.
//
// Expressions (lowest to highest binding):
//   c ? a : b            ternary, right associative
//   or  ||
//   and &&
//   not !                prefix; binds looser than comparisons: not a == b  means  not (a == b)
//   == != < <= > >=      comparisons cannot be chained (a < b < c is an error)
//   + -
//   * / %
//   -x +x                unary minus and plus
//   **                   power, right associative; -2 ** 2 == -4
//   f(x)  a[i]           calls and indexing
//
// Statements: let, assignment (= += -= *= /= %= **=), if / else if / else,
// while, for x in list, break, continue, and bare calls such as emit('x').

import { tokenize } from './lexer.mjs';
import { ModelError } from './errors.mjs';

const KEYWORDS = new Set(['if', 'else', 'while', 'for', 'in', 'let', 'break', 'continue', 'and', 'or', 'not', 'true', 'false', 'null']);
const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=']);
const MAX_DEPTH = 100;

const BP = {
  '?': 2, 'or': 4, '||': 4, 'and': 6, '&&': 6,
  '==': 10, '!=': 10, '<': 10, '<=': 10, '>': 10, '>=': 10,
  '+': 20, '-': 20, '*': 30, '/': 30, '%': 30, '**': 50, '(': 60, '[': 60,
};

export function isKeyword(name) { return KEYWORDS.has(name); }

class Parser {
  constructor(src, path) {
    this.src = src;
    this.path = path;
    this.toks = tokenize(src, path);
    this.i = 0;
    this.depth = 0;
  }
  err(code, msg, pos) {
    return new ModelError(code, msg, { path: this.path, src: this.src, pos: pos == null ? this.peek().pos : pos });
  }
  peek(o = 0) { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  next() { return this.toks[this.i++]; }
  isOp(v, o = 0) { const t = this.peek(o); return t.type === 'op' && t.value === v; }
  isWord(v, o = 0) { const t = this.peek(o); return t.type === 'ident' && t.value === v; }
  expectOp(v, what) {
    const t = this.peek();
    if (t.type === 'op' && t.value === v) return this.next();
    throw this.err('E_SYNTAX', `expected "${v}"${what ? ' ' + what : ''} but found ${describe(t)}`, t.pos);
  }
  skipNewlines() { while (this.peek().type === 'nl') this.i++; }
  skipSeparators() { while (this.peek().type === 'nl' || this.isOp(';')) this.i++; }

  // ---- expressions -------------------------------------------------------
  expr(rbp = 0) {
    if (++this.depth > MAX_DEPTH) throw this.err('E_TOO_DEEP', `expression is nested more than ${MAX_DEPTH} levels deep`);
    let left = this.prefix();
    while (true) {
      const t = this.peek();
      const key = t.type === 'op' ? t.value : (t.type === 'ident' && (t.value === 'and' || t.value === 'or') ? t.value : null);
      if (key == null || BP[key] == null) break;
      const lbp = BP[key];
      if (lbp <= rbp) break;
      left = this.infix(left, key, lbp);
    }
    this.depth--;
    return left;
  }

  prefix() {
    const t = this.next();
    if (t.type === 'num') return { k: 'num', v: t.value, pos: t.pos };
    if (t.type === 'str') return { k: 'str', v: t.value, pos: t.pos };
    if (t.type === 'ident') {
      if (t.value === 'true' || t.value === 'false') return { k: 'bool', v: t.value === 'true', pos: t.pos };
      if (t.value === 'null') return { k: 'null', pos: t.pos };
      if (t.value === 'not') return { k: 'not', e: this.expr(8), pos: t.pos };
      if (KEYWORDS.has(t.value)) throw this.err('E_SYNTAX', `"${t.value}" cannot be used inside an expression`, t.pos);
      return { k: 'name', name: t.value, pos: t.pos };
    }
    if (t.type === 'op') {
      if (t.value === '(') {
        const e = this.expr(0);
        this.expectOp(')', 'to close "("');
        return e;
      }
      if (t.value === '[') {
        const items = [];
        if (!this.isOp(']')) {
          while (true) {
            items.push(this.expr(0));
            if (this.isOp(',')) { this.next(); if (this.isOp(']')) break; continue; }
            break;
          }
        }
        this.expectOp(']', 'to close the list');
        return { k: 'list', items, pos: t.pos };
      }
      if (t.value === '-' || t.value === '+') return { k: 'un', op: t.value, e: this.expr(40), pos: t.pos };
      if (t.value === '!') return { k: 'not', e: this.expr(8), pos: t.pos };
    }
    throw this.err('E_SYNTAX', `expected a value but found ${describe(t)}`, t.pos);
  }

  infix(left, key, lbp) {
    const t = this.next();
    if (key === '(') {
      if (left.k !== 'name') throw this.err('E_SYNTAX', 'only named functions can be called', t.pos);
      const args = [];
      if (!this.isOp(')')) {
        while (true) {
          args.push(this.expr(0));
          if (this.isOp(',')) { this.next(); continue; }
          break;
        }
      }
      this.expectOp(')', 'to close the call');
      return { k: 'call', name: left.name, args, pos: left.pos };
    }
    if (key === '[') {
      const idx = this.expr(0);
      this.expectOp(']', 'to close the index');
      return { k: 'index', obj: left, idx, pos: t.pos };
    }
    if (key === '?') {
      this.skipNewlines();
      const a = this.expr(0);
      this.skipNewlines();
      this.expectOp(':', 'in the ternary "c ? a : b"');
      this.skipNewlines();
      const b = this.expr(lbp - 1);
      return { k: 'tern', c: left, a, b, pos: t.pos };
    }
    this.skipNewlines();
    if (key === 'and' || key === '&&') return { k: 'and', l: left, r: this.expr(lbp), pos: t.pos };
    if (key === 'or' || key === '||') return { k: 'or', l: left, r: this.expr(lbp), pos: t.pos };
    if (key === '**') return { k: 'bin', op: '**', l: left, r: this.expr(lbp - 1), pos: t.pos };
    const right = this.expr(lbp);
    const node = { k: 'bin', op: key, l: left, r: right, pos: t.pos };
    if (COMPARE.has(key)) {
      const nt = this.peek();
      if (nt.type === 'op' && COMPARE.has(nt.value)) {
        throw this.err('E_CHAINED_COMPARISON', 'comparisons cannot be chained; write "a < b and b < c"', nt.pos);
      }
    }
    return node;
  }

  // ---- statements --------------------------------------------------------
  program() {
    const body = this.statements(null);
    if (this.peek().type !== 'eof') throw this.err('E_SYNTAX', `unexpected ${describe(this.peek())}`);
    return body;
  }

  statements(closer) {
    const out = [];
    while (true) {
      this.skipSeparators();
      const t = this.peek();
      if (t.type === 'eof') {
        if (closer) throw this.err('E_SYNTAX', 'this block is never closed with "}"', closer.pos);
        break;
      }
      if (closer && this.isOp('}')) break;
      out.push(this.statement());
      const e = this.peek();
      if (!(e.type === 'nl' || e.type === 'eof' || (e.type === 'op' && (e.value === ';' || e.value === '}')))) {
        throw this.err('E_SYNTAX', `expected the end of the statement but found ${describe(e)}`, e.pos);
      }
    }
    return out;
  }

  block() {
    const open = this.expectOp('{', 'to start a block');
    const body = this.statements(open);
    this.expectOp('}', 'to close the block');
    return body;
  }

  statement() {
    if (++this.depth > MAX_DEPTH) throw this.err('E_TOO_DEEP', `blocks are nested more than ${MAX_DEPTH} levels deep`);
    const s = this.statementInner();
    this.depth--;
    return s;
  }

  statementInner() {
    const t = this.peek();
    if (t.type === 'ident') {
      switch (t.value) {
        case 'let': {
          this.next();
          const name = this.next();
          if (name.type !== 'ident' || KEYWORDS.has(name.value)) throw this.err('E_SYNTAX', 'expected a name after "let"', name.pos);
          this.expectOp('=', 'after the name in "let"');
          this.skipNewlines();
          return { k: 'let', name: name.value, e: this.expr(0), pos: t.pos, namePos: name.pos };
        }
        case 'if': return this.ifStatement();
        case 'while': {
          this.next();
          const c = this.expr(0);
          return { k: 'while', c, body: this.block(), pos: t.pos };
        }
        case 'for': {
          this.next();
          const name = this.next();
          if (name.type !== 'ident' || KEYWORDS.has(name.value)) throw this.err('E_SYNTAX', 'expected a loop variable after "for"', name.pos);
          if (!this.isWord('in')) throw this.err('E_SYNTAX', 'expected "in" after the loop variable');
          this.next();
          const iter = this.expr(0);
          return { k: 'for', name: name.value, iter, body: this.block(), pos: t.pos, namePos: name.pos };
        }
        case 'break': this.next(); return { k: 'break', pos: t.pos };
        case 'continue': this.next(); return { k: 'continue', pos: t.pos };
        case 'else': throw this.err('E_SYNTAX', '"else" without a matching "if"', t.pos);
        default: break;
      }
    }
    const e = this.expr(0);
    const a = this.peek();
    if (a.type === 'op' && ASSIGN.has(a.value)) {
      if (e.k !== 'name' && e.k !== 'index') throw this.err('E_SYNTAX', 'only a name or a list element can be assigned to', a.pos);
      this.next();
      this.skipNewlines();
      return { k: 'assign', target: e, op: a.value, e: this.expr(0), pos: a.pos };
    }
    if (e.k !== 'call') {
      throw this.err('E_USELESS_EXPRESSION', 'this line computes a value but does nothing with it; assign it or call a function', e.pos);
    }
    return { k: 'expr', e, pos: e.pos };
  }

  ifStatement() {
    const t = this.next(); // 'if'
    const c = this.expr(0);
    const then = this.block();
    let els = null;
    // allow "}\n else {" by looking past newlines
    let j = 0;
    while (this.peek(j).type === 'nl') j++;
    if (this.isWord('else', j)) {
      this.i += j + 1;
      if (this.isWord('if')) els = [this.ifStatement()];
      else els = this.block();
    }
    return { k: 'if', c, then, else: els, pos: t.pos };
  }
}

function describe(t) {
  if (t.type === 'eof') return 'the end of the code';
  if (t.type === 'nl') return 'a line break';
  if (t.type === 'str') return `the string "${t.value}"`;
  return `"${t.value}"`;
}

export function parseProgram(src, path) {
  return new Parser(src, path).program();
}

export function parseExpression(src, path) {
  const p = new Parser(src, path);
  p.skipNewlines();
  const e = p.expr(0);
  p.skipNewlines();
  const t = p.peek();
  if (t.type !== 'eof') {
    if (t.type === 'op' && ASSIGN.has(t.value)) {
      throw p.err('E_ASSIGN_IN_EXPRESSION', 'this is an expression, so it cannot assign; use "==" to compare', t.pos);
    }
    throw p.err('E_SYNTAX', `unexpected ${describe(t)} after the expression`, t.pos);
  }
  return e;
}
