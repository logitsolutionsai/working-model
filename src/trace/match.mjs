// One-to-one matching of predicted (model) outputs to observed events.
//
// Events are grouped by subject. An event without a subject is never matched
// by timing alone: it is reported as uncorrelated. Inside a group, a pair is
// admissible when the time difference is at most withinMs. Every expected
// output, in time order (then by its index), takes the earliest unmatched
// observed event inside its window (equal times: lowest id first). With equal
// windows on a line this greedy rule gives a maximum-cardinality matching,
// and it needs one pass over each sorted group: O(n log n), no n x m table.
// Pure module: no Node or browser APIs.

export function matchEvents(expected, observed, withinMs) {
  // expected: [{ key, timeMs, subject }], observed: [{ id, timeMs, subject }]
  const groups = new Map();
  const uncorrelatedExpected = [];
  const uncorrelatedObserved = [];
  const group = (s) => {
    let g = groups.get(s);
    if (!g) { g = { exp: [], obs: [] }; groups.set(s, g); }
    return g;
  };
  for (const e of expected) { if (e.subject == null) uncorrelatedExpected.push(e); else group(e.subject).exp.push(e); }
  for (const o of observed) { if (o.subject == null) uncorrelatedObserved.push(o); else group(o.subject).obs.push(o); }
  const pairs = [];
  const unmatchedExpected = [];
  const unmatchedObserved = [];
  const subjects = [...groups.keys()].sort();
  const byIdThenTime = (a, b) => a.timeMs - b.timeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const s of subjects) {
    const g = groups.get(s);
    const exp = g.exp.slice().sort((a, b) => a.timeMs - b.timeMs || a.key - b.key);
    const obs = g.obs.slice().sort(byIdThenTime);
    let i = 0;
    for (const e of exp) {
      while (i < obs.length && obs[i].timeMs < e.timeMs - withinMs - 1e-9) { unmatchedObserved.push(obs[i]); i++; }
      if (i < obs.length && obs[i].timeMs <= e.timeMs + withinMs + 1e-9) {
        pairs.push({ expected: e, observed: obs[i], deltaMs: obs[i].timeMs - e.timeMs });
        i++;
      } else unmatchedExpected.push(e);
    }
    for (; i < obs.length; i++) unmatchedObserved.push(obs[i]);
  }
  const deltas = pairs.map((p) => p.deltaMs).sort((a, b) => a - b);
  const skew = deltas.length ? {
    count: deltas.length, minMs: deltas[0], medianMs: deltas[Math.floor((deltas.length - 1) / 2)], maxMs: deltas[deltas.length - 1],
  } : { count: 0, minMs: null, medianMs: null, maxMs: null };
  const byTime = (a, b) => a.timeMs - b.timeMs;
  return {
    pairs: pairs.sort((a, b) => a.expected.timeMs - b.expected.timeMs || a.expected.key - b.expected.key),
    unmatchedExpected: unmatchedExpected.sort(byTime),
    unmatchedObserved: unmatchedObserved.sort(byIdThenTime),
    uncorrelatedExpected, uncorrelatedObserved, skew,
  };
}
