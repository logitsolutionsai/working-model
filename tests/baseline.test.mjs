// The existing examples must keep byte-identical results: the check report,
// the default run, the mutation report and the gallery page. The golden file
// was frozen before the Reality Bridge work; never regenerate it to make
// this test pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeBaseline, GOLDEN_FILE } from './baseline-lib.mjs';

test('every existing example keeps its frozen check, run, mutation and gallery page', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8')).examples;
  const now = computeBaseline();
  assert.deepEqual(Object.keys(now).sort(), Object.keys(golden).sort(), 'the set of examples changed');
  for (const name of Object.keys(golden)) {
    for (const key of ['check', 'trace', 'mutation', 'mutationScore', 'galleryPage']) {
      assert.equal(now[name][key], golden[name][key], `${name}: ${key} changed from the frozen baseline`);
    }
  }
});
