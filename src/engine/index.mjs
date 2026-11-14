// Engine entry point. The same modules run in Node (check, build) and are
// inlined into every built page, so a claim that passes in the terminal
// passes in the browser for the same reason.

import { compileModel } from './model.mjs';
import { checkClaims } from './claims.mjs';
import { lintModel, probeParams } from './lint.mjs';

export const ENGINE_VERSION = '0.1.0';

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

// Compile, simulate at the given params (defaults when omitted), check every
// claim, probe the sliders, and lint. Never throws for model problems; they
// come back in errors.
export function analyze(spec, opts = {}) {
  const t0 = nowMs();
  const { model, errors, warnings } = compileModel(spec);
  const report = {
    ok: false, stage: 'compile', errors, warnings: warnings.slice(), lint: [],
    results: [], passed: 0, total: 0, probes: [], ticks: model ? model.K : 0, ms: 0, model: null,
  };
  if (errors.length) { report.ms = nowMs() - t0; return report; }
  report.model = model;
  const res = checkClaims(model, opts.params);
  report.stage = 'simulate';
  if (res.trace.error) {
    report.errors = [res.trace.error];
    report.ms = nowMs() - t0;
    return report;
  }
  report.stage = 'claims';
  report.results = res.results;
  report.passed = res.passed;
  report.total = res.total;
  report.trace = res.trace;
  report.probes = opts.probe === false ? [] : probeParams(model);
  // lint always judges the default params, even when a what-if run used others
  const atDefaults = opts.params && Object.keys(opts.params).length ? checkClaims(model, {}) : res;
  report.lint = lintModel(model, atDefaults, { probes: opts.probe === false ? null : report.probes });
  const lintErrors = report.lint.filter((i) => i.severity === 'error');
  report.ok = res.passed === res.total && lintErrors.length === 0;
  report.ms = nowMs() - t0;
  return report;
}
