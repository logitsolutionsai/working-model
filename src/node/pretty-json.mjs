// JSON with short arrays and objects kept on one line, so specs stay easy
// to read and edit by hand.

export function prettyJSON(value, width = 140) {
  return fmt(value, '', width) + '\n';
}

function inline(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(inline).join(', ') + ']';
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  return '{ ' + keys.map((k) => JSON.stringify(k) + ': ' + inline(v[k])).join(', ') + ' }';
}

function fmt(v, indent, width) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const one = inline(v);
  // rule code (arrays of lines) always goes one line per entry
  const isCode = Array.isArray(v) && v.length > 1 && v.every((x) => typeof x === 'string') && v.some((x) => /[{}=]/.test(x));
  if (one.length + indent.length <= width && !isCode) return one;
  const inner = indent + '  ';
  if (Array.isArray(v)) return '[\n' + v.map((x) => inner + fmt(x, inner, width)).join(',\n') + '\n' + indent + ']';
  const keys = Object.keys(v);
  return '{\n' + keys.map((k) => inner + JSON.stringify(k) + ': ' + fmt(v[k], inner, width)).join(',\n') + '\n' + indent + '}';
}
