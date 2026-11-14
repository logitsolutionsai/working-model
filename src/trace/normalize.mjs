// Trace import: generic JSONL into the normalized trace format.
//
// One JSON object per line:
//   { "timeMs": 120, "kind": "call_failed", "subject": "req-7", "attrs": { "route": "/pay" }, "id": "a1" }
// "timeMs" is relative milliseconds. An absolute "ts" (ISO 8601 with Z or an
// offset) is accepted only when the caller declares an origin, because the
// meaning of a timestamp is never changed silently.
//
// The result is sorted by time, then by record order, and every event gets a
// stable id (its own, or ev-00001 by record order). Attributes are kept only
// when allowlisted; everything else is dropped and counted.
// Pure module: no Node or browser APIs (digests are added by the caller).

import { TraceError } from './errors.mjs';

export const TRACE_LIMITS = {
  defaultBytes: 5 * 1024 * 1024,
  hardBytes: 100 * 1024 * 1024,
  defaultEvents: 50000,
  hardEvents: 500000,
  kindLength: 64,
  subjectLength: 256,
  stringLength: 256,
  attrsPerEvent: 32,
};

export const COMPLETENESS = ['unknown', 'declared-complete', 'known-incomplete'];

const KIND_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const TOP_KEYS = new Set(['timeMs', 'ts', 'kind', 'subject', 'attrs', 'id']);

function hasControl(s) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
}

export function resolveLimits(opts = {}) {
  const pick = (v, dflt, hard, name, flag) => {
    if (v == null) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new TraceError('E_USAGE', `${name} must be a positive whole number, got ${v}`, flag, `pass ${flag} <n>`);
    if (n > hard) throw new TraceError('E_TRACE_LIMIT', `${name} ${n} is above the hard limit of ${hard}`, flag, `use at most ${hard}`);
    return n;
  };
  return {
    maxBytes: pick(opts.maxBytes, TRACE_LIMITS.defaultBytes, TRACE_LIMITS.hardBytes, 'the byte limit', '--max-bytes'),
    maxEvents: pick(opts.maxEvents, TRACE_LIMITS.defaultEvents, TRACE_LIMITS.hardEvents, 'the event limit', '--max-events'),
  };
}

// Parse an absolute ISO 8601 time to Unix milliseconds, or null.
export function parseIsoMs(s) {
  if (typeof s !== 'string' || s.length > 40) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return null;
  const frac = m[7] ? Number('0' + m[7]) * 1000 : 0;
  let ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) + frac;
  if (m[8] !== 'Z') {
    const sign = m[8][0] === '-' ? -1 : 1;
    ms -= sign * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(4, 6))) * 60000;
  }
  return Number.isFinite(ms) ? ms : null;
}

function cleanAttrs(raw, allow, where, stats) {
  const out = {};
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TraceError('E_TRACE_ATTRS', '"attrs" must be an object of numbers, strings, true/false or null', where, 'write attrs as a flat object');
  }
  const keys = Object.keys(raw);
  if (keys.length > TRACE_LIMITS.attrsPerEvent) throw new TraceError('E_TRACE_ATTRS', `an event has more than ${TRACE_LIMITS.attrsPerEvent} attributes`, where, 'keep only the attributes the mapping needs');
  for (const k of keys) {
    const v = raw[k];
    if (v !== null && typeof v === 'object') {
      throw new TraceError('E_TRACE_NESTED', `attribute "${k}" is nested; only numbers, strings, true/false and null are supported`, where, 'flatten it into its own key, such as "http.status"');
    }
    if (typeof v === 'number' && !Number.isFinite(v)) throw new TraceError('E_TRACE_NONFINITE', `attribute "${k}" is not a finite number`, where, 'write a finite number or a string');
    if (!KEY_RE.test(k) || !allow.has(k)) { stats.droppedAttrs++; stats.droppedKeys.add(KEY_RE.test(k) ? k : '(invalid key)'); continue; }
    if (typeof v === 'string') {
      if (v.length > TRACE_LIMITS.stringLength || hasControl(v)) throw new TraceError('E_TRACE_ATTRS', `attribute "${k}" is longer than ${TRACE_LIMITS.stringLength} characters or holds control characters`, where, 'shorten it');
    }
    out[k] = v;
  }
  return out;
}

// text: the whole JSONL file as a string.
// opts: { allowAttrs: Iterable<string>, origin: null | 'first-event' | <ISO string>,
//         strict: bool, knownKinds: Set|null, complete: bool, maxEvents, maxBytes, bytes }
export function normalizeJsonl(text, opts = {}) {
  const limits = resolveLimits(opts);
  const bytes = opts.bytes != null ? opts.bytes : text.length;
  if (bytes > limits.maxBytes) {
    throw new TraceError('E_TRACE_TOO_LARGE', `the trace is ${bytes} bytes, above the limit of ${limits.maxBytes}`, null,
      `import a smaller window, or pass --max-bytes up to ${TRACE_LIMITS.hardBytes}`);
  }
  const allow = new Set(opts.allowAttrs || []);
  const stats = { droppedAttrs: 0, droppedKeys: new Set(), droppedFields: 0, blank: 0 };
  const warnings = [];
  const records = [];
  const lines = text.replace(/^﻿/, '').split('\n');
  let truncated = false;
  let absolute = 0;
  let relative = 0;
  let lastTime = -Infinity;
  let nonMonotonic = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) { stats.blank++; continue; }
    const where = `line ${i + 1}`;
    if (records.length >= limits.maxEvents) { truncated = true; break; }
    let rec;
    try { rec = JSON.parse(line); } catch (e) {
      throw new TraceError('E_TRACE_JSON', `not valid JSON: ${String(e.message).replace(/^.*?:\s*/, '')}`, where, 'write one JSON object per line');
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) throw new TraceError('E_TRACE_RECORD', 'each line must be a JSON object', where, 'write { "timeMs": 0, "kind": "request" }');
    for (const k of Object.keys(rec)) if (!TOP_KEYS.has(k)) stats.droppedFields++;
    let timeMs;
    if (rec.timeMs != null) {
      if (typeof rec.timeMs !== 'number' || !Number.isFinite(rec.timeMs)) throw new TraceError('E_TRACE_NONFINITE', '"timeMs" must be a finite number', where, 'write relative milliseconds, such as 120');
      if (rec.ts != null) throw new TraceError('E_TRACE_TIME', 'a record has both "timeMs" and "ts"', where, 'keep one of them');
      timeMs = rec.timeMs;
      relative++;
    } else if (rec.ts != null) {
      const ms = parseIsoMs(rec.ts);
      if (ms == null) throw new TraceError('E_TRACE_TIME', `"ts" must be an ISO 8601 time with Z or an offset, got ${JSON.stringify(String(rec.ts).slice(0, 40))}`, where, 'write "2026-11-14T10:00:00.120Z"');
      timeMs = ms;
      absolute++;
    } else {
      throw new TraceError('E_TRACE_TIME', 'the record has no time ("timeMs" or "ts")', where, 'add "timeMs" in milliseconds');
    }
    if (typeof rec.kind !== 'string' || !KIND_RE.test(rec.kind)) {
      throw new TraceError('E_TRACE_KIND', `"kind" must be a string of 1 to ${TRACE_LIMITS.kindLength} characters without control characters`, where, 'name the event, such as "call_failed"');
    }
    let subject = null;
    if (rec.subject != null) {
      if (typeof rec.subject === 'number' && Number.isFinite(rec.subject)) subject = String(rec.subject);
      else if (typeof rec.subject === 'string' && rec.subject.length <= TRACE_LIMITS.subjectLength && !hasControl(rec.subject)) subject = rec.subject;
      else throw new TraceError('E_TRACE_SUBJECT', `"subject" must be a string of at most ${TRACE_LIMITS.subjectLength} characters, or a number`, where, 'use a short identifier such as "req-7"');
    }
    let id = null;
    if (rec.id != null) {
      if (typeof rec.id !== 'string' || !ID_RE.test(rec.id)) throw new TraceError('E_TRACE_ID', '"id" must be 1 to 64 letters, digits, "_", ".", ":" or "-"', where, 'use ids such as "ev-00001", or leave them out');
      id = rec.id;
    }
    if (opts.strict && opts.knownKinds && !opts.knownKinds.has(rec.kind)) {
      throw new TraceError('E_TRACE_UNKNOWN_KIND', `kind "${rec.kind}" is not in the mapping`, where, 'map it, or import without --strict to count it as unmapped');
    }
    const attrs = cleanAttrs(rec.attrs, allow, where, stats);
    if (timeMs < lastTime && !nonMonotonic) nonMonotonic = where;
    lastTime = Math.max(lastTime, timeMs);
    records.push({ index: records.length, line: i + 1, id, timeMs, kind: rec.kind, subject, attrs });
  }
  if (absolute && relative) throw new TraceError('E_TRACE_TIME', 'the trace mixes relative "timeMs" and absolute "ts" records', null, 'use one time form for every record');
  if (absolute) {
    let originMs;
    if (opts.origin === 'first-event') originMs = records.reduce((m, r) => Math.min(m, r.timeMs), Infinity);
    else if (typeof opts.origin === 'string' && parseIsoMs(opts.origin) != null) originMs = parseIsoMs(opts.origin);
    else throw new TraceError('E_TRACE_ABSOLUTE_TIME', 'the trace uses absolute "ts" times but no origin was declared', null, 'pass --origin first-event, or --origin 2026-11-14T10:00:00Z');
    for (const r of records) r.timeMs = r.timeMs - originMs;
    if (records.some((r) => r.timeMs < 0)) throw new TraceError('E_TRACE_NEGATIVE_TIME', 'some records are before the declared origin', null, 'declare an earlier origin');
  }
  if (nonMonotonic && opts.strict) throw new TraceError('E_TRACE_NOT_MONOTONIC', 'records are not in time order', nonMonotonic, 'sort the file, or import without --strict (records are sorted by time, then by record order)');
  if (nonMonotonic) warnings.push({ code: 'W_TRACE_REORDERED', message: `records are not in time order (first at ${nonMonotonic}); sorted by time, then by record order` });
  if (records.some((r) => r.timeMs < 0)) throw new TraceError('E_TRACE_NEGATIVE_TIME', 'a record has a negative "timeMs"', `line ${records.find((r) => r.timeMs < 0).line}`, 'use times relative to the start of the trace');

  // ids: given ones must be unique; missing ones are ev-00001.. by record order
  const ids = new Set();
  for (const r of records) {
    if (r.id == null) r.id = 'ev-' + String(r.index + 1).padStart(5, '0');
    if (ids.has(r.id)) throw new TraceError('E_TRACE_DUPLICATE_ID', `event id "${r.id}" appears twice`, `line ${r.line}`, 'make every id unique, or leave ids out');
    ids.add(r.id);
  }
  const sorted = records.slice().sort((a, b) => a.timeMs - b.timeMs || a.index - b.index);
  if (truncated) warnings.push({ code: 'W_TRACE_TRUNCATED', message: `the trace has more than ${limits.maxEvents} events; only the first ${limits.maxEvents} records were imported` });
  if (stats.droppedAttrs) warnings.push({ code: 'W_ATTRS_DROPPED', message: `${stats.droppedAttrs} attribute value${stats.droppedAttrs === 1 ? ' was' : 's were'} dropped (not allowlisted): ${[...stats.droppedKeys].sort().slice(0, 12).join(', ')}` });
  if (stats.droppedFields) warnings.push({ code: 'W_FIELDS_DROPPED', message: `${stats.droppedFields} unknown record field${stats.droppedFields === 1 ? ' was' : 's were'} dropped` });
  let completeness = opts.complete ? 'declared-complete' : 'unknown';
  if (truncated) {
    if (opts.complete) warnings.push({ code: 'W_COMPLETE_IGNORED', message: '--complete was ignored because the trace was truncated' });
    completeness = 'known-incomplete';
  }
  if (completeness === 'unknown') warnings.push({ code: 'W_COMPLETENESS_UNKNOWN', message: 'completeness is unknown: a missing observed event can only make an assertion inconclusive. Pass --complete only after checking that the instrumentation records every event.' });
  return {
    schemaVersion: 1,
    kind: 'working-model-trace',
    timeBase: 'relative-ms',
    origin: { kind: 'imported-jsonl', sourceDigest: opts.sourceDigest || null, absoluteTime: absolute > 0 },
    completeness,
    events: sorted.map((r) => {
      const e = { id: r.id, timeMs: r.timeMs, kind: r.kind };
      if (r.subject != null) e.subject = r.subject;
      e.attrs = r.attrs;
      return e;
    }),
    stats: { records: records.length, truncated, droppedAttrs: stats.droppedAttrs, droppedFields: stats.droppedFields },
    warnings,
  };
}

// Validate a normalized trace read back from a file (it is untrusted too).
export function validateNormalized(t) {
  const bad = (msg, where) => new TraceError('E_TRACE_SCHEMA', msg, where, 'run trace import again to produce a normalized trace');
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad('the normalized trace must be a JSON object', null);
  if (t.schemaVersion !== 1) throw bad(`unsupported schemaVersion ${JSON.stringify(t.schemaVersion)}; expected 1`, 'schemaVersion');
  if (t.kind !== 'working-model-trace') throw bad('"kind" must be "working-model-trace"', 'kind');
  if (t.timeBase !== 'relative-ms') throw bad('"timeBase" must be "relative-ms"', 'timeBase');
  if (!COMPLETENESS.includes(t.completeness)) throw bad(`"completeness" must be one of ${COMPLETENESS.join(', ')}`, 'completeness');
  if (!Array.isArray(t.events)) throw bad('"events" must be an array', 'events');
  if (t.events.length > TRACE_LIMITS.hardEvents) throw new TraceError('E_TRACE_LIMIT', `more than ${TRACE_LIMITS.hardEvents} events`, 'events', 'import a smaller window');
  const ids = new Set();
  let last = -Infinity;
  t.events.forEach((e, i) => {
    const where = `events[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw bad('each event must be an object', where);
    for (const k of Object.keys(e)) if (!['id', 'timeMs', 'kind', 'subject', 'attrs'].includes(k)) throw bad(`unknown event field "${k}"`, where);
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) throw bad('"id" must be 1 to 64 letters, digits, "_", ".", ":" or "-"', where + '.id');
    if (ids.has(e.id)) throw new TraceError('E_TRACE_DUPLICATE_ID', `event id "${e.id}" appears twice`, where, 'make every id unique');
    ids.add(e.id);
    if (typeof e.timeMs !== 'number' || !Number.isFinite(e.timeMs) || e.timeMs < 0) throw bad('"timeMs" must be a finite number of at least 0', where + '.timeMs');
    if (e.timeMs < last) throw bad('events must be sorted by timeMs', where + '.timeMs');
    last = e.timeMs;
    if (typeof e.kind !== 'string' || !KIND_RE.test(e.kind)) throw bad('"kind" must be a short string', where + '.kind');
    if (e.subject != null && (typeof e.subject !== 'string' || e.subject.length > TRACE_LIMITS.subjectLength || hasControl(e.subject))) throw bad('"subject" must be a short string', where + '.subject');
    if (e.attrs != null) {
      if (typeof e.attrs !== 'object' || Array.isArray(e.attrs)) throw bad('"attrs" must be an object', where + '.attrs');
      for (const [k, v] of Object.entries(e.attrs)) {
        if (v !== null && typeof v === 'object') throw new TraceError('E_TRACE_NESTED', `attribute "${k}" is nested`, where + '.attrs', 'flatten it');
        if (typeof v === 'number' && !Number.isFinite(v)) throw new TraceError('E_TRACE_NONFINITE', `attribute "${k}" is not finite`, where + '.attrs', 'write a finite number');
        if (typeof v === 'string' && v.length > TRACE_LIMITS.stringLength) throw bad(`attribute "${k}" is too long`, where + '.attrs');
      }
    }
  });
  return t;
}
