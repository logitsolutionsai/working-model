// Optional, zero-dependency recorder for Node applications: writes the JSONL
// that `working-model trace import` reads. Nothing is instrumented
// automatically: you call event() where your code already knows what
// happened. Records only what you pass, through an explicit file handle,
// and stops at a byte limit instead of growing without bound.
//
//   import { openRecorder } from './recording-adapter.mjs';
//   const rec = openRecorder('trace.jsonl');
//   rec.event({ kind: 'call_failed', subject: requestId, attrs: { route: '/pay' } });
//   rec.close();
//
// Keep identifying values out of attrs unless the mapping needs them; import
// drops every attribute the mapping does not name anyway.

import fs from 'node:fs';

export function openRecorder(file, opts = {}) {
  const maxBytes = opts.maxBytes || 5 * 1024 * 1024;
  const now = opts.now || (() => performance.now());
  const t0 = now();
  const fd = fs.openSync(file, opts.append ? 'a' : 'w');
  let bytes = 0;
  let dropped = 0;
  let closed = false;
  return {
    // { kind, subject?, attrs?, timeMs? } -> true when written
    event(rec) {
      if (closed) throw new Error('the recorder is closed');
      if (!rec || typeof rec.kind !== 'string' || !rec.kind) throw new Error('event() needs a kind');
      const out = { timeMs: rec.timeMs != null ? rec.timeMs : Math.round((now() - t0) * 1000) / 1000, kind: rec.kind };
      if (rec.subject != null) out.subject = String(rec.subject);
      if (rec.attrs) {
        out.attrs = {};
        for (const [k, v] of Object.entries(rec.attrs)) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out.attrs[k] = v;
      }
      const line = JSON.stringify(out) + '\n';
      if (bytes + Buffer.byteLength(line) > maxBytes) { dropped++; return false; }
      fs.writeSync(fd, line);
      bytes += Buffer.byteLength(line);
      return true;
    },
    stats() { return { bytes, dropped }; },
    close() { if (!closed) { fs.closeSync(fd); closed = true; } return { bytes, dropped }; },
  };
}
