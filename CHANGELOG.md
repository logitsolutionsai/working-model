# Changelog

## 0.1.0 (2026-11-14)

First release.

- Spec format `*.model.json` with params, state, derived values, events, rules, parts, narration and claims, and a JSON Schema in `schema/model.schema.json`.
- A small, safe rule language: hand-written lexer, Pratt parser and closure compiler; no `eval`, no member access, no globals; step, size and depth limits; error codes with exact locations.
- Discrete-time simulator with seeded random numbers, bursts, periodic and random events, and signals through `emit`.
- Seven claim kinds: `at`, `always`, `never`, `eventually`, `whenever` (with optional `within`), `sweep` (with optional `holdsWhen` boundary checks) and `compare`, each reporting its first counterexample.
- Lint for literal numbers in text, uncited claims, captions that cite failing claims, constant and vacuous claims, and claims no slider can break.
- Command line: `check`, `build`, `new`, `gallery`, `layout`, `snap`, `gif` and `schema`, with no runtime dependencies.
- Offline pages with animation, scrubber, step and speed controls, sliders and choice buttons, a live claims panel, captions that cite claims, light and dark themes, phone layout, keyboard control and reduced-motion support.
- Thirteen part types: box, tank, queue, stack, grid, counter, gauge, lamp, node, link, chart, label and group.
- Eleven examples: token bucket, backoff with jitter, LRU cache, TCP AIMD, circuit breaker, SIR epidemic, load balancing, compound interest, Bloom filter, Raft leader election and inventory reorder point.
- Agent skill (`SKILL.md` and `references/`) and Claude Code plugin and marketplace manifests.
- Mutation testing for claims: `check --mutate` compiles small deliberate bugs into the parsed rules (boundary, arithmetic, logical and constant swaps; a `min`, `max` or `clamp` dropped; `shift` and `pop` swapped; an `if` negated, an `else` or a statement dropped; an `emit` removed; an event a tick late), checks every claim against each, and reports what each claim kills, the claims that never fail, the mutants no claim catches (grouped by rule), and a mutation score. Equivalent and visual-only mutants are detected and left out of the score; `--mutate=N` caps the count with a seeded sample; `--mutate-strict` and `--min-score` turn it into a gate; `mutate.ignore` in the spec records truly harmless survivors with a reason. `build --mutate` and `gallery` store the score in the page. The skill now runs it after `check` passes, and `references/claims.md` walks through a first-come-first-served claim that only fails once the arrivals are staggered.

- Part bindings can be tested: a `counter`, `gauge` or `tank` takes an optional `expect`, an independent expression for what it should show, and `check` fails with `E_BINDING_EXPECT` (the first moment and both values) when the two differ at the default params.

Hardening before the first release:

- Lists are values: assignment, `let`, list literals, `push` and emit payloads store copies, so `a = b; push(a, 1)` no longer changes `b`, and `[xs, xs]` can no longer double shared structure until Node runs out of memory.
- List work counts towards the step limit (one step per item copied or scanned); one list value holds at most a million items and nests at most 100 deep; the stored trace holds at most ten million values (`E_TRACE_LIMIT`); bursts and random arrivals share the 200000-firing cap with periodic events; all the runs of one claim check (sweep samples, compares) share one budget. Each of these was a hang or an out-of-memory crash from a few lines of spec.
- Built pages allow their two scripts by SHA-256 hash instead of `'unsafe-inline'`.
- Part ids, claim ids, event names and emit names may not start with `__`; the page uses prototype-free maps for names from the spec.
- The schema check no longer lets keys such as `constructor` or `toString` past as known fields, and very deep JSON is refused with `E_TOO_DEEP` instead of a stack overflow.

Fixes:

- `{300}` in a caption or claim text is reported as a literal number.
- `layout` warns when a link is drawn across another part (`W_LINK_CROSSES`).
- The page clock shows the time of the tick whose values are on screen.
- `check --set` warns about a name that is not a param; `new` quotes a path with spaces in its next step; a wrong `WORKING_MODEL_CHROME` gets a message that says how to fix it, and a failed launch no longer leaves the process or its profile behind; `snap` and `gif` remove their temporary folders.

Examples and docs:

- Claims that only read back a rule were replaced with emergent ones or removed: token bucket (traffic envelope, slow traffic passes), backoff (full jitter gets clients through sooner), circuit breaker (one trial call per cooldown), LRU (no Belady anomaly, the scan costs twice), SIR (final-size law; the peak is now observed on the curve), TCP AIMD and load balancing (restatements removed). Wording fixes in compound interest, load balancing, Bloom filter, backoff and circuit breaker.
- Claims strengthened after mutation testing: LRU (`no-belady` compared two runs with identical hits, so it could never fail; it now compares a loop that fits with one that does not, and `fits-then-hits` checks the hits its sentence promises), circuit breaker (`opens-quickly` checks the breaker opens after exactly the threshold of failed calls, not just by a deadline; `one-trial-per-cooldown` also requires a trial call), compound interest (`rule-of-72` was a `whenever` claim that passed when money never doubled at all), Bloom filter (`matches-fill` passed when no new item was ever checked), load balancing (a new `rr-a-third` claim: round robin was only ever compared with least connections, so any bug that made it worse passed; the caption that says round robin hands the slow server a third of the traffic now cites it).
- Survivors that hit the mechanism each example teaches were closed: LRU (`keeps-most-recent`: the cache always holds the most recently used keys, so a hit that failed to refresh a key's recency is caught; 98% to 100%), Bloom filter (a lookup now counts the bits it finds set, and `no-false-negatives` requires that added items were checked, so a lookup that checks no bits no longer passes vacuously; 67% to 76%), circuit breaker (every other call fails before the outage, and `ignores-scattered` says the breaker never opens, so dropping the streak reset is caught; 88% to 92%), load balancing (`no-job-skipped`: work done plus work queued equals work arrived, which catches a server that drops waiting jobs, such as `pop` for `shift`; `first-come-first-served`: every job behind the one in service is untouched and in arrival order, which catches a new job jumping the queue; 84% to 92%), token bucket (`slow-traffic-passes` was a conditional claim, `rate > refill or steadyRejected == 0`, that checked nothing when traffic was faster; it is now a `sweep` with `holdsWhen: rate <= refill` that reads the real rejection count and also requires faster traffic to drain the bucket, and the `steadyRejected` counter it needed is gone; 82% to 94%), backoff (`within-one-cap`: every client gets through within one longest wait of the server coming back, which catches a backoff with no cap; 60% to 62%).
- The references now cover floating-point time, exact boundaries, value semantics, sharing code without functions, how to spot a claim that restates a rule, mutation-checking claims, "in this run" claims, conditional claims and run length.
- `npm run gallery` (`gallery --thumbs`) rendered thumbnails into the gallery folder, which replaced each page with one built without its stored mutation score; thumbnails now render in a temporary folder.
