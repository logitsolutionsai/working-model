// Explanation CI: the aggregate report and its serializations (JSON,
// Markdown for a pull request summary, JUnit XML for CI systems).
// Every gate threshold comes from the config and is printed with the
// result; nothing is loosened silently. Pure module: no Node APIs.

export const CI_DEFAULTS = {
  claims: { required: true },
  mutation: { enabled: false, minScore: 0 },
  fuzz: { enabled: false, cases: 100, seed: 1, strict: false },
  reality: { enabled: true, strictObserved: false },
  parity: { enabled: false },
};

// status of one check: pass | fail | inconclusive | skipped | error
export function gateOf(check) {
  return check.status === 'fail' || check.status === 'error' ? 'fail' : 'ok';
}

export function aggregate(models) {
  const counts = { pass: 0, fail: 0, inconclusive: 0, skipped: 0, error: 0 };
  for (const m of models) for (const c of m.checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const failed = models.some((m) => m.checks.some((c) => gateOf(c) === 'fail'));
  return { status: failed ? 'fail' : counts.inconclusive ? 'pass-with-inconclusive' : 'pass', counts };
}

// Differences against a previous CI report (for example from the base branch).
export function diffAgainst(base, models) {
  if (!base || !Array.isArray(base.models)) return null;
  const byFile = new Map(base.models.map((m) => [m.file, m]));
  const out = [];
  for (const m of models) {
    const b = byFile.get(m.file);
    if (!b) { out.push({ file: m.file, change: 'model added' }); continue; }
    const d = m.digests || {};
    const bd = b.digests || {};
    if (d.claims !== bd.claims) out.push({ file: m.file, change: 'claim text or expressions changed' });
    if (d.rules !== bd.rules) out.push({ file: m.file, change: 'model rules changed' });
    if (d.mapping !== bd.mapping) out.push({ file: m.file, change: 'trace mapping changed' });
    if (d.trace !== bd.trace) out.push({ file: m.file, change: 'observed trace changed' });
    if ((m.counterexample || null) !== (b.counterexample || null)) out.push({ file: m.file, change: 'counterexample changed' });
    const bc = new Map((b.checks || []).map((c) => [c.name, c.status]));
    for (const c of m.checks) if (bc.has(c.name) && bc.get(c.name) !== c.status) out.push({ file: m.file, change: `${c.name}: ${bc.get(c.name)} -> ${c.status}` });
    byFile.delete(m.file);
  }
  for (const f of byFile.keys()) out.push({ file: f, change: 'model removed' });
  return out;
}

function mdEscape(s) {
  return String(s == null ? '' : s).replace(/[|\\`*_<>[\]]/g, (c) => '\\' + c).replace(/\r?\n/g, ' ');
}

export function toMarkdown(rep) {
  const L = [];
  L.push('## Working Model Explanation CI');
  L.push('');
  L.push(`Status: **${rep.status}**. ${rep.counts.pass} checks pass, ${rep.counts.fail} fail, ${rep.counts.inconclusive} inconclusive, ${rep.counts.skipped} skipped, ${rep.counts.error} errors. Engine ${mdEscape(rep.engineVersion)}.`);
  L.push('');
  L.push('| Model | Check | Status | Detail |');
  L.push('| --- | --- | --- | --- |');
  for (const m of rep.models) for (const c of m.checks) L.push(`| ${mdEscape(m.file)} | ${mdEscape(c.name)} | ${mdEscape(c.status)} | ${mdEscape(c.detail)} |`);
  const cx = rep.models.filter((m) => m.firstMismatch);
  if (cx.length) {
    L.push('');
    L.push('### Observed Counterexamples');
    for (const m of cx) {
      const f = m.firstMismatch;
      L.push(`- ${mdEscape(m.file)}: ${mdEscape(f.type)} at ${mdEscape(f.atMs)} ms (assertion ${mdEscape(f.assertionId)}; events ${mdEscape((f.relatedEventIds || []).join(', '))}): ${mdEscape(f.cause)}`);
    }
  }
  const asm = rep.models.filter((m) => m.assumptions && m.assumptions.length);
  if (asm.length) {
    L.push('');
    L.push('### Explicit Assumptions');
    for (const m of asm) for (const a of m.assumptions) L.push(`- ${mdEscape(m.file)} (${mdEscape(a.scope || 'model')}): ${mdEscape(a.text)}`);
  }
  if (rep.changes) {
    L.push('');
    L.push('### Changes Against The Base Report');
    if (!rep.changes.length) L.push('- No model, mapping, trace or result changed.');
    for (const c of rep.changes) L.push(`- ${mdEscape(c.file)}: ${mdEscape(c.change)}`);
    L.push('');
    L.push('A text change is not a behaviour change: the statuses above are what was checked.');
  }
  L.push('');
  L.push('### Reproduce');
  L.push('');
  L.push('```bash');
  for (const m of rep.models) for (const cmd of m.reproduce || []) L.push(cmd);
  L.push('```');
  L.push('');
  L.push('Executable explanations with trace evidence: model claims are about the simulation, observed assertions about the recorded trace only. This is not formal verification or a security certification.');
  return L.join('\n') + '\n';
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function toJUnit(rep) {
  const L = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const total = rep.models.reduce((n, m) => n + m.checks.length, 0);
  const fails = rep.models.reduce((n, m) => n + m.checks.filter((c) => gateOf(c) === 'fail').length, 0);
  const skipped = rep.models.reduce((n, m) => n + m.checks.filter((c) => c.status === 'skipped' || c.status === 'inconclusive').length, 0);
  L.push(`<testsuites name="working-model ci" tests="${total}" failures="${fails}" skipped="${skipped}">`);
  for (const m of rep.models) {
    const f = m.checks.filter((c) => gateOf(c) === 'fail').length;
    const s = m.checks.filter((c) => c.status === 'skipped' || c.status === 'inconclusive').length;
    L.push(`  <testsuite name="${xmlEscape(m.file)}" tests="${m.checks.length}" failures="${f}" skipped="${s}">`);
    for (const c of m.checks) {
      L.push(`    <testcase classname="${xmlEscape(m.file)}" name="${xmlEscape(c.name)}">`);
      if (gateOf(c) === 'fail') L.push(`      <failure message="${xmlEscape(c.detail)}" type="${xmlEscape(c.status)}">${xmlEscape(c.detail)}</failure>`);
      else if (c.status === 'skipped' || c.status === 'inconclusive') L.push(`      <skipped message="${xmlEscape(c.status + ': ' + c.detail)}"/>`);
      L.push('    </testcase>');
    }
    L.push('  </testsuite>');
  }
  L.push('</testsuites>');
  return L.join('\n') + '\n';
}
