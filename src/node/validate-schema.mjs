// A small JSON Schema validator for the subset model.schema.json uses:
// type, properties, required, additionalProperties, propertyNames, items,
// minItems, maxItems, enum, const, minimum, maximum, exclusiveMinimum,
// minLength, pattern, anyOf, allOf, if/then, $ref (#/$defs/...).
// Errors come back with stable codes and a JSON-pointer-like path.

import { closest } from '../engine/errors.mjs';

export function validateSchema(data, schema) {
  const errors = [];
  walk(data, schema, '', schema, errors);
  // one error per path is enough for authors
  const seen = new Set();
  return errors.filter((e) => {
    const key = e.path + '|' + e.code;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function join(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

function resolve(ref, root) {
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  if (!m || !root.$defs || !root.$defs[m[1]]) throw new Error('unresolvable $ref ' + ref);
  return root.$defs[m[1]];
}

function walk(v, s, path, root, errors) {
  if (s.$ref) { walk(v, resolve(s.$ref, root), path, root, errors); }
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(v, t))) {
      errors.push({ code: 'E_SCHEMA_TYPE', path: path || '(root)', message: `must be ${types.map(article).join(' or ')}, got ${article(typeOf(v))}` });
      return;
    }
  }
  if (s.const !== undefined && v !== s.const) {
    errors.push({ code: 'E_SCHEMA_ENUM', path, message: `must be ${JSON.stringify(s.const)}` });
    return;
  }
  if (s.enum && !s.enum.includes(v)) {
    const guess = typeof v === 'string' ? closest(v, s.enum.filter((x) => typeof x === 'string')) : null;
    errors.push({ code: 'E_SCHEMA_ENUM', path, message: `must be one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}, got ${JSON.stringify(v)}${guess ? `; did you mean "${guess}"?` : ''}` });
    return;
  }
  if (typeof v === 'number') {
    if (s.minimum != null && v < s.minimum) errors.push({ code: 'E_SCHEMA_RANGE', path, message: `must be at least ${s.minimum}, got ${v}` });
    if (s.maximum != null && v > s.maximum) errors.push({ code: 'E_SCHEMA_RANGE', path, message: `must be at most ${s.maximum}, got ${v}` });
    if (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) errors.push({ code: 'E_SCHEMA_RANGE', path, message: `must be greater than ${s.exclusiveMinimum}, got ${v}` });
  }
  if (typeof v === 'string') {
    if (s.minLength != null && v.length < s.minLength) errors.push({ code: 'E_SCHEMA_RANGE', path, message: `must not be empty` });
    if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push({ code: 'E_SCHEMA_PATTERN', path, message: `"${v}" does not match ${s.pattern}` });
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) errors.push({ code: 'E_SCHEMA_ITEMS', path, message: `needs at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}` });
    if (s.maxItems != null && v.length > s.maxItems) errors.push({ code: 'E_SCHEMA_ITEMS', path, message: `allows at most ${s.maxItems} items` });
    if (s.items) v.forEach((x, i) => walk(x, s.items, join(path, i), root, errors));
  }
  if (typeOf(v) === 'object') {
    const props = s.properties || {};
    for (const r of s.required || []) {
      if (!hasOwn(v, r)) errors.push({ code: 'E_SCHEMA_REQUIRED', path: path || '(root)', message: `is missing "${r}"` });
    }
    for (const [k, x] of Object.entries(v)) {
      if (s.propertyNames && s.propertyNames.pattern && !new RegExp(s.propertyNames.pattern).test(k)) {
        errors.push({ code: 'E_SCHEMA_PATTERN', path: join(path, k), message: `name "${k}" does not match ${s.propertyNames.pattern}` });
        continue;
      }
      if (hasOwn(props, k)) walk(x, props[k], join(path, k), root, errors);
      else if (s.additionalProperties === false) {
        const guess = closest(k, Object.keys(props));
        errors.push({ code: 'E_SCHEMA_UNKNOWN_KEY', path: join(path, k), message: `"${k}" is not a known field${guess ? `; did you mean "${guess}"?` : ''}` });
      } else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        walk(x, s.additionalProperties, join(path, k), root, errors);
      }
    }
  }
  if (s.allOf) for (const sub of s.allOf) walk(v, sub, path, root, errors);
  if (s.if) {
    const probe = [];
    walk(v, s.if, path, root, probe);
    if (probe.length === 0 && s.then) walk(v, s.then, path, root, errors);
    else if (probe.length > 0 && s.else) walk(v, s.else, path, root, errors);
  }
  if (s.anyOf) {
    const branches = s.anyOf.map((sub) => { const e = []; walk(v, sub, path, root, e); return e; });
    if (!branches.some((e) => e.length === 0)) {
      const rootOnly = branches.every((e) => e.every((x) => x.path === path && x.code === 'E_SCHEMA_TYPE'));
      if (rootOnly) {
        const types = s.anyOf.map((sub) => sub.type).filter(Boolean).flat();
        errors.push({ code: 'E_SCHEMA_TYPE', path, message: `must be ${[...new Set(types)].map(article).join(' or ')}, got ${article(typeOf(v))}` });
      } else {
        const best = branches.filter((e) => !e.every((x) => x.path === path && x.code === 'E_SCHEMA_TYPE')).sort((a, b) => a.length - b.length)[0];
        errors.push(...best);
      }
    }
  }
}

// Own keys only: a spec key such as "constructor" or "toString" must not
// match a property inherited from Object.prototype.
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function article(t) {
  const map = { object: 'an object', array: 'a list', string: 'a string', number: 'a number', integer: 'a whole number', boolean: 'true or false', null: 'null' };
  return map[t] || t;
}
