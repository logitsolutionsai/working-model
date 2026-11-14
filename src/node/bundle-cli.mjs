// `bundle --public`: a conservative, allowlisted projection for publishing.
// It refuses an observed trace unless the user says it is synthetic
// (--synthetic) or has reviewed what is shared (--acknowledge-privacy), and
// it prints every key it will write before writing.

import path from 'node:path';
import { RX, sha256, readJSONFile, writeText, checkWithTrace, digestOf } from './reality.mjs';
import { printError } from './reality-cli.mjs';
import { checkFile } from './check.mjs';
import { TraceError, canonicalPretty } from '../trace/errors.mjs';
import { projectObserved, projectSimulated, evidenceHtml, keyPaths } from '../evidence/bundle.mjs';

export function makeBundle(spec, opts) {
  if (!opts.public) throw new TraceError('E_USAGE', 'bundle writes public evidence only; pass --public to confirm', '--public', 'add --public');
  if (opts.case) {
    const r = checkFile(spec, { probe: false });
    if (r.errors.length) throw new TraceError(r.errors[0].code, `the model is invalid: ${r.errors[0].message}`, spec, 'run check');
    const cx = readJSONFile(opts.case, 'the case');
    if (cx.kind !== 'working-model-counterexample') throw new TraceError('E_CASE_SCHEMA', 'not a working-model counterexample', opts.case, 'pass a file written by fuzz or minimize');
    if (cx.modelDigest !== digestOf(r.spec)) throw new TraceError('E_CASE_MODEL', 'the case was written for a different version of this model', opts.case, 'run fuzz again');
    return projectSimulated(cx, r.model);
  }
  if (!opts.trace) throw new TraceError('E_USAGE', 'bundle needs --case <counterexample.json>, or --trace with --mapping', null, null);
  if (!opts.synthetic && !opts.acknowledgePrivacy) {
    throw new TraceError('E_PRIVACY_ACK', 'refusing to bundle an observed trace that is not marked synthetic', '--trace',
      'pass --synthetic if the trace is generated, or review the projection with --preview and pass --acknowledge-privacy');
  }
  const { report, check, outputs } = checkWithTrace(spec, { trace: opts.trace, mapping: opts.mapping, probe: false });
  const timeline = [];
  if (outputs) {
    for (const o of outputs.values()) {
      for (const x of o.observed) timeline.push({ lane: 'observed', kind: o.output.observedKind, timeMs: x.timeMs - report.replay.originMs });
      for (const x of o.expected) timeline.push({ lane: 'simulated', kind: o.output.observedKind, timeMs: x.timeMs - report.replay.originMs });
    }
  }
  const ev = projectObserved(report, timeline.filter((e) => e.timeMs >= 0), check.model);
  ev.synthetic = !!opts.synthetic;
  return ev;
}

export async function bundleCommand(args, c) {
  const spec = args._[1];
  if (!spec) { process.stderr.write('bundle needs a spec file\n'); return RX.USAGE; }
  try {
    const ev = makeBundle(spec, { public: !!args.public, case: args.case, trace: args.trace, mapping: args.mapping, synthetic: !!args.synthetic, acknowledgePrivacy: !!args.acknowledgePrivacy });
    const keys = [...keyPaths(ev)].sort();
    const json = canonicalPretty(ev);
    const html = evidenceHtml(ev);
    const outDir = args.out || path.join('.working-model', 'evidence');
    const manifest = {
      schemaVersion: 1, kind: 'working-model-public-bundle', evidenceType: ev.evidenceType,
      files: { 'evidence.json': sha256(json), 'evidence.html': sha256(html) },
      includedKeys: keys,
      note: 'The SHA-256 values prove which bytes were packaged, not that the evidence is true.',
    };
    if (args.preview) {
      if (args.json) console.log(JSON.stringify({ preview: true, includedKeys: keys }, null, 2));
      else { console.log(c.bold('Keys the public bundle would include:')); for (const k of keys) console.log('  ' + k); console.log(c.dim('Nothing was written (--preview).')); }
      return RX.OK;
    }
    writeText(path.join(outDir, 'evidence.json'), json);
    writeText(path.join(outDir, 'evidence.html'), html);
    writeText(path.join(outDir, 'manifest.json'), canonicalPretty(manifest));
    if (args.json) console.log(JSON.stringify({ ok: true, out: outDir, ...manifest }, null, 2));
    else {
      console.log(`${c.green('bundled')} ${ev.evidenceType} evidence -> ${outDir} (evidence.json, evidence.html, manifest.json)`);
      console.log(c.dim(`  ${keys.length} keys included: ${keys.join(', ')}`));
    }
    return RX.OK;
  } catch (e) {
    return printError(e, args, c);
  }
}
