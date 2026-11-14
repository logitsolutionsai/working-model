// The public projection of a comparison or a simulated counterexample.
// Built by allowlist: every key written is named here, and nothing from a
// trace passes through except event kinds the mapping names, relative time
// buckets and counts. No subjects, attributes, event ids, timestamps, file
// paths, commands, URLs from a trace, or literal correlation values.
// Pure module: no Node or browser APIs.

const BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000, 600000, 1800000, 3600000, 21600000, 86400000];

export function bucketSize(spanMs) {
  for (const b of BUCKETS_MS) if (spanMs / b <= 50) return b;
  return BUCKETS_MS[BUCKETS_MS.length - 1];
}

function bucketLabel(ms, size) {
  const lo = Math.floor(ms / size) * size;
  const fmt = (x) => (size >= 1000 ? `${Math.round(x / 100) / 10} s` : `${x} ms`);
  return `${fmt(lo)} to ${fmt(lo + size)}`;
}

// Text written by the mapping author can still name a customer in a
// literal correlation value; replace those.
function scrub(text) {
  if (text == null) return null;
  return String(text).replace(/literal:[^\s"')]+/g, 'literal:<redacted>').slice(0, 400);
}

// report: from check --trace; run outputs: report.outputs (counts only);
// timeline: [{ kind, lane, timeMs }] of mapped outputs (built by the caller
// from the evaluation, never from raw records).
export function projectObserved(report, timeline, model) {
  const spanMs = timeline.reduce((m, e) => Math.max(m, e.timeMs), 0) || 1;
  const size = bucketSize(spanMs);
  const counts = new Map();
  for (const e of timeline) {
    const key = `${e.lane}|${e.kind}|${Math.floor(e.timeMs / size)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const rows = [...counts.entries()].map(([k, n]) => {
    const [lane, kind, b] = k.split('|');
    return { lane, kind, bucket: bucketLabel(Number(b) * size, size), bucketIndex: Number(b), count: n };
  }).sort((a, b) => a.bucketIndex - b.bucketIndex || (a.lane < b.lane ? -1 : 1) || (a.kind < b.kind ? -1 : 1));
  const fm = report.firstMismatch;
  return {
    schemaVersion: 1,
    kind: 'working-model-public-evidence',
    evidenceType: 'observed',
    model: { title: String(model.title).slice(0, 200), modelDigest: report.modelDigest },
    engineVersion: report.engineVersion,
    verificationVersion: report.verificationVersion,
    status: report.status,
    completeness: report.completeness,
    modelClaims: { passed: report.modelClaims.passed, total: report.modelClaims.total, status: report.modelClaims.status },
    observedAssertions: {
      passed: report.observedAssertions.passed, failed: report.observedAssertions.failed, inconclusive: report.observedAssertions.inconclusive,
      results: report.observedAssertions.results.map((a) => ({
        id: a.id, kind: a.kind, status: a.status, required: a.required,
        test: scrub(a.test), inconclusiveReason: scrub(a.inconclusiveReason),
        firstFailure: a.firstFailure ? { type: a.firstFailure.type, bucket: bucketLabel(a.firstFailure.atMs - (report.replay ? report.replay.originMs : 0), size), expectedKind: a.firstFailure.expectedKind, observedKind: a.firstFailure.observedKind } : null,
      })),
    },
    firstMismatch: fm ? {
      assertionId: fm.assertionId, type: fm.type, bucket: bucketLabel(fm.atMs - (report.replay ? report.replay.originMs : 0), size),
      expectedKind: fm.expectedKind, observedKind: fm.observedKind, cause: scrub(fm.cause),
    } : null,
    coverage: {
      observedEvents: report.coverage.observedEvents, inputMapped: report.coverage.inputMapped, outputMapped: report.coverage.outputMapped,
      observedUnmapped: report.coverage.observedUnmapped, modelOutputs: report.coverage.modelOutputs, uncorrelated: report.coverage.uncorrelated,
    },
    timeline: { bucketMs: size, rows: rows.map(({ bucketIndex, ...r }) => r) },
    assumptions: (report.assumptions || []).map((a) => ({ id: a.id, text: String(a.text).slice(0, 400), scope: a.scope || 'model' })),
    note: 'A public projection: event kinds the mapping names, relative time buckets and counts. No subjects, attributes, event ids, timestamps or file paths. Executable explanations with trace evidence, not formal verification.',
  };
}

export function projectSimulated(cx, model) {
  return {
    schemaVersion: 1,
    kind: 'working-model-public-evidence',
    evidenceType: 'simulated',
    model: { title: String(model.title).slice(0, 200), modelDigest: cx.modelDigest },
    engineVersion: cx.engineVersion,
    generator: cx.generator,
    seed: cx.seed,
    caseIndex: cx.caseIndex,
    modelSeed: cx.modelSeed,
    params: cx.params,
    events: (cx.events || []).map((e) => ({ index: e.index, name: e.name, ...(e.omit ? { omit: true } : {}), ...(e.count != null ? { count: e.count } : {}), ...(e.shift ? { shift: e.shift } : {}) })),
    failure: { claimId: cx.failure.claimId, firstTick: cx.failure.firstTick, line: cx.failure.line || null },
    shrink: cx.shrink || null,
    note: 'A simulated counterexample: the model, not an observed system, fails this claim under these conditions. Executable explanations with trace evidence, not formal verification.',
  };
}

// Every key path in a value, for the preview.
export function keyPaths(v, prefix = '', out = new Set()) {
  if (Array.isArray(v)) { for (const x of v) keyPaths(x, prefix + '[]', out); return out; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) { out.add(prefix ? `${prefix}.${k}` : k); keyPaths(v[k], prefix ? `${prefix}.${k}` : k, out); } }
  return out;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A static page: no scripts at all, a CSP that allows nothing but inline style.
export function evidenceHtml(ev) {
  const rows = (cells) => cells.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('\n');
  const chip = (status) => `<span class="chip ${status === 'fail' ? 'l3' : status === 'pass' ? 'l1' : 'l0'}">${status === 'fail' ? '&#10005; ' : status === 'pass' ? '&#10003; ' : ''}${esc(status)}</span>`;
  let body = '';
  if (ev.evidenceType === 'observed') {
    const oa = ev.observedAssertions;
    body += `<p class="line">Model: ${esc(ev.modelClaims.passed)}/${esc(ev.modelClaims.total)} claims pass | Observed: ${esc(oa.passed)} pass, ${esc(oa.failed)} fail, ${esc(oa.inconclusive)} inconclusive ${chip(ev.status)}</p>
<p>Completeness: ${esc(ev.completeness)}. The claims are about the model; the observed assertions are about one recorded trace, read through a mapping.</p>`;
    if (ev.firstMismatch) {
      const m = ev.firstMismatch;
      body += `<h2>First Mismatch</h2><table>${rows([['Assertion', m.assertionId], ['Type', m.type], ['When', m.bucket], ['Expected', m.expectedKind || 'nothing'], ['Observed', m.observedKind || 'nothing'], ['Cause', m.cause]])}</table>`;
    }
    body += `<h2>Observed Assertions</h2><ul>${oa.results.map((a) => `<li>${chip(a.status)} <code>${esc(a.id)}</code> ${esc(a.test || '')}${a.inconclusiveReason ? ` <em>${esc(a.inconclusiveReason)}</em>` : ''}</li>`).join('')}</ul>`;
    body += `<h2>Timeline (Counts Per ${esc(ev.timeline.bucketMs >= 1000 ? ev.timeline.bucketMs / 1000 + ' s' : ev.timeline.bucketMs + ' ms')})</h2><div class="wrap"><table><thead><tr><th>When</th><th>Lane</th><th>Kind</th><th>Count</th></tr></thead><tbody>${rows(ev.timeline.rows.map((r) => [r.bucket, r.lane, r.kind, r.count]))}</tbody></table></div>`;
    body += `<h2>Coverage</h2><table>${rows(Object.entries(ev.coverage))}</table>`;
    if (ev.assumptions.length) body += `<h2>What The Model Assumed</h2><ul>${ev.assumptions.map((a) => `<li><code>${esc(a.scope)}</code> ${esc(a.text)}</li>`).join('')}</ul>`;
  } else {
    body += `<p class="line">Simulated counterexample for claim <code>${esc(ev.failure.claimId)}</code></p><p>${esc(ev.failure.line || '')}</p>`;
    body += `<h2>Conditions</h2><table>${rows(Object.entries(ev.params).map(([k, v]) => [k, v]))}</table>`;
    body += `<h2>Event Changes</h2><ul>${ev.events.length ? ev.events.map((e) => `<li>${esc(e.name)} (entry ${esc(e.index)})${e.omit ? ' omitted' : ''}${e.count != null ? ' count ' + esc(e.count) : ''}${e.shift ? ' shifted by ' + esc(e.shift) : ''}</li>`).join('') : '<li>none: the spec schedule</li>'}</ul>`;
    body += `<p>Fuzz seed ${esc(ev.seed)} (${esc(ev.generator)}), case ${esc(ev.caseIndex)}, model seed ${esc(ev.modelSeed)}.</p>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${esc(ev.model.title)} - evidence</title>
<style>
:root { color-scheme: light; --bg: #f7f7f5; --surface: #ffffff; --surface-2: #f0f0ed; --line: #e3e3df; --line-strong: #c9c9c3; --ink: #111110; --ink-2: #3a3a37; --muted: #6f6f69; --faint: #a3a39c; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --bg: #0e0e0d; --surface: #171716; --surface-2: #1f1f1d; --line: #2b2b29; --line-strong: #3d3d3a; --ink: #f4f4f2; --ink-2: #d6d6d2; --muted: #9a9a94; --faint: #6a6a65; } }
body { margin: 0; background: var(--bg); color: var(--ink-2); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { margin: 6px 0 8px; color: var(--ink); font: 600 clamp(24px, 4vw, 34px)/1.15 "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; }
h2 { margin: 28px 0 8px; color: var(--ink); font-size: 17px; }
.kicker { font: 600 11px/1 ui-monospace, Consolas, monospace; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
.line { font-weight: 600; color: var(--ink); }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.chip.l3 { background: var(--ink); color: var(--bg); }
.chip.l1 { background: var(--surface-2); color: var(--muted); }
.chip.l0 { border: 1px dashed var(--line-strong); color: var(--faint); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
td, th { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.wrap { overflow-x: auto; }
code { font: 13px ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
.note { margin-top: 32px; font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
<div class="kicker">Working model evidence</div>
<h1>${esc(ev.model.title)}</h1>
${body}
<p class="note">${esc(ev.note)} Model digest <code>${esc(ev.model.modelDigest)}</code>. The SHA-256 values in manifest.json prove which bytes were packaged, not that they are true.</p>
</main>
</body>
</html>
`;
}
