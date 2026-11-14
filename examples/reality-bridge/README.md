# The Model Says Yes; The Trace Says No

A synthetic demo of the Reality Bridge. Nothing here was recorded from a real system: `make-trace.mjs` writes `observed.jsonl` from a simulated payments client.

## The Story

`circuit-breaker.model.json` explains a circuit breaker that counts **failures in a row**. Its four claims pass, including "scattered failures never trip it": before the outage every other call fails, never two in a row, and the breaker stays closed.

The trace disagrees. The production breaker in the synthetic trace counts failures over its last 10 calls, so five scattered failures open it at 1.8 s. Replaying the trace's call outcomes through the model and matching the breaker transitions:

```text
Circuit Breaker That Counts Failures In A Row: model versus observed trace
  Model: 4/4 claims pass | Observed: 1 pass, 2 fail, 0 inconclusive | status fail
  fail  opens-when-observed  (precision 0 < minPrecision 1)
  fail  closes-when-observed  (precision 0 < minPrecision 1)
  pass  no-rejection-before-open

  First mismatch
    unexpected_observed_output at 1800 ms, subject payments: Observed output with no predicted model output within 50 ms; trace declared complete
    events: ev-00011; test: precision 0 < minPrecision 1
```

The model is not wrong about itself; its assumption about the real breaker is. `circuit-breaker-window.model.json` replaces that assumption (it opens when 5 of the last 10 calls failed) and passes the same observed assertions on the same trace, with its own four claims passing too.

## Reproduce

From the repository root:

```bash
node examples/reality-bridge/make-trace.mjs
node scripts/working-model.mjs trace import examples/reality-bridge/observed.jsonl \
  --mapping examples/reality-bridge/trace-map.json --complete \
  --out examples/reality-bridge/observed.normalized.json
node scripts/working-model.mjs check examples/reality-bridge/circuit-breaker.model.json \
  --trace examples/reality-bridge/observed.normalized.json --mapping examples/reality-bridge/trace-map.json
node scripts/working-model.mjs check examples/reality-bridge/circuit-breaker-window.model.json --trace
```

The last command reads the mapping and trace from the spec's `reality` block. `observed-unknown.normalized.json` is the same trace imported without `--complete`: there the first model's mismatches are inconclusive rather than failures, because a dropped input could explain them.

## Files

| File | What it is |
| --- | --- |
| `make-trace.mjs` | Writes the synthetic trace, deterministically |
| `observed.jsonl` | The raw synthetic trace, with fake tokens, documentation-range IPs and example.com e-mail addresses that import drops |
| `observed.normalized.json` | `trace import --complete` output |
| `observed-unknown.normalized.json` | `trace import` output without `--complete` |
| `trace-map.json` | Inputs, outputs and three observed assertions |
| `circuit-breaker.model.json` | The model with the contradicted assumption |
| `circuit-breaker-window.model.json` | The model with the corrected assumption |
| `recording-adapter.mjs` | Optional zero-dependency JSONL recorder for Node applications; nothing is instrumented automatically |
