// A documented subset of OTLP JSON traces (the JSON encoding of
// ExportTraceServiceRequest): resourceSpans[].scopeSpans[].spans[], and each
// span's events[].
//
// A span or span event becomes an observed event only when it carries the
// configured kind attribute (default "wm.event"); its value is the kind.
// Span names, span kinds and status codes are never read as domain events.
// The time is startTimeUnixNano (spans) or timeUnixNano (span events), in
// nanoseconds, converted exactly with BigInt and kept as fractional
// milliseconds relative to the declared origin. Logs and metrics are not
// supported and are reported, not read.
// Pure module: no Node or browser APIs.

import { TraceError } from './errors.mjs';
import { TRACE_LIMITS, parseIsoMs } from './normalize.mjs';

const KIND_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function anyValue(v) {
  if (!v || typeof v !== 'object') return { ok: false };
  if ('stringValue' in v) return { ok: true, value: String(v.stringValue) };
  if ('boolValue' in v) return { ok: true, value: !!v.boolValue };
  if ('intValue' in v) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? { ok: true, value: n } : { ok: true, value: String(v.intValue) };
  }
  if ('doubleValue' in v) {
    const n = Number(v.doubleValue);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: 'nonfinite' };
  }
  return { ok: false, reason: 'unsupported' }; // arrayValue, kvlistValue, bytesValue
}

function nanos(v, where) {
  if (typeof v !== 'string' && typeof v !== 'number') throw new TraceError('E_TRACE_TIME', 'a time in nanoseconds is missing', where, 'export startTimeUnixNano / timeUnixNano');
  const s = String(v);
  if (!/^\d{1,20}$/.test(s)) throw new TraceError('E_TRACE_TIME', `"${s.slice(0, 24)}" is not a whole number of nanoseconds`, where, null);
  return BigInt(s);
}

export function normalizeOtlp(doc, opts = {}) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new TraceError('E_OTLP_SCHEMA', 'an OTLP JSON document must be an object', null, 'export ExportTraceServiceRequest as JSON');
  const kindKey = opts.kindAttribute || 'wm.event';
  const subjectKey = opts.subjectAttribute || null;
  const allow = new Set(opts.allowAttrs || []);
  const warnings = [];
  for (const k of ['resourceLogs', 'resourceMetrics']) {
    if (doc[k] != null) warnings.push({ code: 'W_OTLP_UNSUPPORTED', message: `"${k}" is not supported and was ignored; only resourceSpans are read` });
  }
  if (!Array.isArray(doc.resourceSpans)) {
    throw new TraceError('E_OTLP_SCHEMA', 'no "resourceSpans" array', 'resourceSpans', 'export traces (not logs or metrics) as OTLP JSON');
  }
  const raw = [];
  let noKind = 0;
  let dropped = 0;
  let unsupported = 0;
  const maxEvents = opts.maxEvents || TRACE_LIMITS.defaultEvents;
  let truncated = false;
  const attrsOf = (list, where) => {
    const out = {};
    let kind = null;
    let subject = null;
    if (list != null && !Array.isArray(list)) throw new TraceError('E_OTLP_SCHEMA', '"attributes" must be an array of { key, value }', where, null);
    for (const a of list || []) {
      if (!a || typeof a.key !== 'string') { unsupported++; continue; }
      const v = anyValue(a.value);
      if (a.key === kindKey) { if (v.ok && typeof v.value === 'string') kind = v.value; continue; }
      if (subjectKey && a.key === subjectKey) { if (v.ok) subject = String(v.value); continue; }
      if (!v.ok) { if (v.reason === 'nonfinite') throw new TraceError('E_TRACE_NONFINITE', `attribute "${a.key}" is not a finite number`, where, null); unsupported++; continue; }
      if (!allow.has(a.key)) { dropped++; continue; }
      if (typeof v.value === 'string' && v.value.length > TRACE_LIMITS.stringLength) { dropped++; continue; }
      out[a.key] = v.value;
    }
    return { attrs: out, kind, subject };
  };
  const add = (rec, where) => {
    if (rec.kind == null) { noKind++; return; }
    if (!KIND_RE.test(rec.kind)) throw new TraceError('E_TRACE_KIND', `kind "${rec.kind.slice(0, 40)}" is too long or holds control characters`, where, null);
    if (rec.subject != null && rec.subject.length > TRACE_LIMITS.subjectLength) throw new TraceError('E_TRACE_SUBJECT', 'the subject is too long', where, null);
    if (raw.length >= maxEvents) { truncated = true; return; }
    if (opts.strict && opts.knownKinds && !opts.knownKinds.has(rec.kind)) throw new TraceError('E_TRACE_UNKNOWN_KIND', `kind "${rec.kind}" is not in the mapping`, where, 'map it, or import without --strict');
    raw.push(rec);
  };
  doc.resourceSpans.forEach((rs, i) => {
    const scopes = rs && Array.isArray(rs.scopeSpans) ? rs.scopeSpans : [];
    if (rs && rs.instrumentationLibrarySpans) warnings.push({ code: 'W_OTLP_UNSUPPORTED', message: '"instrumentationLibrarySpans" (an old OTLP form) was ignored; use scopeSpans' });
    scopes.forEach((ss, j) => {
      (Array.isArray(ss && ss.spans) ? ss.spans : []).forEach((sp, k) => {
        const where = `resourceSpans[${i}].scopeSpans[${j}].spans[${k}]`;
        if (!sp || typeof sp !== 'object') throw new TraceError('E_OTLP_SCHEMA', 'a span must be an object', where, null);
        const sid = typeof sp.spanId === 'string' && ID_RE.test(sp.spanId) ? sp.spanId : `span-${i}-${j}-${k}`;
        const a = attrsOf(sp.attributes, where + '.attributes');
        add({ id: sid, ns: nanos(sp.startTimeUnixNano, where + '.startTimeUnixNano'), ...a }, where);
        (Array.isArray(sp.events) ? sp.events : []).forEach((se, m) => {
          const w2 = `${where}.events[${m}]`;
          const b = attrsOf(se && se.attributes, w2 + '.attributes');
          add({ id: `${sid}.e${m}`, ns: nanos(se && se.timeUnixNano, w2 + '.timeUnixNano'), ...b }, w2);
        });
      });
    });
  });
  // OTLP times are absolute: an origin must be declared
  let originNs;
  if (opts.origin === 'first-event') originNs = raw.reduce((m, r) => (m == null || r.ns < m ? r.ns : m), null);
  else if (typeof opts.origin === 'string' && parseIsoMs(opts.origin) != null) originNs = BigInt(Math.round(parseIsoMs(opts.origin))) * 1000000n;
  else if (raw.length) throw new TraceError('E_TRACE_ABSOLUTE_TIME', 'OTLP times are absolute, and no origin was declared', null, 'pass --origin first-event, or --origin 2026-11-14T10:00:00Z');
  const ids = new Set();
  const events = raw.map((r, index) => {
    const d = r.ns - originNs;
    if (d < 0n) throw new TraceError('E_TRACE_NEGATIVE_TIME', `span ${r.id} is before the declared origin`, r.id, 'declare an earlier origin');
    if (ids.has(r.id)) throw new TraceError('E_TRACE_DUPLICATE_ID', `span id "${r.id}" appears twice`, r.id, null);
    ids.add(r.id);
    const whole = d / 1000000n;
    const frac = Number(d % 1000000n) / 1e6;
    return { index, id: r.id, timeMs: Number(whole) + frac, kind: r.kind, subject: r.subject, attrs: r.attrs };
  });
  events.sort((a, b) => a.timeMs - b.timeMs || a.index - b.index);
  if (noKind) warnings.push({ code: 'W_OTLP_NO_KIND', message: `${noKind} span${noKind === 1 ? '' : 's'} or span event${noKind === 1 ? '' : 's'} had no "${kindKey}" attribute and were skipped; span names are never read as events` });
  if (dropped) warnings.push({ code: 'W_ATTRS_DROPPED', message: `${dropped} attribute value${dropped === 1 ? ' was' : 's were'} dropped (not allowlisted)` });
  if (unsupported) warnings.push({ code: 'W_OTLP_UNSUPPORTED', message: `${unsupported} attribute${unsupported === 1 ? '' : 's'} with array, map or bytes values were not read` });
  if (truncated) warnings.push({ code: 'W_TRACE_TRUNCATED', message: `more than ${maxEvents} events; only the first ${maxEvents} were imported` });
  warnings.push({ code: 'W_OTLP_SAMPLED', message: 'OTLP traces are often sampled or filtered; completeness stays "unknown" unless you declare it after checking the sampler and the exporter' });
  let completeness = opts.complete ? 'declared-complete' : 'unknown';
  if (truncated) completeness = 'known-incomplete';
  return {
    schemaVersion: 1, kind: 'working-model-trace', timeBase: 'relative-ms',
    origin: { kind: 'imported-otlp', sourceDigest: opts.sourceDigest || null, absoluteTime: true, kindAttribute: kindKey, subjectAttribute: subjectKey },
    completeness,
    events: events.map((e) => {
      const o = { id: e.id, timeMs: e.timeMs, kind: e.kind };
      if (e.subject != null) o.subject = e.subject;
      o.attrs = e.attrs;
      return o;
    }),
    stats: { records: events.length, truncated, droppedAttrs: dropped, skippedWithoutKind: noKind },
    warnings,
  };
}
