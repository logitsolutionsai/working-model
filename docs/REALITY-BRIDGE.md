# Reality Bridge

A working model checks its claims against its own simulation. The Reality Bridge adds a second, separate question: **does an observed system behave the way the model says?** It replays the input events of a recorded trace through the same engine, matches the outputs the model predicts against the outputs the trace recorded, and evaluates explicit assertions that return pass, fail or inconclusive.

These are executable explanations with trace evidence. They are not formal verification: a passing observed assertion says only that the recorded events agree with the model, under the mapping you wrote, for the time the trace covers.

## The Three Steps

```bash
# 1. the model's own claims
node scripts/working-model.mjs check examples/reality-bridge/circuit-breaker.model.json

# 2. import a trace, keeping only the attributes the mapping needs
node scripts/working-model.mjs trace import examples/reality-bridge/observed.jsonl \
  --mapping examples/reality-bridge/trace-map.json --complete \
  --out examples/reality-bridge/observed.normalized.json

# 3. replay it and compare
node scripts/working-model.mjs check examples/reality-bridge/circuit-breaker.model.json \
  --trace examples/reality-bridge/observed.normalized.json \
  --mapping examples/reality-bridge/trace-map.json
```

`examples/reality-bridge/README.md` walks through the result: every model claim passes, and the trace shows the breaker opening at 1.8 s, where the model predicts it stays closed.

## Trace Input (JSONL)

One JSON object per line:

```json
{ "timeMs": 200, "kind": "call_failed", "subject": "req-0001", "attrs": { "route": "/pay" } }
```

| Field | Rule |
| --- | --- |
| `timeMs` | Relative milliseconds, a finite number of at least 0. |
| `ts` | Instead of `timeMs`: an ISO 8601 time with `Z` or an offset. Only accepted with `--origin first-event` or `--origin <ISO time>`, because the meaning of a timestamp is never changed silently. A file cannot mix the two. |
| `kind` | 1 to 64 characters, no control characters. |
| `subject` | Optional string of at most 256 characters (or a number, kept as text). Often identifying: it never reaches a public bundle. |
| `attrs` | Optional flat object of numbers, strings, true/false or null, at most 32 keys. Nested values are refused. |
| `id` | Optional, 1 to 64 of `A-Z a-z 0-9 _ . : -`. Missing ids become `ev-00001`, `ev-00002`, ... by record order. Duplicates are refused. |

Events are sorted by time, then by record order. Attributes are dropped unless the mapping reads them (`attrs.<key>` in a selector), lists them in `keepAttrs`, or `--keep-attr` names them; the count of dropped values is reported. Unknown record fields are dropped and counted. With `--strict`, records out of time order and kinds the mapping does not know are errors.

**Limits.** 5 MiB and 50,000 events by default. `--max-bytes` and `--max-events` raise them to a hard 100 MiB and 500,000. A file over the byte limit is refused; a file over the event limit is truncated, warned about, and marked `known-incomplete`.

**Completeness** has three values:

- `unknown`, the default. A missing observed event can only make an assertion inconclusive.
- `declared-complete`, only with `--complete`, which you pass after checking that the instrumentation records every event of the mapped kinds. Never guessed from the file.
- `known-incomplete`, set by the importer when it truncated the trace.

The normalized trace (`schemaVersion`, `kind`, `timeBase`, `origin`, `completeness`, `events`, `warnings`) is canonical JSON with sorted keys, so the same input always gives the same bytes. The path of the source file is kept in a `private` block that is excluded from the trace digest and from every public output.

## The Mapping (`trace-map.json`)

For editor completion, point `$schema` at `schema/trace-map.schema.json`; the normalized trace has `schema/normalized-trace.schema.json`. The command line checks the same rules in code, plus the names against the model.

```json
{
  "schemaVersion": 1,
  "modelTimeUnit": "s",
  "timeOrigin": "zero",
  "inputs": [
    { "observedKind": "call_failed", "modelEvent": "failure", "subjectFrom": "subject" }
  ],
  "outputs": [
    { "modelEmit": "trip", "observedKind": "breaker_opened", "modelSubjectFrom": "literal:payments", "observedSubjectFrom": "subject", "withinMs": 50 }
  ],
  "assertions": [
    { "id": "opens-when-observed", "kind": "event-correspondence", "modelEmit": "trip", "minPrecision": 1, "minRecall": 1 }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `modelTimeUnit` | `ms`, `s`, `min`, `h` or `d`; must equal the spec's `timeUnit` when that is one of these. Otherwise give `msPerModelUnit`. |
| `timeOrigin` | `first-input` (default): the first replayed input is t = 0. `zero`: trace time 0 is model time 0. A mapped event before the origin is an error. |
| `timeQuantization` | `nearest-tick`, the only mode: `tick = round(ms / dt in ms)`. The largest shift is reported; above `quantizationToleranceMs` (default half a tick) the replay is refused. |
| `replayMode` | `replace-inputs`, the only mode. |
| `internalEvents` | Model events that keep their own schedule during replay. Every model event must be either replayed (named by an input) or internal; otherwise the replay is refused as ambiguous, so nothing fires twice. |
| `inputs` | `observedKind` to `modelEvent`. Optional `subjectFrom` (default `subject`), `modelPayloadKey`, and `when` (equality filters such as `{ "attrs.outcome": "error" }`, needed when one kind maps to two events). |
| `outputs` | `modelEmit` to `observedKind`, with `modelSubjectFrom` and `observedSubjectFrom` (both or neither), `withinMs` (default one tick in ms, at least 1, at most 3,600,000) and `payloadIsSeqOf`. |
| `allowUnknownObserved` | Default true: observed kinds the mapping does not know are counted as unmapped. False makes them an error. |
| `keepAttrs` | Extra attributes the import keeps. |

**Selectors are fixed forms, never expressions.** Observed side: `subject`, `attrs.<key>`, `literal:<text>`. Model side:

- `event.<key>`: the subject of the replayed input whose handler made the emit, where the input set `"modelPayloadKey": "<key>"`. Emits from `rules.tick` or internal events have no such input, so they are uncorrelated.
- `payload` or `payload[<n>]`: the emit payload (a number or text) used as the subject. With `"payloadIsSeqOf": "<event>"` the payload is read as the `seq` of that replayed event and turned back into the observed subject of that input. This is how a model that queues work correlates an output emitted later.
- `literal:<text>`: one fixed subject, for a single breaker, queue or server.

### Why `event.<key>` Is A Mapping Selector, Not Rule Code

The rule language has no member access, and event handlers do not see `payload`. Adding an `event.<key>` name to rule code would change the engine that every built page inlines, so every existing gallery page would change. The Reality Bridge keeps the engine byte-identical and offers the same correlation from the mapping side instead: `event.<key>` names the input that caused an emit, and `payload` with `payloadIsSeqOf` covers outputs emitted later. Rule code can store `seq` (available in every handler) when it needs to remember which input an output belongs to.

## Replay

Replay runs a fresh engine state with the mapped inputs replacing the declared inputs. The order inside a tick is the engine's: tick 0 runs `rules.init`, then the events of time 0; every later tick runs `rules.tick`, then that tick's events in spec order. All replayed inputs of a tick fire as one block at the position of the first replayed event in spec order, in trace order; consecutive inputs of the same event form a burst with `batch` 0, 1, 2, and `seq` counts every firing as it does in a normal run.

`tests/trace-replay.test.mjs` replays every example's own schedule as a trace and checks that the snapshots, emits and firings equal `simulate()`. One honest exception: when a random arrival (`rate`) event is replayed from the trace, the seeded generator no longer draws its arrivals, so rule code that calls `rand` sees a different sequence. The test then checks only that the firings are identical.

The replay runs to the later of the model's duration and the last mapped observed event plus the widest `withinMs`, at most 100,000 ticks and 200,000 firings, under the model's step limit. Hitting a limit is an error with exit code 3, never a pass.

## Matching

Model outputs and observed events are grouped by subject. A pair is admissible when the times differ by at most `withinMs`. Each expected output, in time order, takes the earliest unmatched observed event in its window (equal times: lowest id first). With equal windows this gives a maximum-cardinality one-to-one matching in one pass over each sorted group, so two expected outputs never share one observed event and a duplicate observed event never satisfies one output twice. Events without a subject are never matched by timing alone: they are reported as uncorrelated.

## Assertions

| Kind | Passes when | Fails when (declared complete) | Inconclusive when |
| --- | --- | --- | --- |
| `event-correspondence` | precision >= `minPrecision` and recall >= `minRecall` (both default 1) | either is below its minimum | either is below and completeness is not declared; any event is uncorrelated; neither side has the output |
| `event-order` | every `then` event has an earlier `first` event with the same `by` value | a `then` has no earlier `first` | no `then` was observed; completeness is not declared |
| `response-before` | every `request` gets a `response` with the same `by` within `withinMs` | a response is late (fails at any completeness), or none arrives before the trace ends | no request was observed; a response is missing and completeness is not declared |
| `never-observed` | completeness is declared and nothing matched | the kind was observed (at any completeness) | nothing was observed but completeness is not declared |

Precision is matched observed outputs over mapped observed outputs; recall is matched model outputs over expected model outputs. A zero denominator is reported as `"undefined"` with a note, never as 100%. An assertion can set `"required": false` to be reported without affecting the status.

The aggregate status is `fail` if a required assertion fails, `inconclusive` if none fails but one is inconclusive (or there are none, or the trace has no model inputs), otherwise `pass`. Model claims are reported beside it in `modelClaims` and never merged into it: all model claims can pass while the trace disagrees, and that is the point.

## The Report (`reality-report.json`)

`check --trace` writes the report to `--report <file>` (default `.working-model/reality-report.json`) and prints it with `--json`. It holds `modelDigest`, `traceDigest`, `mappingDigest` (SHA-256 of canonical JSON), `engineVersion`, `verificationVersion`, `status`, `modelClaims`, `observedAssertions` (counts and every result with its evidence event ids, the test that failed and any `inconclusiveReason`), `coverage`, `replay` (origin, tick size, inputs replayed, largest quantization error), `outputs` (per mapped emit: expected, observed, matched and the timing skew), `firstMismatch`, `assumptions` and `sourceRefs` from the spec, and the command that reproduces it. A `cause` is always a factual description of what the algorithm found, such as "Unmatched expected output; trace declared complete", never a guessed root cause.

## The Comparison Page (`build --trace`)

```bash
node scripts/working-model.mjs build examples/reality-bridge/circuit-breaker.model.json \
  --trace examples/reality-bridge/observed.normalized.json --mapping examples/reality-bridge/trace-map.json \
  -o .working-model/reality-bridge.html
```

The page is the normal working model (animation, sliders, claims) with a **Model Versus Observed Trace** section below it. Default `build` is unchanged and never adds it. The model's claims must pass first, as for a normal build (or pass `--force`); failing observed assertions are shown, not refused. The command exits 0 when it wrote the page; use `check --trace` as the gate.

- **Summary line:** `Model: 4/4 claims pass | Observed: 1 pass, 2 fail, 0 inconclusive`, with the observed status as a chip. The two results are never merged.
- **Timeline:** the observed lane (solid marks, small ticks for the replayed inputs) above the simulated lane (hollow marks), dashed lines joining matched pairs, and the first mismatch marked with an ink chip and a cross. Play and Pause, Step back and Step forward (one tick), Jump to first mismatch, Reset, a time slider, and arrow keys on the timeline. The cursor moves with the page's spring motion and settles at once under reduced motion.
- **Panels:** the first mismatch (assertion, type, time, subject, cause, event ids, the test that failed), the simulated state at the cursor beside "not observed" for every state value (a trace never shows the model's internal state), every assertion with its status chip, test and inconclusive reason, coverage, the assumptions and sources from the spec (URLs as text, never fetched), the reproduce command, and a privacy notice.
- **Data table** of every mark on the timeline, for screen readers and for copying.

**Parity.** The page's engine script is one bundle of the same engine modules plus the trace modules (`src/node/build-reality.mjs`). The page re-runs replay, matching and the assertions in the browser and compares the result with the command line's report embedded in the page: status, every assertion, the first mismatch, every output count and the number of ticks. It shows "Browser re-check: the same result as the command line" or a warning not to rely on the page. `tests/e2e/reality.e2e.mjs` checks this in Chrome for a failing, an inconclusive and a passing comparison.

**Safety.** The Content Security Policy is the normal page's (`default-src 'none'`), with each inline script allowed by its SHA-256 hash and no `'unsafe-inline'` for scripts. Trace, mapping and spec text is inserted with `textContent` only. The page embeds the normalized trace (kinds, times, subjects, allowlisted attributes) but never the private source path. Do not publish it; `bundle --public` makes a page without subjects or attributes.

## Exit Codes

| Code | `trace import`, `check --trace` |
| --- | --- |
| 0 | the import worked; model claims pass and the observed status is pass or inconclusive |
| 1 | a model claim fails, an observed assertion fails, or (with `--strict-observed`) the status is inconclusive |
| 2 | the model, trace or mapping is invalid |
| 3 | a file cannot be read or written, or a size, step or tick limit was hit |
| 64 | usage error |

With `--json`, errors print as `{ "ok": false, "error": { "code", "message", "location", "fix" } }`.

## The Optional `reality` Block

A spec may name its default mapping and trace, and the assumptions and sources the comparison rests on:

```json
"reality": {
  "mapping": "trace-map.json",
  "observedTrace": "observed.normalized.json",
  "assumptions": [{ "id": "counts-in-a-row", "text": "The production breaker counts failures in a row.", "scope": "model" }],
  "sourceRefs": [{ "title": "Martin Fowler, CircuitBreaker", "url": "https://martinfowler.com/bliki/CircuitBreaker.html", "kind": "background" }]
}
```

Paths are relative to the spec and must stay inside its folder: no URLs, no absolute paths, no `..`, no symbolic links that leave the folder. A path given on the command line is your explicit local choice and is used as given. A `sourceRefs` URL must be `https:` and is documentation text only; nothing is fetched. `kind` defaults to `background`; use `code` or `test` only when that evidence accompanies the model. Leaving `reality` out changes nothing: `tests/baseline.test.mjs` checks that every existing example keeps byte-identical check, run, mutation and gallery output.

See `docs/TRACE-SECURITY.md` for the threat model and `docs/CONFORMANCE-LIMITS.md` for what this evidence does not establish.
