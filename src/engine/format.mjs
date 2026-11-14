// Number formatting and text templates shared by the CLI and the page.
// A template is plain text with {expr} or {expr:format} holes:
//   "{capacity} tokens"          -> "10 tokens"
//   "{capacity + 1:ord} request" -> "11th request"
//   "{share:%}" / "{share:.1%}"  -> "42%" / "41.7%"
//   "{balance:,.2}"              -> "12,345.68"
//   "{{" and "}}"                -> literal braces

import { ModelError } from './errors.mjs';
import { compileExpressionSource, kindOf, showValue } from './compile.mjs';

const FORMAT_RE = /^(,)?(?:\.(\d))?(%|ord|int)?$/;

export function formatNumber(x, fmt) {
  if (typeof x !== 'number') return showValue(x);
  if (!Number.isFinite(x)) return String(x);
  const spec = fmt ? FORMAT_RE.exec(fmt) : null;
  const group = spec ? !!spec[1] : Math.abs(x) >= 10000;
  const digits = spec && spec[2] != null ? Number(spec[2]) : null;
  const kind = spec ? spec[3] : null;
  if (kind === 'ord') return ordinal(Math.round(x));
  if (kind === 'int') return groupDigits(String(Math.round(x)), group);
  if (kind === '%') {
    const v = x * 100;
    return groupDigits(v.toFixed(digits == null ? 0 : digits), group) + '%';
  }
  if (digits != null) return groupDigits(fixZero(x.toFixed(digits)), group);
  return groupDigits(autoNumber(x), group);
}

function fixZero(s) { return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s; }

export function autoNumber(x) {
  if (Number.isInteger(x)) return String(x);
  const a = Math.abs(x);
  let s;
  if (a >= 1000) s = x.toFixed(0);
  else if (a >= 1) s = x.toFixed(2);
  else if (a >= 0.001) s = x.toPrecision(2);
  else if (a === 0) s = '0';
  else s = x.toExponential(1);
  if (s.includes('.') && !s.includes('e')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return fixZero(s);
}

function groupDigits(s, group) {
  if (!group) return s;
  const m = /^(-?)(\d+)(.*)$/.exec(s);
  if (!m) return s;
  return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + m[3];
}

// "1 requests" reads wrong; drop the plural s for exactly one.
export function unitFor(value, unit) {
  if (!unit) return '';
  if (value === 1 && /[a-z]s$/.test(unit) && !/ss$/.test(unit) && !/ per /.test(unit)) return unit.slice(0, -1);
  return unit;
}

export function ordinal(n) {
  const a = Math.abs(n) % 100;
  if (a >= 11 && a <= 13) return n + 'th';
  switch (Math.abs(n) % 10) {
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

export function formatValue(v, fmt) {
  const k = kindOf(v);
  if (k === 'number') return formatNumber(v, fmt);
  if (k === 'string') return v;
  if (k === 'boolean') return v ? 'yes' : 'no';
  if (k === 'null') return '–';
  return showValue(v);
}

// Split a template into literal text and {expression} holes.
// Returns [{ lit }, { expr, fmt, pos }] where pos is the offset of expr.
export function parseTemplate(text, path) {
  const parts = [];
  let lit = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '{' && text[i + 1] === '{') { lit += '{'; i += 2; continue; }
    if (c === '}' && text[i + 1] === '}') { lit += '}'; i += 2; continue; }
    if (c === '}') throw new ModelError('E_TEMPLATE', 'a "}" without a matching "{" (write "}}" for a literal brace)', { path, src: text, pos: i });
    if (c !== '{') { lit += c; i++; continue; }
    // find the matching close brace, skipping strings and nested brackets
    let j = i + 1;
    let depth = 0;
    let quote = null;
    for (; j < n; j++) {
      const d = text[j];
      if (quote) { if (d === '\\') j++; else if (d === quote) quote = null; continue; }
      if (d === '"' || d === "'") { quote = d; continue; }
      if (d === '(' || d === '[' || d === '{') depth++;
      else if (d === ')' || d === ']') depth--;
      else if (d === '}') { if (depth === 0) break; depth--; }
    }
    if (j >= n) throw new ModelError('E_TEMPLATE', 'a "{" is never closed', { path, src: text, pos: i });
    const inner = text.slice(i + 1, j);
    // a trailing :format only counts when it is a known format
    let expr = inner;
    let fmt = null;
    const k = inner.lastIndexOf(':');
    if (k >= 0) {
      const cand = inner.slice(k + 1).trim();
      if (FORMAT_RE.test(cand) && cand.length > 0) { expr = inner.slice(0, k); fmt = cand; }
    }
    if (!expr.trim()) throw new ModelError('E_TEMPLATE', 'an empty {} in the text', { path, src: text, pos: i });
    if (lit) { parts.push({ lit }); lit = ''; }
    parts.push({ expr, fmt, pos: i + 1 });
    i = j + 1;
  }
  if (lit) parts.push({ lit });
  return parts;
}

// Compile a template into a function env -> string. Errors point into the
// template text itself.
export function compileTemplate(text, path, base) {
  const parts = parseTemplate(text, path);
  const refs = new Set();
  const fns = parts.map((p) => {
    if (p.lit != null) { const s = p.lit; return () => s; }
    let f;
    try {
      f = compileExpressionSource(p.expr, path, base);
    } catch (e) {
      if (e instanceof ModelError && e.loc) {
        // re-point the error at the template text
        const off = e.loc.pos != null ? e.loc.pos : 0;
        throw new ModelError(e.code, e.message, { path, src: text, pos: p.pos + off }, { hint: e.hint });
      }
      throw e;
    }
    for (const r of f.refs) refs.add(r);
    p.refs = f.refs; // per hole, for lint
    const fmt = p.fmt;
    return (env) => formatValue(f(env), fmt);
  });
  const fn = (env) => {
    let s = '';
    for (const f of fns) s += f(env);
    return s;
  };
  fn.refs = refs;
  fn.parts = parts;
  return fn;
}

// Text outside the {holes}, for lint.
export function literalText(text) {
  try {
    return parseTemplate(text, '').filter((p) => p.lit != null).map((p) => p.lit).join(' ');
  } catch {
    return text;
  }
}
