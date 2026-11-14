// Errors carry a stable code and a pointer to the exact place in the spec.
// loc = { path: 'rules.on.request', src: '<program text>', pos: <offset> }
// line/col are computed from src+pos so the message can show the offending line.

export class ModelError extends Error {
  constructor(code, message, loc, extra) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.loc = loc ? withLineCol(loc) : null;
    if (extra) Object.assign(this, extra);
  }
}

export function withLineCol(loc) {
  if (!loc || loc.src == null || loc.pos == null || loc.line != null) return loc;
  let line = 1;
  let col = 1;
  const src = loc.src;
  const end = Math.min(loc.pos, src.length);
  for (let i = 0; i < end; i++) {
    if (src.charCodeAt(i) === 10) { line++; col = 1; } else col++;
  }
  return { ...loc, line, col };
}

// "rules.on.request:3:12" plus a caret excerpt when the source is known.
export function describeLoc(loc) {
  if (!loc) return '';
  let s = loc.path || '';
  if (loc.line != null) s += (s ? ':' : '') + loc.line + ':' + loc.col;
  return s;
}

export function excerpt(loc) {
  if (!loc || loc.src == null || loc.line == null) return '';
  const lines = loc.src.split('\n');
  const text = lines[loc.line - 1];
  if (text == null) return '';
  return '    ' + text + '\n    ' + ' '.repeat(Math.max(0, loc.col - 1)) + '^';
}

export function errorToJSON(e) {
  if (!(e instanceof ModelError)) {
    return { code: 'E_INTERNAL', message: String(e && e.message || e) };
  }
  const out = { code: e.code, message: e.message };
  if (e.loc) {
    out.path = e.loc.path;
    if (e.loc.line != null) { out.line = e.loc.line; out.col = e.loc.col; }
  }
  if (e.hint) out.hint = e.hint;
  return out;
}

// Closest name for "did you mean" hints (small Levenshtein).
export function closest(name, candidates) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), String(c).toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best == null) return null;
  return bestD <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
