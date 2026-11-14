// Errors for traces, mappings, replay, fuzz and bundles.
// Every error has a stable code, a message, a location (a line of a trace
// file, or a path such as "outputs[0].modelEmit") and a fix, which is what
// `--json` prints: { code, message, location, fix }.
// No Node or browser APIs here: the page bundles this module too.

export class TraceError extends Error {
  constructor(code, message, location, fix) {
    super(message);
    this.name = 'TraceError';
    this.code = code;
    this.location = location == null ? null : String(location);
    this.fix = fix || null;
  }
}

export function traceErrorJSON(e) {
  if (e instanceof TraceError) return { code: e.code, message: e.message, location: e.location, fix: e.fix };
  if (e && e.code && e.message) return { code: e.code, message: e.message, location: e.location || e.path || null, fix: e.fix || e.hint || null };
  return { code: 'E_INTERNAL', message: String(e && e.message ? e.message : e), location: null, fix: null };
}

// Canonical JSON: sorted object keys, no whitespace, numbers in the shortest
// form JavaScript prints (stable for a given value), -0 written as 0.
// Used for digests and for every file the fuzzer writes, so the same case is
// always the same bytes.
export function canonicalJSON(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TraceError('E_NONFINITE', 'a non-finite number cannot be written as canonical JSON', null, 'check the value that produced it');
    return Object.is(v, -0) ? '0' : JSON.stringify(v);
  }
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJSON).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(v[k])).join(',') + '}';
  }
  throw new TraceError('E_INTERNAL', `cannot serialise a ${typeof v}`, null, null);
}

// Pretty canonical JSON (sorted keys, two-space indent) for files people read.
export function canonicalPretty(v) {
  return JSON.stringify(JSON.parse(canonicalJSON(v)), null, 2) + '\n';
}

export const TIME_UNITS_MS = { ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 };
