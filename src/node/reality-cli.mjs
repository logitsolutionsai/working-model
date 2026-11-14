// CLI glue for the Reality Bridge commands. Errors print as
// { code, message, location, fix } with --json.

import path from 'node:path';
import { RX, exitFor, importTrace, checkWithTrace, writeReport, writeText, formatRealityReport, traceErrorJSON, canonicalPretty } from './reality.mjs';
import { formatReport, color } from './check.mjs';

export function printError(e, args, c) {
  const j = traceErrorJSON(e);
  if (args.json) console.log(JSON.stringify({ ok: false, error: j }, null, 2));
  else {
    process.stderr.write(`${c.red(j.code)} ${j.message}${j.location ? c.dim(`  (${j.location})`) : ''}\n`);
    if (j.fix) process.stderr.write(c.dim(`  fix: ${j.fix}\n`));
    if (e && e.report) process.stderr.write(formatReport(e.report, color(false)) + '\n');
  }
  return e && e.exit != null ? e.exit : exitFor(e);
}

export async function traceCommand(args, c) {
  const sub = args._[1];
  if (sub !== 'import') {
    process.stderr.write('usage: working-model trace import <trace.jsonl|otlp.json> [--mapping trace-map.json] [--out trace.normalized.json] [--complete] [--json]\n');
    return RX.USAGE;
  }
  const file = args._[2];
  if (!file) { process.stderr.write('trace import needs a trace file\n'); return RX.USAGE; }
  try {
    const { trace, summary } = await importTrace(file, {
      mapping: args.mapping, complete: !!args.complete, strict: !!args.strict, origin: args.origin,
      maxEvents: args.maxEvents, maxBytes: args.maxBytes, format: args.format, keepAttrs: args.keepAttr,
      kindAttribute: args.kindAttribute, subjectAttribute: args.subjectAttribute,
    });
    const out = args.out || path.join('.working-model', 'trace.normalized.json');
    writeText(out, canonicalPretty(trace));
    summary.out = out;
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`${c.green('imported')} ${summary.events} events (${summary.format}) -> ${out}`);
      console.log(c.dim(`  completeness ${summary.completeness}; source ${summary.sourceDigest}`));
      for (const [k, v] of Object.entries(summary.kinds)) console.log(`  ${String(v.count).padStart(6)}  ${k}${v.mapped === false ? c.yellow('  (not in the mapping)') : ''}`);
      if (summary.keptAttrs.length) console.log(c.dim(`  attributes kept: ${summary.keptAttrs.join(', ')}`));
      for (const w of summary.warnings) console.log(`  ${c.yellow(w.code)} ${w.message}`);
    }
    return RX.OK;
  } catch (e) {
    return printError(e, args, c);
  }
}

export async function checkTraceCommand(args, c, params) {
  const spec = args._[1];
  if (!spec) { process.stderr.write('check --trace needs a spec file\n'); return RX.USAGE; }
  try {
    const { report, check } = checkWithTrace(spec, { trace: args.trace, mapping: args.mapping, strictObserved: !!args.strictObserved, params, probe: !args.noProbe });
    const file = args.report || path.join('.working-model', 'reality-report.json');
    writeReport(file, report);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      if (check.passed !== check.total) console.log(formatReport(check, c) + '\n');
      console.log(formatRealityReport(report, c));
      console.log(c.dim(`  report ${file}`));
    }
    return report.exit;
  } catch (e) {
    return printError(e, args, c);
  }
}

// `build --trace`: the comparison page. Model claims must pass (or --force),
// as for a normal build; failing observed assertions are shown, not refused.
export async function buildTraceCommand(args, c, version) {
  const spec = args._[1];
  if (!spec) { process.stderr.write('build --trace needs a spec file\n'); return RX.USAGE; }
  try {
    const { writeRealityPage } = await import('./build-reality.mjs');
    const { report, check, trace, files } = checkWithTrace(spec, { trace: args.trace, mapping: args.mapping, probe: false });
    if (report.modelClaims.status !== 'pass' && !args.force) {
      console.error(formatReport(check, c));
      console.error(c.red('\nNot building: the model claims must pass before the page compares the model with a trace (or pass --force).'));
      return RX.FAIL;
    }
    if (report.status === 'error') {
      console.error(formatRealityReport(report, c));
      return report.exit;
    }
    const { readJSONFile } = await import('./reality.mjs');
    const rawMapping = readJSONFile(files.mappingFile, 'the mapping');
    const out = args.out || spec.replace(/\.model\.json$/, '').replace(/\.json$/, '') + '.reality.html';
    const w = writeRealityPage(check.spec, { trace, mapping: rawMapping, report }, out, { version });
    const oa = report.observedAssertions;
    console.log(`${c.green('built')} ${w.file} (${Math.round(w.bytes / 1024)} KB, offline, model ${report.modelClaims.passed}/${report.modelClaims.total} claims pass, observed ${oa.passed} pass, ${oa.failed} fail, ${oa.inconclusive} inconclusive)`);
    return RX.OK;
  } catch (e) {
    return printError(e, args, c);
  }
}
