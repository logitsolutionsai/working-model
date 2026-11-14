// Tokenizer for the rule language.
// Token: { type: 'num'|'str'|'ident'|'op'|'nl'|'eof', value, pos }
// Newlines are significant (they end statements) except inside ( ) and [ ].

import { ModelError } from './errors.mjs';

const OPS3 = ['**='];
const OPS2 = ['**', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&&', '||'];
const OPS1 = '+-*/%<>=()[]{},;?:!';

export const MAX_SOURCE_LENGTH = 20000;

export function tokenize(src, path) {
  if (typeof src !== 'string') {
    throw new ModelError('E_SYNTAX', 'expected a string of rule code', { path });
  }
  if (src.length > MAX_SOURCE_LENGTH) {
    throw new ModelError('E_TOO_LONG', `rule code is longer than ${MAX_SOURCE_LENGTH} characters`, { path, src, pos: 0 });
  }
  const toks = [];
  let i = 0;
  let depth = 0; // ( and [ nesting: newlines inside are ignored
  const n = src.length;
  const err = (code, msg, pos) => new ModelError(code, msg, { path, src, pos });

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\n') {
      if (depth === 0) toks.push({ type: 'nl', value: '\n', pos: i });
      i++;
      continue;
    }
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const start = i;
      while (i < n && isDigit(src[i])) i++;
      if (src[i] === '.' && isDigit(src[i + 1])) {
        i++;
        while (i < n && isDigit(src[i])) i++;
      } else if (src[i] === '.' && !isIdentStart(src[i + 1])) {
        i++; // "1." is allowed
      }
      if (src[i] === 'e' || src[i] === 'E') {
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (isDigit(src[j])) {
          i = j;
          while (i < n && isDigit(src[i])) i++;
        }
      }
      if (isIdentStart(src[i])) throw err('E_SYNTAX', `unexpected "${src[i]}" after a number`, i);
      toks.push({ type: 'num', value: Number(src.slice(start, i)), pos: start });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentPart(src[i])) i++;
      toks.push({ type: 'ident', value: src.slice(start, i), pos: start });
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      let out = '';
      while (true) {
        if (i >= n || src[i] === '\n') throw err('E_UNTERMINATED_STRING', 'this string is never closed', start);
        const d = src[i];
        if (d === quote) { i++; break; }
        if (d === '\\') {
          const e = src[i + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === '\\' || e === '"' || e === "'") out += e;
          else throw err('E_SYNTAX', `unknown escape "\\${e}"`, i);
          i += 2;
          continue;
        }
        out += d;
        i++;
      }
      toks.push({ type: 'str', value: out, pos: start });
      continue;
    }
    if (c === '.') throw err('E_SYNTAX', 'member access with "." is not part of the rule language', i);
    let op = null;
    for (const o of OPS3) if (src.startsWith(o, i)) { op = o; break; }
    if (!op) for (const o of OPS2) if (src.startsWith(o, i)) { op = o; break; }
    if (!op && OPS1.includes(c)) op = c;
    if (!op) throw err('E_SYNTAX', `unexpected character "${c}"`, i);
    if (op === '(' || op === '[') depth++;
    if ((op === ')' || op === ']') && depth > 0) depth--;
    toks.push({ type: 'op', value: op, pos: i });
    i += op.length;
  }
  toks.push({ type: 'eof', value: null, pos: n });
  return toks;
}

function isDigit(c) { return c >= '0' && c <= '9'; }
function isIdentStart(c) { return c != null && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'); }
function isIdentPart(c) { return isIdentStart(c) || isDigit(c); }
