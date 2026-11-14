// The mapping file (trace-map.json): which observed kinds drive which model
// events, which model emits should appear as which observed kinds, and the
// assertions to test. Selectors are fixed forms, never expressions:
//   observed side: "subject", "attrs.<key>", "literal:<text>"
//   model side:    "event.<key>" (the replayed input whose handler emitted),
//                  "payload", "payload[<n>]", "literal:<text>"
// Pure module: no Node or browser APIs.

import { TraceError, TIME_UNITS_MS } from './errors.mjs';

export const MAX_WITHIN_MS = 3600000;
export const ASSERTION_KINDS = ['event-correspondence', 'event-order', 'response-before', 'never-observed'];
const KEY = '[A-Za-z_][A-Za-z0-9_.-]{0,63}';
const OBS_SEL = new RegExp(`^(subject|attrs\\.${KEY}|literal:[^\\u0000-\\u001f]{1,128})$`);
const MODEL_SEL = new RegExp(`^(event\\.[A-Za-z_][A-Za-z0-9_]{0,39}|payload|payload\\[\\d{1,4}\\]|literal:[^\\u0000-\\u001f]{1,128})$`);
const PAYLOAD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const ID = /^[A-Za-z_][A-Za-z0-9_-]{0,59}$/;

const TOP = ['$schema', 'schemaVersion', 'modelTimeUnit', 'msPerModelUnit', 'timeOrigin', 'timeQuantization', 'quantizationToleranceMs', 'replayMode',
  'internalEvents', 'allowUnknownObserved', 'keepAttrs', 'inputs', 'outputs', 'assertions', 'note'];

function err(code, message, location, fix) { return new TraceError(code, message, location, fix); }

function checkKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw err('E_MAPPING_SCHEMA', `unknown key "${k}"`, where, `allowed keys: ${allowed.join(', ')}`);
  }
}

function str(v, where, what) {
  if (typeof v !== 'string' || !v.length || v.length > 128) throw err('E_MAPPING_SCHEMA', `${what} must be a non-empty string`, where, null);
  return v;
}

function selector(v, where, re, what) {
  if (v == null) return null;
  if (typeof v !== 'string' || !re.test(v)) throw err('E_MAPPING_SELECTOR', `${what} ${JSON.stringify(v)} is not a supported selector`, where,
    re === OBS_SEL ? 'use "subject", "attrs.<key>" or "literal:<text>"' : 'use "event.<key>", "payload", "payload[0]" or "literal:<text>"');
  return v;
}

// Validate a mapping object against a compiled model. Returns a normalized
// copy with defaults filled in. Throws TraceError on the first problem.
export function validateMapping(raw, model) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw err('E_MAPPING_SCHEMA', 'the mapping must be a JSON object', null, null);
  checkKeys(raw, TOP, '(root)');
  if (raw.schemaVersion !== 1) throw err('E_MAPPING_SCHEMA', `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}; expected 1`, 'schemaVersion', 'set "schemaVersion": 1');
  let msPerUnit;
  if (raw.msPerModelUnit != null) {
    if (typeof raw.msPerModelUnit !== 'number' || !(raw.msPerModelUnit > 0) || !Number.isFinite(raw.msPerModelUnit)) throw err('E_MAPPING_SCHEMA', '"msPerModelUnit" must be a positive number', 'msPerModelUnit', null);
    msPerUnit = raw.msPerModelUnit;
  } else {
    const unit = raw.modelTimeUnit != null ? raw.modelTimeUnit : model.timeUnit;
    if (!(unit in TIME_UNITS_MS)) throw err('E_MAPPING_TIME_UNIT', `model time unit "${unit}" is not one of ${Object.keys(TIME_UNITS_MS).join(', ')}`, raw.modelTimeUnit != null ? 'modelTimeUnit' : 'model.timeUnit', 'set "msPerModelUnit" to the milliseconds in one model time unit');
    if (raw.modelTimeUnit != null && model.timeUnit in TIME_UNITS_MS && raw.modelTimeUnit !== model.timeUnit) {
      throw err('E_MAPPING_TIME_UNIT', `the mapping says the model counts time in "${raw.modelTimeUnit}", but the model's timeUnit is "${model.timeUnit}"`, 'modelTimeUnit', `set "modelTimeUnit": "${model.timeUnit}"`);
    }
    msPerUnit = TIME_UNITS_MS[unit];
  }
  const dtMs = model.dt * msPerUnit;
  const timeOrigin = raw.timeOrigin == null ? 'first-input' : raw.timeOrigin;
  if (!['first-input', 'zero'].includes(timeOrigin)) throw err('E_MAPPING_SCHEMA', '"timeOrigin" must be "first-input" or "zero"', 'timeOrigin', null);
  if (raw.timeQuantization != null && raw.timeQuantization !== 'nearest-tick') throw err('E_MAPPING_SCHEMA', '"timeQuantization" must be "nearest-tick"', 'timeQuantization', null);
  if (raw.replayMode != null && raw.replayMode !== 'replace-inputs') throw err('E_MAPPING_SCHEMA', '"replayMode" must be "replace-inputs" (the only mode in this version)', 'replayMode', null);
  let tol = dtMs / 2;
  if (raw.quantizationToleranceMs != null) {
    if (typeof raw.quantizationToleranceMs !== 'number' || !(raw.quantizationToleranceMs >= 0)) throw err('E_MAPPING_SCHEMA', '"quantizationToleranceMs" must be a number of at least 0', 'quantizationToleranceMs', null);
    tol = raw.quantizationToleranceMs;
  }
  const keepAttrs = new Set();
  if (raw.keepAttrs != null) {
    if (!Array.isArray(raw.keepAttrs)) throw err('E_MAPPING_SCHEMA', '"keepAttrs" must be a list of attribute names', 'keepAttrs', null);
    raw.keepAttrs.forEach((k, i) => { keepAttrs.add(str(k, `keepAttrs[${i}]`, 'an attribute name')); });
  }
  const noteAttr = (sel) => { if (sel && sel.startsWith('attrs.')) keepAttrs.add(sel.slice(6)); };

  // ---- inputs
  if (!Array.isArray(raw.inputs) || !raw.inputs.length) throw err('E_MAPPING_SCHEMA', '"inputs" must list at least one observed kind that drives a model event', 'inputs', 'add { "observedKind": "request", "modelEvent": "request" }');
  const payloadKeys = new Set();
  const inputs = raw.inputs.map((x, i) => {
    const where = `inputs[${i}]`;
    if (!x || typeof x !== 'object') throw err('E_MAPPING_SCHEMA', 'each input must be an object', where, null);
    checkKeys(x, ['observedKind', 'modelEvent', 'subjectFrom', 'modelPayloadKey', 'when', 'note'], where);
    const observedKind = str(x.observedKind, where + '.observedKind', '"observedKind"');
    const modelEvent = str(x.modelEvent, where + '.modelEvent', '"modelEvent"');
    if (!model.eventNames.has(modelEvent)) throw err('E_MAPPING_UNKNOWN_EVENT', `the model has no event "${modelEvent}"`, where + '.modelEvent', `model events: ${[...model.eventNames].join(', ') || 'none'}`);
    const subjectFrom = selector(x.subjectFrom == null ? 'subject' : x.subjectFrom, where + '.subjectFrom', OBS_SEL, '"subjectFrom"');
    noteAttr(subjectFrom);
    let modelPayloadKey = null;
    if (x.modelPayloadKey != null) {
      if (typeof x.modelPayloadKey !== 'string' || !PAYLOAD_KEY.test(x.modelPayloadKey)) throw err('E_MAPPING_SCHEMA', '"modelPayloadKey" must be a simple name', where + '.modelPayloadKey', 'use a name such as "requestId"');
      modelPayloadKey = x.modelPayloadKey;
      payloadKeys.add(modelPayloadKey);
    }
    const when = whenFilter(x.when, where + '.when', noteAttr);
    return { observedKind, modelEvent, subjectFrom, modelPayloadKey, when };
  });
  // two inputs for one observed kind must be told apart by "when"
  for (let i = 0; i < inputs.length; i++) {
    for (let j = 0; j < i; j++) {
      if (inputs[i].observedKind === inputs[j].observedKind && (!inputs[i].when || !inputs[j].when)) {
        throw err('E_MAPPING_DUPLICATE', `observed kind "${inputs[i].observedKind}" is mapped twice without a "when" filter on both`, `inputs[${i}]`, 'add "when": { "attrs.<key>": "<value>" } to each entry');
      }
    }
  }
  const mappedEvents = new Set(inputs.map((x) => x.modelEvent));

  // ---- internal events: model events that keep their own schedule
  const internal = new Set();
  if (raw.internalEvents != null) {
    if (!Array.isArray(raw.internalEvents)) throw err('E_MAPPING_SCHEMA', '"internalEvents" must be a list of model event names', 'internalEvents', null);
    raw.internalEvents.forEach((n, i) => {
      if (!model.eventNames.has(n)) throw err('E_MAPPING_UNKNOWN_EVENT', `the model has no event "${n}"`, `internalEvents[${i}]`, null);
      if (mappedEvents.has(n)) throw err('E_REPLAY_AMBIGUOUS', `event "${n}" is both replayed from the trace and kept as internal; it would fire twice`, `internalEvents[${i}]`, 'remove it from internalEvents or from inputs');
      internal.add(n);
    });
  }
  for (const ev of model.events) {
    if (!mappedEvents.has(ev.name) && !internal.has(ev.name)) {
      throw err('E_REPLAY_AMBIGUOUS', `model event "${ev.name}" is neither replayed from the trace nor declared internal`, 'internalEvents',
        `add "${ev.name}" to "internalEvents" to keep its own schedule during replay, or map an observed kind to it`);
    }
  }

  // ---- outputs
  const outputs = (raw.outputs || []).map((x, i) => {
    const where = `outputs[${i}]`;
    if (!x || typeof x !== 'object') throw err('E_MAPPING_SCHEMA', 'each output must be an object', where, null);
    checkKeys(x, ['modelEmit', 'observedKind', 'modelSubjectFrom', 'observedSubjectFrom', 'withinMs', 'payloadIsSeqOf', 'note'], where);
    const modelEmit = str(x.modelEmit, where + '.modelEmit', '"modelEmit"');
    if (!model.emits.has(modelEmit)) throw err('E_MAPPING_UNKNOWN_EMIT', `the model never calls emit('${modelEmit}')`, where + '.modelEmit', `model emits: ${[...model.emits].join(', ') || 'none'}`);
    const observedKind = str(x.observedKind, where + '.observedKind', '"observedKind"');
    const modelSubjectFrom = selector(x.modelSubjectFrom, where + '.modelSubjectFrom', MODEL_SEL, '"modelSubjectFrom"');
    const observedSubjectFrom = selector(x.observedSubjectFrom, where + '.observedSubjectFrom', OBS_SEL, '"observedSubjectFrom"');
    noteAttr(observedSubjectFrom);
    if (modelSubjectFrom && modelSubjectFrom.startsWith('event.') && !payloadKeys.has(modelSubjectFrom.slice(6))) {
      throw err('E_MAPPING_SELECTOR', `"${modelSubjectFrom}" names a key no input sets`, where + '.modelSubjectFrom', `set "modelPayloadKey": "${modelSubjectFrom.slice(6)}" on the input that carries it`);
    }
    if ((modelSubjectFrom == null) !== (observedSubjectFrom == null)) {
      throw err('E_MAPPING_SELECTOR', 'give both "modelSubjectFrom" and "observedSubjectFrom", or neither (then the output is uncorrelated)', where, null);
    }
    let payloadIsSeqOf = null;
    if (x.payloadIsSeqOf != null) {
      if (!mappedEvents.has(x.payloadIsSeqOf)) throw err('E_MAPPING_SELECTOR', `"payloadIsSeqOf" must name a replayed model event`, where + '.payloadIsSeqOf', `replayed events: ${[...mappedEvents].join(', ')}`);
      if (!modelSubjectFrom || !modelSubjectFrom.startsWith('payload')) throw err('E_MAPPING_SELECTOR', '"payloadIsSeqOf" needs "modelSubjectFrom": "payload" or "payload[n]"', where, null);
      payloadIsSeqOf = x.payloadIsSeqOf;
    }
    let withinMs = Math.max(dtMs, 1);
    if (x.withinMs != null) {
      if (typeof x.withinMs !== 'number' || !(x.withinMs >= 0) || !Number.isFinite(x.withinMs)) throw err('E_MAPPING_SCHEMA', '"withinMs" must be a number of at least 0', where + '.withinMs', null);
      withinMs = x.withinMs;
    }
    if (withinMs > MAX_WITHIN_MS) throw err('E_MAPPING_SCHEMA', `"withinMs" is above the maximum of ${MAX_WITHIN_MS}`, where + '.withinMs', null);
    return { modelEmit, observedKind, modelSubjectFrom, observedSubjectFrom, withinMs, payloadIsSeqOf };
  });
  const seenEmit = new Set();
  outputs.forEach((o, i) => {
    if (seenEmit.has(o.modelEmit)) throw err('E_MAPPING_DUPLICATE', `emit "${o.modelEmit}" is mapped twice`, `outputs[${i}]`, 'map each emit once');
    seenEmit.add(o.modelEmit);
  });

  // ---- assertions
  const ids = new Set();
  const assertions = (raw.assertions || []).map((x, i) => {
    const where = `assertions[${i}]`;
    if (!x || typeof x !== 'object') throw err('E_MAPPING_SCHEMA', 'each assertion must be an object', where, null);
    if (typeof x.id !== 'string' || !ID.test(x.id)) throw err('E_MAPPING_SCHEMA', 'each assertion needs an "id" of letters, digits, "_" and "-"', where + '.id', null);
    if (ids.has(x.id)) throw err('E_MAPPING_DUPLICATE', `assertion id "${x.id}" is used twice`, where + '.id', null);
    ids.add(x.id);
    if (!ASSERTION_KINDS.includes(x.kind)) throw err('E_MAPPING_SCHEMA', `assertion kind must be one of ${ASSERTION_KINDS.join(', ')}`, where + '.kind', null);
    const required = x.required == null ? true : x.required;
    if (typeof required !== 'boolean') throw err('E_MAPPING_SCHEMA', '"required" must be true or false', where + '.required', null);
    const base = { id: x.id, kind: x.kind, required, text: x.text == null ? null : str(x.text, where + '.text', '"text"') };
    const ratio = (v, key) => {
      if (v == null) return 1;
      if (typeof v !== 'number' || v < 0 || v > 1) throw err('E_MAPPING_SCHEMA', `"${key}" must be a number from 0 to 1`, `${where}.${key}`, null);
      return v;
    };
    switch (x.kind) {
      case 'event-correspondence': {
        checkKeys(x, ['id', 'kind', 'required', 'text', 'modelEmit', 'minPrecision', 'minRecall'], where);
        const o = outputs.find((y) => y.modelEmit === x.modelEmit);
        if (!o) throw err('E_MAPPING_SCHEMA', `"modelEmit" ${JSON.stringify(x.modelEmit)} has no entry in "outputs"`, where + '.modelEmit', 'map the emit in "outputs" first');
        return { ...base, modelEmit: x.modelEmit, minPrecision: ratio(x.minPrecision, 'minPrecision'), minRecall: ratio(x.minRecall, 'minRecall') };
      }
      case 'event-order': {
        checkKeys(x, ['id', 'kind', 'required', 'text', 'first', 'then', 'by'], where);
        return { ...base, first: str(x.first, where + '.first', '"first"'), then: str(x.then, where + '.then', '"then"'), by: selector(x.by == null ? 'subject' : x.by, where + '.by', OBS_SEL, '"by"') };
      }
      case 'response-before': {
        checkKeys(x, ['id', 'kind', 'required', 'text', 'request', 'response', 'withinMs', 'by'], where);
        if (typeof x.withinMs !== 'number' || !(x.withinMs >= 0) || x.withinMs > MAX_WITHIN_MS) throw err('E_MAPPING_SCHEMA', `"withinMs" must be a number from 0 to ${MAX_WITHIN_MS} (milliseconds)`, where + '.withinMs', null);
        return { ...base, request: str(x.request, where + '.request', '"request"'), response: str(x.response, where + '.response', '"response"'), withinMs: x.withinMs, by: selector(x.by == null ? 'subject' : x.by, where + '.by', OBS_SEL, '"by"') };
      }
      case 'never-observed': {
        checkKeys(x, ['id', 'kind', 'required', 'text', 'observedKind', 'when'], where);
        return { ...base, observedKind: str(x.observedKind, where + '.observedKind', '"observedKind"'), when: whenFilter(x.when, where + '.when', noteAttr) };
      }
      default: return base;
    }
  });
  assertions.forEach((a) => { if (a.by) noteAttr(a.by); });

  const allowUnknownObserved = raw.allowUnknownObserved == null ? true : raw.allowUnknownObserved;
  if (typeof allowUnknownObserved !== 'boolean') throw err('E_MAPPING_SCHEMA', '"allowUnknownObserved" must be true or false', 'allowUnknownObserved', null);
  const knownKinds = new Set([...inputs.map((x) => x.observedKind), ...outputs.map((x) => x.observedKind)]);
  for (const a of assertions) for (const k of [a.first, a.then, a.request, a.response, a.observedKind]) if (k) knownKinds.add(k);
  return {
    schemaVersion: 1, msPerUnit, dtMs, timeOrigin, toleranceMs: tol, replayMode: 'replace-inputs',
    internalEvents: [...internal], allowUnknownObserved, keepAttrs: [...keepAttrs].sort(),
    inputs, outputs, assertions, knownKinds,
  };
}

function whenFilter(v, where, noteAttr) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw err('E_MAPPING_SCHEMA', '"when" must be an object of selector: value pairs', where, 'write "when": { "attrs.outcome": "error" }');
  const out = [];
  for (const [k, val] of Object.entries(v)) {
    selector(k, where, OBS_SEL, 'a "when" key');
    if (k.startsWith('literal:')) throw err('E_MAPPING_SELECTOR', 'a "when" key cannot be a literal', where, null);
    if (val !== null && !['string', 'number', 'boolean'].includes(typeof val)) throw err('E_MAPPING_SCHEMA', '"when" values must be strings, numbers, true/false or null', where, null);
    noteAttr(k);
    out.push([k, val]);
  }
  return out.length ? out : null;
}

// Read an observed selector from a normalized event. Returns a string or null.
export function observedValue(sel, e) {
  if (sel == null) return null;
  if (sel === 'subject') return e.subject == null ? null : String(e.subject);
  if (sel.startsWith('attrs.')) {
    const v = e.attrs ? e.attrs[sel.slice(6)] : undefined;
    return v == null ? null : String(v);
  }
  if (sel.startsWith('literal:')) return sel.slice(8);
  return null;
}

export function matchesWhen(when, e) {
  if (!when) return true;
  for (const [k, val] of when) {
    if (k === 'subject') { if ((e.subject == null ? null : e.subject) !== (val == null ? null : String(val))) return false; continue; }
    const v = e.attrs ? e.attrs[k.slice(6)] : undefined;
    if ((v === undefined ? null : v) !== val) return false;
  }
  return true;
}

// The input entry an observed event drives, or null.
export function inputFor(mapping, e) {
  for (const x of mapping.inputs) if (x.observedKind === e.kind && matchesWhen(x.when, e)) return x;
  return null;
}

// What trace import needs from a mapping without a model: the attribute
// allowlist (every attrs.<key> a selector reads, plus keepAttrs) and the
// observed kinds it knows (for --strict).
export function importHints(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw err('E_MAPPING_SCHEMA', 'the mapping must be a JSON object', null, null);
  if (raw.schemaVersion !== 1) throw err('E_MAPPING_SCHEMA', `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}; expected 1`, 'schemaVersion', 'set "schemaVersion": 1');
  const attrs = new Set(Array.isArray(raw.keepAttrs) ? raw.keepAttrs.filter((k) => typeof k === 'string') : []);
  const kinds = new Set();
  const sel = (s) => { if (typeof s === 'string' && s.startsWith('attrs.')) attrs.add(s.slice(6)); };
  const list = (v) => (Array.isArray(v) ? v : []);
  for (const x of list(raw.inputs)) { if (x && typeof x === 'object') { kinds.add(x.observedKind); sel(x.subjectFrom); if (x.when && typeof x.when === 'object') Object.keys(x.when).forEach(sel); } }
  for (const x of list(raw.outputs)) { if (x && typeof x === 'object') { kinds.add(x.observedKind); sel(x.observedSubjectFrom); } }
  for (const a of list(raw.assertions)) {
    if (!a || typeof a !== 'object') continue;
    for (const k of [a.first, a.then, a.request, a.response, a.observedKind]) if (typeof k === 'string') kinds.add(k);
    sel(a.by);
    if (a.when && typeof a.when === 'object') Object.keys(a.when).forEach(sel);
  }
  kinds.delete(undefined);
  return { allowAttrs: attrs, knownKinds: kinds };
}
