#!/usr/bin/env node
// Writes observed.jsonl: a synthetic trace of a client calling a "payments"
// dependency through a circuit breaker. Nothing here comes from a real
// system. The simulated production breaker counts failures over the last 10
// calls (it opens at 5 failures in that window), which is what
// circuit-breaker.model.json assumes it does not do.
//
//   node examples/reality-bridge/make-trace.mjs
//
// The output is deterministic: running it again writes the same bytes.
// Each call record carries attributes a real trace might hold (a client IP
// from the documentation range 203.0.113.0/24, a fake bearer token, an
// e-mail address) so the import can show that they are dropped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WINDOW = 10;
const MIN_FAILURES = 5;
const COOLDOWN_MS = 4000;

function serviceFails(tMs) {
  if (tMs < 5000) return (tMs / 200) % 2 === 1; // every other call fails, never two in a row
  if (tMs < 9000) return true; // outage
  return false;
}

const lines = [];
const push = (rec) => lines.push(JSON.stringify(rec));
let mode = 'closed';
let recent = [];
let openedAt = -Infinity;
let n = 0;
for (let tMs = 200; tMs <= 20000; tMs += 200) {
  n++;
  const subject = 'req-' + String(n).padStart(4, '0');
  const attrs = { route: '/pay', client_ip: '203.0.113.' + (n % 250), authorization: 'Bearer synthetic-token-' + n, customer_email: `user${n}@example.com` };
  if (tMs % 1000 === 0) push({ timeMs: tMs - 1, kind: 'heartbeat', subject: 'client-1', attrs: { pid: 4242 } });
  if (mode === 'open' && tMs - openedAt >= COOLDOWN_MS) mode = 'half-open';
  if (mode === 'open') { push({ timeMs: tMs, kind: 'call_rejected', subject, attrs }); continue; }
  const failed = serviceFails(tMs);
  push({ timeMs: tMs, kind: failed ? 'call_failed' : 'call_succeeded', subject, attrs });
  if (mode === 'half-open') {
    if (failed) { mode = 'open'; openedAt = tMs; push({ timeMs: tMs, kind: 'breaker_opened', subject: 'payments', attrs: { reason: 'trial-failed' } }); } else { mode = 'closed'; recent = []; push({ timeMs: tMs, kind: 'breaker_closed', subject: 'payments', attrs: {} }); }
    continue;
  }
  recent.push(failed ? 1 : 0);
  if (recent.length > WINDOW) recent.shift();
  if (recent.reduce((a, b) => a + b, 0) >= MIN_FAILURES) {
    mode = 'open';
    openedAt = tMs;
    recent = [];
    push({ timeMs: tMs, kind: 'breaker_opened', subject: 'payments', attrs: { reason: 'failure-rate' } });
  }
}
fs.writeFileSync(path.join(HERE, 'observed.jsonl'), lines.join('\n') + '\n');
console.log(`wrote ${lines.length} records to ${path.join(HERE, 'observed.jsonl')}`);
