# working-model Reference

The long-form material from the README: the full walkthrough, every command, the spec at a glance and how the tool keeps explanations honest. The README links here; [SKILL.md](../SKILL.md) is what the agent follows.

## A Full Walkthrough

You ask: *"Explain how a token bucket rate limiter works."*

1. The agent writes `token-bucket.model.json`: a bucket of `capacity` tokens refilling at `refill` per second, a burst of requests at t = 1 s, then steady traffic, and six claims. One of them:

   ```json
   { "id": "excess-rejected", "kind": "at", "t": 1, "expr": "rejected == burst - capacity",
     "text": "From the {capacity + 1:ord} request on, every request in the burst is rejected." }
   ```

2. It runs the check:

   ```
   $ working-model check token-bucket.model.json
   token-bucket.model.json - Token Bucket Rate Limiter
     9 parts, 4 params, 161 ticks, 12 ms

     PASS  burst-passes            A full bucket lets exactly the first 10 requests of the burst through.
     PASS  excess-rejected         From the 11th request on, every request in the burst is rejected.
     PASS  never-beyond-envelope   From the start to any moment t, no more than 10 + 2 × t requests get through: the burst allowance plus the refill rate.
     PASS  slow-traffic-passes     Steady traffic no faster than the refill rate is never turned away and leaves the bucket within two tokens of where it started; faster traffic drains it. This needs a bucket big enough to absorb uneven arrival times.
     PASS  refills-before-traffic  After the burst, the bucket is full again before steady traffic starts.
     PASS  holds-to-refill-rate    Once traffic outpaces the refill rate long enough to drain the bucket, requests pass at the refill rate, 2 per second.

     Sliders that break a claim:
       capacity = 1 breaks slow-traffic-passes
       capacity = 30 breaks burst-passes, excess-rejected, refills-before-traffic, holds-to-refill-rate
       refill = 0.5 breaks refills-before-traffic
       refill = 8 breaks holds-to-refill-rate
       burst = 1 breaks burst-passes, excess-rejected
       rate = 0.5 breaks holds-to-refill-rate

     6/6 claims pass
   ```

3. It tests the claims by breaking the rules on purpose:

   ```
   $ working-model check token-bucket.model.json --mutate
     ...
     excess-rejected         18 kills
                             e.g. M8 rules.on.request:1:1  if tokens >= 1 { … } else { … } → if tokens >= 1 { … }
     ...
     Survived mutants (the rules could break this way and no claim would notice):
       rules.on.request
         M23   rules.on.request:4:8 t > 12 → t >= 12  [relational]
     ...
   ```

   Every claim catches some broken version of the rules, and each surviving mutant is a question for the agent: add a claim, or explain why the change cannot be seen.

4. It builds the page and checks the layout at desktop and phone sizes:

   ```
   $ working-model build token-bucket.model.json -o token-bucket.html
   $ working-model layout token-bucket.model.json
   ```

5. You open `token-bucket.html`, offline. Press play, scrub through time, step tick by tick with the arrow keys, and drag any slider. Every claim re-checks on the spot. Push the burst below the bucket size and "the first 10 requests pass" fails, because there were never 10 requests: that is where the explanation stops holding.

A longer worked example, step by step: [references/walkthrough.md](../references/walkthrough.md).

## Commands

```bash
node scripts/working-model.mjs check examples/                 # every example, every claim
node scripts/working-model.mjs build examples/lru-cache.model.json -o lru.html
node scripts/working-model.mjs new my-model --dir ./models      # a spec that passes, to edit
```

| Command | What it does |
| --- | --- |
| `check <spec or folder>` | Schema, compile, simulate, claims, lint. Prints `N/N claims pass` or each failure with its counterexample. `--json`, `--strict`, `--set name=value`. Exit 0 pass, 1 failing claim or lint error, 2 invalid spec. |
| `check --mutate` | Mutation testing for the claims: per claim the mutants it kills, the claims that never fail, the mutants no claim catches, and a score. `--mutate=N` caps the mutants (default 200, seeded sample above that); `--mutate-strict` with `--min-score 80` exits 1 on a weak result. |
| `build <spec> -o page.html` | One standalone page, no network requests. Refuses to build while a claim fails, unless `--force`. `--mutate` stores the mutation score in the page. |
| `new <name>` | Scaffolds a small spec that passes `check` and `layout`. |
| `gallery` | Builds every example, with its mutation score, and `gallery/index.html`. `--thumbs` adds screenshots. |
| `layout <spec>` | Opens the page in headless Chrome at 1280 by 800 and 390 by 844, and fails on overlapping parts, clipped or colliding text, or sideways scrolling. Writes screenshots. |
| `snap <spec> --at <t> -o shot.png` | A screenshot at a moment, optionally with `--set` slider values. |
| `gif <spec> -o anim.gif` | An animated GIF via ffmpeg, optionally dragging a slider (`--drag vaccinated=0.4..0.15@6..8`). |

`layout`, `snap` and `gif` drive a locally installed Chrome, Edge or Chromium over the DevTools protocol (set `WORKING_MODEL_CHROME` to pick one). Nothing is downloaded. `gif` also needs `ffmpeg`. `check` and `build` need Node 20 or newer; `layout`, `snap` and `gif` need Node 22 or newer, for the built-in WebSocket client.

## The Spec At A Glance

```json
{
  "title": "Token Bucket Rate Limiter",
  "summary": "A bucket holds up to {capacity} tokens and refills at {refill} per second.",
  "sources": [{ "title": "RFC 2697", "url": "https://www.rfc-editor.org/rfc/rfc2697" }],
  "dt": 0.1, "duration": 16, "seed": 7,
  "params": [{ "id": "capacity", "label": "Bucket size", "min": 1, "max": 30, "step": 1, "default": 10 }],
  "events": [{ "name": "request", "at": 1, "count": "burst" }],
  "state": { "tokens": "capacity", "accepted": 0, "rejected": 0 },
  "rules": {
    "tick": "tokens = min(capacity, tokens + refill * dt)",
    "on": { "request": "if tokens >= 1 { tokens -= 1; accepted += 1; emit('accept') } else { rejected += 1; emit('reject') }" }
  },
  "parts": [{ "id": "bucket", "type": "tank", "at": [4, 0, 4, 4], "level": "tokens / capacity", "text": "{tokens:.1} of {capacity}" }],
  "narration": [{ "from": 1, "to": 3, "text": "The first {capacity} requests spend the stored tokens.", "cites": ["burst-passes"] }],
  "claims": [{ "id": "burst-passes", "kind": "at", "t": 1, "expr": "accepted == capacity", "text": "A full bucket lets the first {capacity} requests through." }]
}
```

- **Params** become sliders (or buttons, with `choices`).
- **State** holds numbers, true/false, text and lists. **Rules** are written in a small, safe rule language with `if`, `while`, `for`, `let`, lists and 38 built-in functions, and no access to anything outside the model.
- **Events** are the scenario: one-off, bursts, periodic, or random arrivals from a seeded generator.
- **Parts**: box, tank, queue, stack, grid, counter, gauge, lamp, multi-state node, link with animated particles, chart, label and group, placed on a grid.
- **Narration** captions show live values through `{expression}` holes and cite the claims they rely on.

Full reference: [references/spec.md](../references/spec.md), [references/parts.md](../references/parts.md), [references/claims.md](../references/claims.md), and a worked example in [references/walkthrough.md](../references/walkthrough.md). JSON Schema: [schema/model.schema.json](../schema/model.schema.json).

## How It Stays Honest

- **One engine.** The simulator, claim checker and lint are plain JavaScript modules with no dependencies. `check` runs them in Node, and `build` inlines the very same modules into the page. A test evaluates the inlined copy and the modules side by side on every example, and the browser tests compare the page's claim results with Node's, claim by claim.
- **Claims are tests.** `check` exits non-zero when a claim fails, and `build` refuses to build until it passes. The skill tells the agent never to weaken or delete a claim to make it pass, and to say whether the model or the claim was wrong.
- **The claims are tested too.** `check --mutate` compiles small deliberate bugs into the parsed rules and re-checks every claim against each one. A claim that never fails, or a bug no claim catches, is reported by name and location; the skill tells the agent to answer each one with a stronger claim, a better scenario or a stated reason.
- **Numbers in text are bound.** Lint flags any number typed into a caption or claim text instead of bound to the model, and suggests the binding (`{capacity}`, `{capacity + 1:ord}`), so the text stays true when a slider moves. A caption that cites a failing claim is an error.
- **Deterministic.** Random draws come from a seeded generator that uses only 32-bit integer maths, so the same spec gives the same run in Node and in Chrome, Edge and other Chromium browsers. Other browsers may round `exp`, `log`, `pow`, `sin` and `cos` differently in the last digit, which can change a random arrival or a claim that sits exactly on its threshold.
- **Safe rules.** The rule language is parsed and interpreted by hand-written code: no `eval`, no `Function`, no member access, no globals. Steps, list work, list and value sizes, nesting, event firings, the stored trace and the total work of one claim check are all bounded, so a spec from a stranger fails with an error code instead of hanging or running out of memory.
- **Offline pages.** A strict Content Security Policy (`default-src 'none'`) means a built page cannot load anything from the network, and it allows only the page's own two scripts, by hash. Spec text (titles, labels, captions, claims, values) is always inserted as text, never as HTML.
