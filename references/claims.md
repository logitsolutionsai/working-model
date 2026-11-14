# Claims Reference

A claim is a plain sentence a reader can check, plus a precise statement the simulator can check. `check` runs every claim and fails if any is false. The built page runs them again, live, whenever a slider moves.

Every claim has `id`, `kind`, `text` (a template that may use `{param}` holes) and kind-specific fields. Claim expressions may use state, derived values, params and `t`, and must return `true` or `false` (anything else is `E_CLAIM_NOT_BOOLEAN`). Times (`t`, `from`, `until`, `by`, `within`) are numbers or expressions over params.

## Kinds

### `at`: true at one moment

```json
{ "id": "burst-passes", "kind": "at", "t": 1, "expr": "accepted == capacity",
  "text": "A full bucket lets exactly the first {capacity} requests of the burst through." }
```

Checked on the snapshot nearest to `t`. Counterexample: the values the expression uses at that moment.

### `always` and `never`: invariants

```json
{ "id": "never-beyond-envelope", "kind": "always", "expr": "accepted <= capacity + refill * t", "text": "From the start to any moment t, no more than {capacity} + {refill} × t requests get through." }
{ "id": "no-false-negatives", "kind": "never", "expr": "falseNegatives > 0", "text": "An added item is never reported missing." }
```

Checked at every tick, optionally only between `from` and `until`. Counterexample: the first tick where it breaks.

### `eventually`: happens by a deadline

```json
{ "id": "refills", "kind": "eventually", "from": 1.1, "by": 8, "expr": "tokens == capacity", "text": "After the burst, the bucket is full again before steady traffic starts." }
```

True if the expression holds at some tick between `from` (default 0) and `by` (default the end). Counterexample: the state at the deadline.

### `whenever`: a rule about every occurrence of an event

```json
{ "id": "peak-at-threshold", "kind": "whenever", "event": "peak", "expr": "abs(payload - 1 / R0) < 0.01", "text": "The infection curve turns over when the susceptible share has fallen to 1/R0." }
```

`event` is a scheduled event name or an `emit` name. The expression is checked once the handler (or tick rule) that fired it has finished, with `payload` bound to the emit's payload and, for scheduled events, `seq` and `batch`. If one block emits several times, every check sees the state at the end of that block, so put whatever the claim needs about each occurrence into the payload (a list works: `emit('enter', [thread, order])`).

With `within`, the expression must instead become true within that much time after each firing (checked on snapshots; no `payload`):

```json
{ "id": "closes-after-recovery", "kind": "whenever", "event": "recover", "within": "cooldown + 0.25", "expr": "mode == 'closed'", "text": "After the service recovers, the breaker closes again within one cooldown period." }
```

A firing whose window runs past the end of the run is not counted. If the event never fires at the defaults, lint warns (`W_VACUOUS_CLAIM`).

### `sweep`: holds for many param sets

```json
{ "id": "loop-too-big", "kind": "sweep", "samples": 30, "vary": ["capacity", "workingSet"],
  "holdsWhen": "workingSet > capacity",
  "claim": { "kind": "at", "t": 20, "expr": "hits == 0" },
  "text": "A loop over more keys than the cache holds gets no hits at all." }
```

- Samples `samples` param sets (default 24) with a seeded Latin hypercube over the `vary` params (a list of ids uses each slider's full range; a map `{ "id": [lo, hi] }` narrows it). Values snap to the slider step. Params not in `vary` keep their current values, so a slider can still break a sweep.
- The inner `claim` is any of `at`, `always`, `never`, `eventually`, `whenever`, and is checked on every sample.
- Without `holdsWhen`, it must hold for all samples.
- With `holdsWhen`, it must hold for every sample where `holdsWhen` is true **and fail for every sample where it is false**, and both sides must be sampled. This checks a boundary, not just one side of it. `holdsWhen` is evaluated at t = 0 of each sample, so it may use params and starting state, as in `"R0 * S / N > 1"`.
- Counterexample: the offending param set and, when relevant, the inner counterexample.

### `compare`: two runs side by side

```json
{ "id": "jitter-cuts-peak", "kind": "compare", "a": { "jitter": 1 }, "b": { "jitter": 0 },
  "measure": { "of": "retries", "agg": "max", "label": "peak retries in one instant" }, "expect": "a < b",
  "text": "Full jitter lowers the peak number of retries that land in the same instant." }
```

- `a` and `b` override params (numbers or expressions over the current params); every other param keeps its current value.
- `measure.of` is evaluated at every tick and reduced with `agg`: `max`, `min`, `mean`, `sum`, `final`, or `at` with `measure.t`.
- `expect` compares the two numbers, named `a` and `b`, and may use params.
- Counterexample: both values and both sets of overrides.

## What Makes a Good Claim

**State the insight, not the rule.** A claim that restates a line of rule code passes trivially and teaches nothing. Prefer claims about consequences:

| Weak | Strong |
| --- | --- |
| "When tokens are available, a request takes one." | "From the {capacity + 1:ord} request on, every request in the burst is rejected." |
| "The window is halved on loss." | "The two flows end up sharing the link almost equally, whatever the head start." |
| "Retries wait base times two to the attempt." | "Full jitter lowers the peak number of retries that land in the same instant." |
| "Tokens never exceed capacity" (the rule is `min(capacity, ...)`) | "From the start to any moment t, no more than capacity + refill × t requests get through." |
| "A key is evicted only when the cache is full" (the eviction guard) | "One more slot never means fewer hits." |

A quick test for a restatement: find the line of rule code the claim checks. If the claim is that line's condition read back (a guard, a `min`, a constant emitted in a branch), it cannot fail and teaches nothing.

**Check that the claim can fail for the right reason.** Run `check --mutate` (below). It breaks the mechanism on purpose in many small ways, the way a reader might misunderstand it (`pop` for `shift` makes a queue last-in first-out, `<` for `<=` moves a boundary, a deleted line drops a step), and shows which claims turn red. A claim that never does is not testing what its sentence says.

**Make the sentence say exactly what the expression checks.** `check` tests the expression, not the sentence. "The lead grows with every payment" over an expression that allows `>=` is false at the first payment, where the lead stays zero.

**Make at least one claim breakable.** Readers learn where an explanation stops holding by pushing a slider until a claim turns red. `check` prints which slider positions break which claims; lint warns when none do (`W_NOT_BREAKABLE`). A claim that holds for every slider position is fine as well, and a `sweep` is the way to say so.

**Bind every number.** Write `{capacity}` and `{capacity + 1:ord}`, not 10 and 11th. Then the text stays true as sliders move, and a claim that fails really fails.

**Say what the model leaves out.** "No buffer, and a loss hits both flows at once" belongs in the summary. A claim is only as good as the model behind it.

**Keep it true of the real mechanism.** If the claim only holds because of a modelling shortcut (a coarse time step, an unrealistic default), fix the model or narrow the claim, and cite a source for the key fact.

**Say "in this run" when it only holds for this seed.** Random arrivals and jitter come from a seeded generator, so the run is the same every time, but a claim such as "no server ever has more than five jobs waiting" is a fact about this run, not a law of the mechanism.

**A claim with a condition passes outside it.** "Traffic no faster than the refill rate is never turned away" is `rate > refill or steadyRejected == 0`: it says nothing, and passes, when the traffic is faster. Use `sweep` with `holdsWhen` instead when the claim should also fail outside the condition.

**Claims about history need a record.** An expression sees one moment and cannot loop. For "two leaders are never elected in the same term", let the rules note what happened (`if contains(electedTerms, term) { doubleLeader += 1 }`) and claim `never doubleLeader > 0`. Such bookkeeping must only watch: nothing else in the rules may read it.

**Leave room in the run.** `duration` is fixed, so an `eventually` or a late `at` claim fails when a slider makes the scenario take longer than the run, and `check` only moves one slider at a time. Size the run for the slowest combination of sliders.

**Start from a state the mechanism can be in.** A boundary claim such as "no sale is lost while the reorder point covers the demand over the lead time" is false if the shelf starts with less than that. Start the model in a steady, realistic state, or say in the summary why not.

## Testing the Claims: `check --mutate`

`check` proves the expression, not the sentence, and a claim that cannot fail passes as easily as a true one. `check --mutate` tests the tests. It makes mutants of the rules, each one small, deliberate bug, and checks every claim against every mutant, at the current params, with sweeps and compares as usual:

| Operator | Example |
| --- | --- |
| relational | `tokens >= 1` → `tokens > 1`, `==` ↔ `!=` |
| arithmetic | `+` ↔ `-`, `*` ↔ `/`, `+=` ↔ `-=` |
| constant | `20` → `21` and `19` |
| bound | `min(capacity, x)` → `x` or `capacity`, `min` ↔ `max`, `clamp(x, lo, hi)` → `x` |
| list-order | `shift` ↔ `pop`, `push` → `unshift`, a `remove` dropped |
| negate-if, drop-else, delete-statement | `if c` → `if not (c)`, the `else` dropped, one line deleted |
| logical | `and` ↔ `or` |
| emit | an `emit` removed |
| event-time | a scheduled event one tick later |

Mutants are changes to the parsed rules, never to the text, and each has a stable name: `M21 rules.tick:5:12 shift(waiting) → pop(waiting)`. The report gives:

- **per claim, the mutants it kills** (the claim fails on them), with the one fewest other claims catch;
- **claims that never failed**: they restate a rule, pass vacuously, or the scenario never exercises them;
- **survived mutants**, grouped by rule: you could break the mechanism this way and no claim would notice. This is the list to work through;
- the **mutation score**: killed mutants divided by the mutants a claim could see.

Mutants that do not compile or hit a runtime error (a step limit, `E_TYPE`) count as killed by the engine and are listed apart. A mutant whose run is identical, in every state value and signal a claim can see, at the current params and every sweep sample and compare run, is **equivalent**: no claim could ever catch it, so it is left out of the score. A mutant that changes only display state (values that only parts read) or unwatched signals is **visual only**: also left out of the score, but it changes what the reader sees, so look at those numbers. Above 200 mutants, a seeded sample is tested (`--mutate=500` raises the cap).

**Every claim should kill at least one mutant**, and every survivor needs an answer: a new or stronger claim, a scenario that exercises the rule, or, for a change that is truly harmless, an entry in the spec's `mutate.ignore` with the reason:

```json
"mutate": { "ignore": [
  { "mutant": "rules.on.access:6:11 loopPos += 1 → loopPos -= 1", "reason": "The loop visits the hot keys in the opposite order. LRU treats every cyclic order the same way." }
] }
```

Never weaken a claim, or loosen an expression, to raise the score.

### Worked example: first come, first served

A lock serves waiting threads from a queue. The claim says the queue is fair:

```json
"events": [{ "name": "arrive", "at": 1, "count": "threads" }],
"rules": { "tick": ["...", "if holder < 0 and len(waiting) > 0 {", "  holder = shift(waiting)", "  ...", "  emit('enter', holder)", "}"] },
"claims": [{ "id": "fifo", "kind": "whenever", "event": "enter",
  "expr": "len(waiting) == 0 or arrivedAt[payload] <= arrivedAt[waiting[0]]",
  "text": "The thread that gets the lock asked no later than any thread still waiting." }]
```

`check` passes. `check --mutate` says:

```
  fifo        0 kills
  Claims that never failed:
    fifo: this claim may restate a rule, its event may fire too rarely, or the scenario never exercises it; see references/claims.md
  Survived mutants (the rules could break this way and no claim would notice):
    rules.tick
      M21   rules.tick:5:12 shift(waiting) → pop(waiting)  [list-order]
```

Turning the queue into a stack does not break the fairness claim. The expression is fine; the scenario is the problem: every thread arrives in the same burst, so every `arrivedAt` is the same, and "asked no later than" is true whichever thread goes first. A last-in, first-out lock passes too.

Stagger the arrivals, so that order matters:

```json
"events": [{ "name": "arrive", "every": 0.5, "from": 1, "until": "1 + 0.5 * (threads - 1)" }]
```

Now the claim kills the mutant:

```
  fifo        3 kills   (3 only this claim catches)
```

and `M21` is gone from the survivors: with `pop`, the thread that arrived last gets the lock while earlier ones wait, and the claim reports the first time it happens. The fix was the scenario, not the claim; it often is.

## When a Claim Fails

Read the counterexample, then decide:

1. **The model is wrong.** A rule has a bug, a default is unrealistic, or a mechanism is missing. Fix the model; the claim stays.
2. **The claim is wrong.** The real mechanism does not behave that way, or only under a condition. Rewrite the claim to say what is actually true, and say in the reply what was wrong.

Never loosen a tolerance until it passes, swap a claim for an easier one, or delete it to get a green result. When unsure, keep the claim failing and tell the user.

Discrete time can matter: a property that is exact for the continuous mechanism may be off by one tick in the model. Prefer a smaller `dt`, or compute the quantity at the right moment (for example pass it as the emit payload), over widening the tolerance.
