// Node side of the Reality Bridge: files, digests, safe paths and the
// `trace import` and `check --trace` commands. The pure logic lives in
// src/trace/; this module only reads and writes.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkFile } from './check.mjs';
import { TraceError, traceErrorJSON, canonicalJSON, canonicalPretty } from '../trace/errors.mjs';
import { normalizeJsonl, validateNormalized, resolveLimits, TRACE_LIMITS } from '../trace/normalize.mjs';
import { validateMapping, importHints } from '../trace/mapping.mjs';
import { evaluateReality, REALITY_VERSION } from '../trace/conformance.mjs';
import { ENGINE_VERSION } from '../engine/index.mjs';

export const RX = { OK: 0, FAIL: 1, INVALID: 2, RESOURCE: 3, USAGE: 64 };
const RESOURCE_CODES = new Set(['E_READ', 'E_WRITE', 'E_TRACE_TOO_LARGE', 'E_STEP_LIMIT', 'E_TRACE_LIMIT', 'E_REPLAY_LIMIT', 'E_TIMEOUT', 'E_BROWSER']);

export function exitFor(e) {
  return RESOURCE_CODES.has(e && e.code) ? RX.RESOURCE : RX.INVALID;
}

export function sha256(data) {
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

export function digestOf(value) {
  return sha256(canonicalJSON(value));
}

export function readJSONFile(file, what) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new TraceError('E_READ', `cannot read ${what} ${file}: ${e.code || e.message}`, file, 'check the path');
  }
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    throw new TraceError('E_JSON', `${what} is not valid JSON: ${String(e.message).replace(/^.*?:\s*/, '')}`, file, 'fix the JSON');
  }
}

export function writeText(file, text) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, text);
  } catch (e) {
    throw new TraceError('E_WRITE', `cannot write ${file}: ${e.code || e.message}`, file, 'check the folder exists and is writable');
  }
}

// A path written inside a model spec: relative, inside the spec's folder,
// never a URL, never leaving the folder through ".." or a symbolic link.
export function resolveSpecPath(specFile, rel, where) {
  if (typeof rel !== 'string' || !rel) throw new TraceError('E_REALITY_PATH', 'expected a relative file path', where, null);
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel) && !/^[a-z]:[\\/]/i.test(rel)) throw new TraceError('E_REALITY_PATH', `"${rel}" is a URL; a spec can only name local files next to it`, where, 'save the file next to the spec and name it with a relative path');
  if (path.isAbsolute(rel)) throw new TraceError('E_REALITY_PATH', `"${rel}" is an absolute path; a spec can only name files inside its own folder`, where, 'use a path relative to the spec');
  const base = path.resolve(path.dirname(specFile));
  const full = path.resolve(base, rel);
  const inside = (p, b) => { const r = path.relative(b, p); return r && !r.startsWith('..') && !path.isAbsolute(r); };
  if (!inside(full, base)) throw new TraceError('E_REALITY_PATH', `"${rel}" leaves the spec's folder`, where, 'keep the file in the spec folder or below it');
  if (fs.existsSync(full)) {
    const real = fs.realpathSync(full);
    if (!inside(real, fs.realpathSync(base))) throw new TraceError('E_REALITY_PATH', `"${rel}" is a link that leaves the spec's folder`, where, 'copy the file into the folder instead of linking it');
  }
  return full;
}

// ---- trace import --------------------------------------------------------

export async function importTrace(file, opts = {}) {
  const limits = resolveLimits(opts);
  let st;
  try { st = fs.statSync(file); } catch (e) {
    throw new TraceError('E_READ', `cannot read ${file}: ${e.code || e.message}`, file, 'check the path');
  }
  if (st.size > limits.maxBytes) {
    throw new TraceError('E_TRACE_TOO_LARGE', `the trace is ${st.size} bytes, above the limit of ${limits.maxBytes}`, file, `import a smaller window, or pass --max-bytes up to ${TRACE_LIMITS.hardBytes}`);
  }
  const buf = fs.readFileSync(file);
  const sourceDigest = sha256(buf);
  const text = buf.toString('utf8');
  let hints = { allowAttrs: new Set(), knownKinds: null };
  if (opts.mapping) hints = importHints(readJSONFile(opts.mapping, 'the mapping'));
  for (const k of opts.keepAttrs || []) hints.allowAttrs.add(k);
  const format = opts.format || (/\.json$/i.test(file) && !/\.jsonl$/i.test(file) ? 'otlp' : 'jsonl');
  let trace;
  const common = { allowAttrs: hints.allowAttrs, knownKinds: hints.knownKinds, strict: !!opts.strict, complete: !!opts.complete, origin: opts.origin || null, maxEvents: limits.maxEvents, maxBytes: limits.maxBytes, bytes: buf.length, sourceDigest };
  if (format === 'jsonl') trace = normalizeJsonl(text, common);
  else if (format === 'otlp') {
    const { normalizeOtlp } = await import('../trace/otlp.mjs');
    let doc;
    try { doc = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
      throw new TraceError('E_TRACE_JSON', `the OTLP file is not valid JSON: ${String(e.message).replace(/^.*?:\s*/, '')}`, file, 'export OTLP as JSON (not protobuf)');
    }
    trace = normalizeOtlp(doc, { ...common, kindAttribute: opts.kindAttribute, subjectAttribute: opts.subjectAttribute });
  } else throw new TraceError('E_USAGE', `unknown --format "${format}"`, '--format', 'use jsonl or otlp');
  // the path exactly as given, never resolved: it stays in private metadata only
  trace.private = { sourcePath: String(file).split(path.sep).join('/') };
  const kinds = {};
  for (const e of trace.events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  const known = hints.knownKinds;
  const summary = {
    ok: true, format, events: trace.events.length, completeness: trace.completeness, sourceDigest, traceDigest: traceDigest(trace),
    kinds: Object.fromEntries(Object.keys(kinds).sort().map((k) => [k, { count: kinds[k], mapped: known ? known.has(k) : null }])),
    mapped: known ? trace.events.filter((e) => known.has(e.kind)).length : null,
    unmapped: known ? trace.events.filter((e) => !known.has(e.kind)).length : null,
    keptAttrs: [...hints.allowAttrs].sort(),
    warnings: trace.warnings,
  };
  return { trace, summary };
}

// The digest of a normalized trace covers what replay and matching read:
// never the private block (the local path).
export function traceDigest(trace) {
  return digestOf({ schemaVersion: trace.schemaVersion, completeness: trace.completeness, events: trace.events });
}

export function loadNormalizedTrace(file) {
  const t = validateNormalized(readJSONFile(file, 'the normalized trace'));
  return t;
}

// ---- check --trace ---------------------------------------------------------

export function realityBlock(spec) {
  const r = spec && spec.reality;
  return r && typeof r === 'object' ? r : null;
}

export function checkWithTrace(specFile, opts = {}) {
  const r = checkFile(specFile, { probe: opts.probe !== false, params: opts.params });
  if (r.errors.length) {
    const e = r.errors[0];
    const err = new TraceError(e.code, `the model is invalid: ${e.message}`, e.path || specFile, 'run check without --trace to see every error');
    err.report = r;
    throw err;
  }
  const spec = r.spec;
  const reality = realityBlock(spec);
  const mappingFile = opts.mapping || (reality && reality.mapping ? resolveSpecPath(specFile, reality.mapping, 'reality.mapping') : null);
  if (!mappingFile) throw new TraceError('E_USAGE', 'check --trace needs a mapping', '--mapping', 'pass --mapping trace-map.json, or set "reality.mapping" in the spec');
  const traceFile = opts.trace === true || opts.trace == null ? (reality && reality.observedTrace ? resolveSpecPath(specFile, reality.observedTrace, 'reality.observedTrace') : null) : opts.trace;
  if (!traceFile) throw new TraceError('E_USAGE', 'check --trace needs a normalized trace', '--trace', 'pass --trace trace.normalized.json (made by trace import)');
  const rawMapping = readJSONFile(mappingFile, 'the mapping');
  const mapping = validateMapping(rawMapping, r.model);
  const trace = loadNormalizedTrace(traceFile);
  const { report, run, outputs } = evaluateReality(r.model, trace, mapping, { params: opts.params });
  const lintErrors = (r.lint || []).filter((i) => i.severity === 'error').length;
  const out = {
    schemaVersion: 1,
    kind: 'working-model-reality-report',
    modelDigest: digestOf(spec),
    traceDigest: traceDigest(trace),
    mappingDigest: digestOf(rawMapping),
    engineVersion: ENGINE_VERSION,
    verificationVersion: REALITY_VERSION,
    model: { title: r.model.title, file: path.basename(specFile) },
    status: report.status,
    modelClaims: { passed: r.passed, total: r.total, status: r.passed === r.total && !lintErrors ? 'pass' : 'fail' },
    ...Object.fromEntries(Object.entries(report).filter(([k]) => !['schemaVersion', 'kind', 'verificationVersion', 'status'].includes(k))),
    assumptions: reality && Array.isArray(reality.assumptions) ? reality.assumptions : [],
    sourceRefs: reality && Array.isArray(reality.sourceRefs) ? reality.sourceRefs.map((s) => ({ ...s, kind: s.kind || 'background' })) : [],
    reproduce: [
      `node scripts/working-model.mjs check ${quote(specFile)} --trace ${quote(traceFile)} --mapping ${quote(mappingFile)} --json`,
    ],
  };
  const strict = !!opts.strictObserved;
  let exit = RX.OK;
  if (out.status === 'error') exit = exitFor(report.replay.error);
  else if (out.modelClaims.status !== 'pass' || out.status === 'fail' || (strict && out.status === 'inconclusive')) exit = RX.FAIL;
  out.exit = exit;
  out.strictObserved = strict;
  return { report: out, check: r, run, outputs, mapping, trace, files: { mappingFile, traceFile } };
}

function quote(p) {
  const rel = path.relative(process.cwd(), p) || p;
  const s = rel.split(path.sep).join('/');
  return /[\s"']/.test(s) ? JSON.stringify(s) : s;
}

export function writeReport(file, report) {
  writeText(file, canonicalPretty(report));
}

// One-paragraph text summary for the terminal.
export function formatRealityReport(rep, c) {
  const oa = rep.observedAssertions;
  const lines = [];
  const statusWord = (s) => (s === 'pass' ? c.green('pass') : s === 'fail' ? c.red('fail') : s === 'error' ? c.red('error') : c.yellow('inconclusive'));
  lines.push(c.bold(`${rep.model.title}: model versus observed trace`));
  lines.push(`  Model: ${rep.modelClaims.passed}/${rep.modelClaims.total} claims pass | Observed: ${oa.passed} pass, ${oa.failed} fail, ${oa.inconclusive} inconclusive | status ${statusWord(rep.status)}`);
  lines.push(c.dim(`  completeness ${rep.completeness}; ${rep.replay.inputsReplayed} inputs replayed over ${rep.replay.ticks} ticks of ${rep.replay.dtMs} ms; max quantization ${Math.round(rep.replay.maxQuantizationErrorMs * 1000) / 1000} ms`));
  lines.push(c.dim(`  coverage: ${rep.coverage.inputMapped} input events, ${rep.coverage.outputMapped} output events, ${rep.coverage.observedUnmapped} unmapped, ${rep.coverage.uncorrelated} uncorrelated`));
  if (rep.replay.error) lines.push(c.red(`  replay stopped: ${rep.replay.error.code} ${rep.replay.error.message}`));
  for (const a of oa.results) {
    const why = a.status === 'inconclusive' ? c.dim(`  (${a.inconclusiveReason})`) : a.failedTest ? c.dim(`  (${a.failedTest})`) : '';
    lines.push(`  ${statusWord(a.status).padEnd(a.status === 'inconclusive' ? 12 : 4)}  ${a.id}${a.required ? '' : c.dim(' (not required)')}${why}`);
  }
  if (rep.firstMismatch) {
    const m = rep.firstMismatch;
    lines.push('');
    lines.push(c.bold('  First mismatch'));
    lines.push(`    ${m.type} at ${m.atMs} ms${m.subject != null ? `, subject ${m.subject}` : ''}: ${m.cause}`);
    lines.push(c.dim(`    events: ${m.relatedEventIds.join(', ') || 'none'}; test: ${m.test || ''}`));
  }
  lines.push('');
  lines.push(c.dim('  Observed assertions cover only what the trace recorded. Model claims are checked separately and say nothing about the observed system.'));
  return lines.join('\n');
}

export { traceErrorJSON, canonicalPretty, TraceError };
