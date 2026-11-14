---
name: working-model
description: Turns "how does X work?" into a working model, an animated, interactive explainer page in which every claim is a test that passes. Use when the user asks to explain how an algorithm, system, protocol, economic or epidemic mechanism, or control loop works; to visualize, animate or simulate a mechanism; or to make an interactive explainer, simulation, or playground (for example "explain how a token bucket rate limiter works", "visualize LRU eviction", "show me why jitter helps retries", "make an interactive explainer of herd immunity"). Also use to compare a model with an observed trace or to find a counterexample ("compare this model to the trace", "why did this circuit breaker open", "find a counterexample to this claim"). Not for static diagrams of physical machines or for data charts.
---

# Working Model

You write a small `*.model.json` spec: params (sliders), state, rules in a tiny safe rule language, a scenario of events, visual parts bound to the state, captions, and **claims**. The CLI simulates it in Node, checks every claim, lints the text, and builds one offline HTML page that runs the same engine and re-checks the claims live as the reader drags sliders.

The point: an explanation that is tested. A claim the model cannot back up fails before the user ever sees it.

## Commands

All commands run with Node 20 or newer and need no `npm install`. Keep the quotes: the path may contain spaces.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/working-model.mjs" new token-bucket --dir ./explainers         # a spec that already passes
node "${CLAUDE_SKILL_DIR}/scripts/working-model.mjs" check ./explainers/token-bucket.model.json  # schema, simulate, claims, lint
node "${CLAUDE_SKILL_DIR}/scripts/working-model.mjs" check ./explainers/token-bucket.model.json --mutate   # do the claims catch broken rules?
node "${CLAUDE_SKILL_DIR}/scripts/working-model.mjs" build ./explainers/token-bucket.model.json -o ./explainers/token-bucket.html
node "${CLAUDE_SKILL_DIR}/scripts/working-model.mjs" layout ./explainers/token-bucket.model.json --out ./explainers/shots   # needs local Chrome or Edge
node "${CLAUDE_SKILL_DIR}/scripts/working-model.mjs" snap ./explainers/token-bucket.model.json --at 2 -o shot.png           # optional picture
node "${CLAUDE_SKILL_DIR}/scripts/working-model.mjs" fuzz ./explainers/token-bucket.model.json --cases 300 --seed 7          # seeded counterexample search
node "${CLAUDE_SKILL_DIR}/scripts/working-model.mjs" check ./explainers/token-bucket.model.json --trace t.normalized.json --mapping trace-map.json   # model versus an observed trace
```

Below, `working-model` is short for `node "${CLAUDE_SKILL_DIR}/scripts/working-model.mjs"`. In agents that do not substitute `${CLAUDE_SKILL_DIR}`, use the folder this file is in. `check` exit codes: 0 every claim passes, 1 a claim or lint error fails, 2 the spec is invalid. Add `--json` for machine-readable output and `--set name=value` to try other slider positions. `--mutate` exits 0 unless the claims fail; add `--mutate-strict` (and `--min-score 80`) to exit 1 when a claim never fails or the score is low. `build --mutate` stores the score in the page.

## Workflow

1. **Pick the smallest model that shows the surprising part.** One mechanism, one scenario, 2 to 4 sliders. Ask: what would a smart reader get wrong? Build the scenario so that moment happens on screen (the burst that empties the bucket, the retries that land together, the scan that flushes the cache).
2. **Scaffold or copy an example.** Start from `working-model new <name>` or the closest file in `examples/` (token bucket, backoff with jitter, LRU cache, TCP AIMD, circuit breaker, SIR epidemic, compound interest, load balancing, Bloom filter, Raft leader election, inventory reorder point).
3. **Write params, state and rules.** Discrete time: each tick runs `rules.tick`, then that tick's events fire their `rules.on.<event>` handler. Keep units honest (`timeUnit`, slider `unit`). Use `emit('name', payload)` for things a link should animate or a claim should watch.
   - **Time is floating point.** `t` is `tick × dt`, so a time stored as `t + lead` never exactly equals a later `t`. For deadlines and countdowns store tick numbers (`due = tick + round(lead / dt)`, then `tick >= due`). `references/spec.md` has more such traps under "Writing Rules That Behave".
   - **Lists are values**: `a = b` copies. Change a nested list through an index (`push(queues[i], job)`).
4. **Write 3 to 8 claims that capture the key insights, not trivia.** A claim that reads back a rule ("tokens never exceed capacity" when the rule is `min(capacity, ...)`) cannot fail and teaches nothing; the interesting ones say something a reader would not guess: "a loop one key larger than the cache gets no hits at all", "jitter lowers the peak retry load". Use the right kind (`at`, `always`, `never`, `eventually`, `whenever`, `sweep`, `compare`; see `references/claims.md`).
   - At least one claim must hold at the defaults **and fail when a slider moves**, so the reader sees where the explanation stops holding. `check` lists which slider positions break which claims.
   - Each claim must be true of the real mechanism, not just of your model. Put the source for the key facts in `sources`, and state model assumptions in the `summary`. Write "in this run" when a claim only holds for this seed.
   - Make the sentence say exactly what the expression checks. `check` proves the expression, not the sentence; step 7 tests whether the claims can fail at all.
   - Make `duration` long enough for the slowest slider settings, or `eventually` claims fail only because the run ended.
5. **Bind numbers in text.** Captions and claim text take `{expression}` holes: write `{capacity}`, never a literal `10` that goes stale when a slider moves. `check` warns about literal numbers (`W_LITERAL_NUMBER`) and suggests the binding. A caption must cite the claims it relies on (`cites`); citing a failing claim is an error.
6. **Run `check` until it says `N/N claims pass` with no errors.** Fix warnings too.
7. **Then run `check --mutate`: test the claims.** It breaks the rules on purpose, one small change per mutant (`<` for `<=`, `pop` for `shift`, a deleted line, an event a tick late), re-checks every claim against every mutant, and reports which claims catch which bugs.
   - **Every claim must kill at least one mutant.** A claim listed under "Claims that never failed" cannot fail: it restates a rule, passes vacuously, or the scenario never exercises it. Strengthen it (make the expression say all of its sentence) or change the scenario so the claim is put to the test (staggered arrivals instead of one burst, a loop that does not fit). `references/claims.md` has a worked example.
   - **For each surviving mutant**, either add or strengthen a claim, or explain in your reply why the change cannot be seen (for example, it only renames keys). Only a truly harmless one goes into `mutate.ignore` in the spec, with its reason. Never weaken a claim or an assertion to raise the score.
   - Mutants marked equivalent or visual only change nothing a claim can see; they are left out of the score. Visual-only ones change what the page draws, so check those numbers in the screenshot.
8. **Never weaken or delete a claim just to make it pass.** When a claim fails, decide which one is wrong:
   - the **model** is wrong (a rule bug, a wrong default, a missing mechanism): fix the model;
   - the **claim** is wrong (the real mechanism does not behave that way, or only does so under a condition): correct the claim and say what was wrong.
   Tell the user which it was and why, in one or two sentences. Loosening a tolerance until it passes, or swapping a claim for an easier one, is not allowed.
9. **Build, then run `layout`.** Fix every `E_` issue (overlapping parts, text spilling out, text colliding, page scrolling sideways at 390 px). Usually: give the part more grid cells, shorten a label, or move a part. Fix `W_LINK_CROSSES` too (an arrow drawn across another part): move a part or add `via` points. Look at the screenshot it writes, and check that every number shown is the one you meant: part bindings are not tested by any claim. For a counter or gauge a reader will rely on, add an `expect` (an independent way to compute the same number, such as `"expect": "len(queue)"`), and `check` fails if the two ever differ.
10. **Hand over:** the HTML path, the claims summary line (`6/6 claims pass`) and the mutation score, one line per claim, and which slider breaks which claim. Mention any model assumption the reader should know.

## Looking For Counterexamples

After `check` and `check --mutate` pass, `working-model fuzz spec.model.json --cases 300 --seed 7` runs the same claims on seeded nearby cases: slider values, the model seed, and the events a `fuzz` block marks fuzzable (shifted, repeated or dropped). Then `working-model minimize spec.model.json --case .working-model/fuzz/first-failure.json` shrinks the first failure while keeping the same claim failing. Report the minimized case in plain words ("drop the successes between the scattered failures and the breaker trips"). A failure at a non-default setting is a finding about where the explanation stops holding: correct the claim or the model on substantive grounds, keep the counterexample, and never weaken a claim to silence it. "No failure found" is not a proof. Details: `docs/FUZZ.md`.

## Comparing With An Observed Trace

Use this only when the user has a trace of the real system (JSONL, or the OTLP JSON subset), or asks for the synthetic demo in `examples/reality-bridge/`. A trace is never required.

1. **Say first that a trace can hold private data** (request ids, user ids, IPs, tokens) and work on it locally. Import keeps only the attributes the mapping reads: `working-model trace import trace.jsonl --mapping trace-map.json --out trace.normalized.json`. Pass `--complete` only when the user confirms the instrumentation records every event of the mapped kinds; otherwise completeness stays `unknown`.
2. **Keep four things apart in what you write:** model assumptions, mechanism facts from sources, claims within the model, and observed assertions. Put assumptions in the spec's `reality.assumptions`.
3. **Write the mapping from what the trace really contains.** Never invent a correlation id or an event the trace does not record; an output without a subject on both sides is uncorrelated and its assertion is inconclusive. Every model event is either replayed or listed in `internalEvents`.
4. **Run `working-model check spec.model.json --trace trace.normalized.json --mapping trace-map.json`.** Report the model line and the observed line separately (`Model: 4/4 claims pass | Observed: 1 pass, 2 fail, 0 inconclusive`), the first mismatch with its event ids, and every inconclusive reason as it is. Exit 1 means a claim or an observed assertion failed; 2 an invalid trace or mapping; 3 a missing file or a limit.
5. **When the trace disagrees, fix the assumption on substantive grounds**, usually in a second model, and keep the counterexample. Never loosen `minPrecision`, `minRecall` or `withinMs` just to pass.
6. **For a page to look at**, run `working-model build spec.model.json --trace trace.normalized.json --mapping trace-map.json -o page.html`: the normal explainer plus a model-versus-observed timeline, the first mismatch and every assertion. It holds the normalized trace, so it stays local.
7. **Only if the user asks to publish**, run `working-model bundle spec.model.json --public ... --preview` first, show them the key list, then run it without `--preview`. A real trace needs their explicit `--acknowledge-privacy`; never pass it on their behalf.
8. **Say what the evidence does not show:** unobserved state, sampled traces, the time window covered. It is an executable explanation with trace evidence, never formal verification.

Formats, selectors and assertion kinds: `docs/REALITY-BRIDGE.md`. Threat model: `docs/TRACE-SECURITY.md`. Limits of the evidence: `docs/CONFORMANCE-LIMITS.md`.

## Keeping It Honest In CI

When the user wants the explanation checked on every pull request, add `.working-model-ci.json` (models, and which of claims, mutation, fuzz, reality and parity to run, with explicit thresholds) and copy `.github/workflows/working-model-ci.example.yml`. `working-model ci --config .working-model-ci.json --format markdown` prints the summary a reviewer reads. Never lower a threshold to make CI pass. Details: `docs/CI.md`.

## Spec at a glance

```json
{
  "title": "Token Bucket Rate Limiter",
  "summary": "A bucket holds up to {capacity} tokens and refills at {refill} per second.",
  "sources": [{ "title": "RFC 2697", "url": "https://www.rfc-editor.org/rfc/rfc2697" }],
  "timeUnit": "s", "dt": 0.1, "duration": 16, "seed": 7,
  "params": [{ "id": "capacity", "label": "Bucket size", "min": 1, "max": 30, "step": 1, "default": 10, "unit": "tokens" }],
  "events": [{ "name": "request", "at": 1, "count": 15 }],
  "state": { "tokens": "capacity", "accepted": 0, "rejected": 0 },
  "derived": { "fill": "tokens / capacity" },
  "rules": {
    "tick": "tokens = min(capacity, tokens + 2 * dt)",
    "on": { "request": ["if tokens >= 1 {", "  tokens -= 1; accepted += 1; emit('accept')", "} else {", "  rejected += 1; emit('reject')", "}"] }
  },
  "layout": { "cols": 12, "rows": 8 },
  "parts": [
    { "id": "bucket", "type": "tank", "at": [4, 0, 4, 4], "label": "Bucket", "level": "fill", "text": "{tokens:.1} of {capacity}" },
    { "id": "chart", "type": "chart", "at": [0, 5, 12, 3], "label": "Tokens", "series": [{ "expr": "tokens" }] }
  ],
  "narration": [{ "from": 1, "to": 3, "text": "The first {capacity} requests spend the stored tokens.", "cites": ["burst-passes"] }],
  "claims": [{ "id": "burst-passes", "kind": "at", "t": 1, "expr": "accepted == capacity", "text": "A full bucket lets exactly the first {capacity} requests through." }]
}
```

- Strings in `state` are expressions (`"capacity"`); text values need inner quotes (`"'closed'"`).
- Rule language: numbers, strings, lists, `true/false`, `+ - * / % **`, comparisons, `and or not`, `c ? a : b`, `let`, `if / else if / else`, `while`, `for x in list`, `break`, `continue`, assignment ops, and functions such as `min max abs clamp round sqrt exp log rand randint chance pick len push pop shift unshift remove contains indexOf slice sum range fill emit`. No member access, no user functions, no `eval`. Full reference: `references/spec.md`.
- Parts: `box tank queue stack grid counter gauge lamp node link chart label group`, placed on the grid with `at: [col, row, width, height]`. Bindings and options: `references/parts.md`.
- Claims and how to write good ones: `references/claims.md`. A complete worked example: `references/walkthrough.md`.

## Layout rules of thumb

- 12 columns by 8 rows suits most models. Keep a 2-row-tall minimum for parts that show a label and a value (1 row works for counters, which switch to a one-line form).
- Leave an empty row or column between parts that a `link` joins, so the arrow has room.
- Charts read best 12 wide and 3 to 4 tall. Short labels survive phone width; long ones get shrunk and then flagged.

## Error codes you will meet

`E_SCHEMA_*` (shape of the JSON), `E_UNKNOWN_NAME` (typo; the message suggests the right name), `E_UNKNOWN_SIGNAL` (a link or claim watches an emit that never happens), `E_TYPE`, `E_DIV_ZERO`, `E_STEP_LIMIT` (a loop that never ends, or big lists copied every tick), `E_TRACE_LIMIT` (state too big for the number of ticks), `E_LAYOUT_OVERLAP`, `E_CITES_FAILING_CLAIM`. Every error names the spec location, such as `rules.on.request:3:12`, with the offending line underlined.
