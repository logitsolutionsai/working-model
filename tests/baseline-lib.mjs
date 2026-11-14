// Baseline guarantee for the existing examples.
//
// computeBaseline() records, for every example in examples/ (not its
// subfolders), what must never change when the engine grows new features:
//   - the whole `check --json` report (timings removed),
//   - a digest of the default run (every snapshot, emit and firing),
//   - the `check --mutate --json` report (timings removed),
//   - the SHA-256 of the gallery page `gallery` writes for it.
// tests/fixtures/baseline/golden.json holds the values frozen before the
// Reality Bridge work started; tests/baseline.test.mjs compares against it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkFile, listSpecFiles, reportToJSON, mutationJSON } from '../src/node/check.mjs';
import { renderPage } from '../src/node/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
export const GOLDEN_FILE = path.join(HERE, 'fixtures', 'baseline', 'golden.json');

function sha(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Drop wall-clock fields; everything else must match exactly.
function withoutTimings(v) {
  if (Array.isArray(v)) return v.map(withoutTimings);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) if (k !== 'ms') out[k] = withoutTimings(v[k]);
    return out;
  }
  return v;
}

function relFile(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

export function traceDigest(trace) {
  const body = JSON.stringify({ K: trace.K, snaps: trace.snaps, emits: trace.emits, fired: trace.fired, error: trace.error ? trace.error.code : null });
  return sha(body);
}

export function computeBaseline(opts = {}) {
  const examples = path.join(ROOT, 'examples');
  const out = {};
  for (const file of listSpecFiles(examples)) {
    const name = path.basename(file).replace(/\.model\.json$/, '');
    const r = checkFile(file, {});
    const check = withoutTimings(JSON.parse(JSON.stringify(reportToJSON({ ...r, file: relFile(file) }))));
    const entry = { check: sha(JSON.stringify(check)), trace: r.trace ? traceDigest(r.trace) : null };
    if (opts.mutation !== false) {
      const m = checkFile(file, { probe: false, mutate: {} });
      const mj = m.mutation ? withoutTimings(JSON.parse(JSON.stringify(mutationJSON(m.mutation)))) : null;
      entry.mutation = mj ? sha(JSON.stringify(mj)) : null;
      entry.mutationScore = mj && mj.ok ? mj.scorePercent : null;
      const mutation = m.mutation && m.mutation.ok ? m.mutation : null;
      entry.galleryPage = sha(renderPage(m.spec, { mutation }));
    }
    out[name] = entry;
  }
  return out;
}
