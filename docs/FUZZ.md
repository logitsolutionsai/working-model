# Fuzz And Minimize

`check` tests each claim at the defaults; `sweep` claims and the slider probes test chosen ranges; `check --mutate` tests whether the claims can fail at all. `fuzz` adds one more question: **under which nearby conditions does a claim stop holding?** It complements those checks and changes none of them: mutation scores, sweep samples and the claims are untouched.

```bash
node scripts/working-model.mjs fuzz examples/reality-bridge/circuit-breaker.model.json --cases 300 --seed 7 --out .working-model/fuzz
node scripts/working-model.mjs minimize examples/reality-bridge/circuit-breaker.model.json \
  --case .working-model/fuzz/first-failure.json --out .working-model/minimized.json
node scripts/working-model.mjs fuzz examples/reality-bridge/circuit-breaker.model.json --case .working-model/minimized.json
```

## What A Case Varies

- **Sliders.** Each param is drawn from its slider grid (min, max and step). A slider with more than 1,000 positions is sampled stratified: min, max, default, then seeded interior points.
- **The model seed**, in about a quarter of the cases.
- **Events**, only those the spec marks fuzzable. Without a `fuzz` block no event is touched:

```json
"fuzz": {
  "events": {
    "failure": { "fuzzable": true, "shift": 0.2, "count": [1, 6], "omit": true },
    "success": { "fuzzable": true, "shift": 0.2, "omit": true }
  }
}
```

Each scheduled entry of a fuzzable event may be shifted by whole ticks up to `shift` model time units either way, given a burst `count` in the range, or omitted. Fuzz never invents an event name. Same-tick order is not varied in this version.

Case 0 is always the defaults with nothing perturbed. Cases come from the engine's seeded generator (`mulberry32-v1`, seeded with `fuzz:<seed>:<case>`), so the same seed and case count always give the same report and the same `first-failure.json`, byte for byte.

## The Report

`fuzz-report.json` lists `casesChecked`, the seed and generator, how each param was sampled and how many distinct values were seen, which events were perturbed, per-claim pass, fail and error counts with the first failing case, every failure by `(caseIndex, claimId, firstTick)`, cases that hit a limit, and warnings:

- `W_VACUOUS_CLAIM`: a `whenever` claim whose signal never fired, or a `sweep` with no sample inside its `holdsWhen`, in every case. Passing it says nothing.
- `W_NEVER_FAILED_IN_FUZZ`: the claim passed in every case. That is not a proof; `check --mutate` says whether it can fail at all.
- `W_FUZZ_LIMIT`: cases that hit the step or trace limit. They are inconclusive, never counted as passes.

"No failure found" is not a proof of correctness.

## Counterexamples

```json
{
  "schemaVersion": 1,
  "kind": "working-model-counterexample",
  "evidenceType": "simulated",
  "modelDigest": "sha256:...",
  "generator": "mulberry32-v1",
  "seed": 7,
  "caseIndex": 3,
  "modelSeed": 1,
  "params": { "cooldown": 4, "threshold": 5 },
  "events": [{ "index": 2, "name": "success", "omit": true }],
  "failure": { "claimId": "ignores-scattered", "firstTick": 98, "observed": "trips=1, failures=5, threshold=5", "expected": "trips == 0 and failures >= threshold" },
  "shrink": { "checks": 5, "budget": 200, "stopReason": "local-minimum-under-budget" }
}
```

`events` lists perturbations of the spec's scheduled entries (by `index` in `events`), not a full schedule. Files are canonical JSON with sorted keys. A simulated counterexample is about the model; it is never mixed up with an observed trace mismatch (`evidenceType`).

`minimize` shrinks deterministically, keeping a candidate only when **the same claim** still fails: it drops perturbations (halves, then one at a time), moves burst counts back to the spec's count and shifts back to zero, moves params to their defaults (then halfway, snapped to the slider step), then puts the model seed back. It stops after `--shrink-budget` evaluations (default 200, at most 2,000) and reports `budget-exhausted` if it ran out. It does not shrink the duration, because claims name times inside the run. The original spec and claims are never changed. A case written for another version of the model (another digest) is refused.

## Limits And Exit Codes

Default `--cases 100`, at most 2,000 unless `--unsafe-large` (then 20,000), and a global time limit of 120 s, after which the report says `stopReason: "timeout"`. Every case runs under the engine's step and trace limits.

`fuzz` exits 0 even when it finds failures, so that it can be used to explore; `--strict` exits 1 on any failure or limit. `fuzz --case` exits 1 when the claim still fails. Invalid models and cases exit 2.
