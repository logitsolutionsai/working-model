# Architecture

Working Model has three layers: an engine that runs anywhere, a Node command line around it, and a page runtime that runs the same engine in the browser.

```
spec.model.json
      │
      ▼
src/node/validate-schema.mjs ── checks the JSON against schema/model.schema.json
      │
      ▼
src/engine/  (no dependencies, no Node or browser APIs)
  lexer.mjs ─► parser.mjs ─► compile.mjs     rule language: tokens, Pratt parser, closures
  format.mjs                                 number formats and {expression} templates
  model.mjs                                  names, references, parts, captions, claims → a compiled model
  simulate.mjs                               discrete-time run → trace (snapshots, emits, firings)
  claims.mjs                                 seven claim kinds, sweeps, compares, counterexamples
  lint.mjs                                   literal numbers, citations, slider probes
  index.mjs                                  analyze(): all of the above in one call
  mutate.mjs                                 check --mutate: mutants of the rules, claims against each (Node only)
      │                         │
      ▼                         ▼
src/node/check.mjs        src/node/build.mjs ── inlines the engine + src/page/runtime.js + page.css
(terminal, JSON)                │
                                ▼
                         page.html (offline) ── same engine, re-run on every slider move
                                │
                                ▼
src/node/chrome.mjs + capture.mjs ── layout, snap, gif through Chrome's DevTools protocol
```

## The Engine

### Rule Language

`lexer.mjs` turns source into tokens; newlines end statements except inside brackets. `parser.mjs` is a Pratt parser: each operator has a binding power, prefix handlers parse literals, names, lists, unary operators and grouping, and infix handlers parse binary operators, calls, indexing and the ternary. Statements (`let`, assignment, `if`, `while`, `for`, `break`, `continue`, call statements) are parsed by a small recursive-descent layer on top.

`compile.mjs` turns the syntax tree into JavaScript closures. Every name is resolved at compile time against a scope: locals (stored in numbered slots), state, params, derived values and a fixed set of implicit names (`t`, `dt`, `tick`, `seq`, `batch`, `payload`, `pi`). Anything else is `E_UNKNOWN_NAME`, so there is no way to name a JavaScript global. There is no member access in the grammar, indexing only works on lists and strings with whole-number indexes, and state and params live in objects created with `Object.create(null)`. Built-in functions are a fixed table; each knows whether it is pure (allowed in bindings and claims) or not (random, list-mutating, emit).

Every statement and loop iteration increments a step counter, and every builtin that copies or scans a list adds one step per item; exceeding the limit throws `E_STEP_LIMIT`. Lists are values: assignment, `let`, list literals, `push` and emit payloads store a bounded copy (`copyIn`), so no two names share a list and no value can grow past `LIMITS.cells` items or `LIMITS.depth` levels. Parse depth, list sizes, string sizes and source length are bounded as well. Every error is a `ModelError` with a code and a location `{ path, src, pos }`, from which the line, column and an underlined excerpt are computed.

### Compiled Model

`model.mjs` checks the spec as a whole and collects every error rather than stopping at the first: names (valid, unique, not reserved), param ranges, the order of state initial values, event definitions, rule handlers for known events, part types and grid placement, static overlap of solid parts, links between existing parts, signals that are actually emitted, captions and the claims they cite, and every claim's expressions. The result holds compiled closures for everything the simulator and the page evaluate.

### Simulation

`simulate.mjs` runs ticks `0..K` where `K = duration / dt`. Tick 0 sets the starting state, runs `rules.init` and the events at time 0. Each later tick runs `rules.tick`, then the events whose times fall in that tick, in spec order, then records a deep copy of the state; the copies of one run may hold at most `LIMITS.traceCells` values (`E_TRACE_LIMIT`), and all event firings together at most 200000. Deterministic events are scheduled in advance; random arrivals use a Poisson draw from the seeded generator (`rng.mjs`, mulberry32, which uses only 32-bit integer operations, so every JavaScript engine produces the same uniform sequence; the Poisson draw and rule code that call `exp`, `log`, `pow`, `sin` or `cos` can still differ in the last digit outside V8).

The trace holds the snapshots, every `emit` with its tick and payload, and every event firing. Observers can watch named signals while the run happens, which is how `whenever` claims see the state right after a handler and the payload of an emit.

### Claims

`claims.mjs` evaluates `at`, `always`, `never` and `eventually` on the recorded snapshots, and `whenever` through observers during the run. A `sweep` draws a seeded Latin hypercube sample of the varied params, snaps each value to its slider step, and runs the inner claim per sample; with `holdsWhen`, it checks both sides of the boundary. A `compare` runs the model twice with overridden params and reduces a measure (`max`, `min`, `mean`, `sum`, `final`, `at`). Every run made for one `checkClaims` call draws on one budget (`LIMITS.checkSteps`, with each tick counted as 32 steps), so many sweep samples cannot add up to minutes of work in `check` or in the page. Every failure carries a counterexample object and a one-line explanation built from it.

### Lint and Probes

`lint.mjs` scans the literal text of captions and claims for numbers (allowing 0, 1 and `lint.allowNumbers`), and the `{holes}` for constants such as `{300}`, and suggests bindings by matching param defaults and starting values. A counter, gauge or tank with an `expect` is compared with that expression at every snapshot of the default run (`E_BINDING_EXPECT` at the first difference), which is the only way a part binding gets tested. `probeParams` re-checks every claim with each slider at its minimum and maximum; the result feeds the "Sliders that break a claim" report and the `W_NOT_BREAKABLE` warning.

### Mutation Testing

`mutate.mjs` tests the claims themselves. `enumerateMutants` parses every rule program (`rules.init`, `rules.tick`, `rules.on.*`) and walks the syntax tree in a fixed pre-order, so the n-th node of a copy is the n-th node of the original. At each node it records the mutations that apply (relational, arithmetic and logical swaps, off-by-one constants, a `min`, `max` or `clamp` dropped or swapped, `shift` and `pop` or `push` and `unshift` swapped, a `remove` or `emit` dropped, an `if` negated, an `else` dropped, a statement other than `let` deleted) plus one per scheduled event (one tick later). Mutants are numbered `M1, M2, ...` in that order, and keyed by location and change (`rules.tick:5:12 shift(waiting) → pop(waiting)`); positions come from the parser, so the line and column are those an error would show.

`buildMutant` copies the tree, changes one node in place (`replaceNode` swaps in a child for a dropped bound; a deleted statement becomes `if false {}`), compiles only that program with `compileProgramAst` and returns a shallow copy of the compiled model with that one rule replaced; an event mutant wraps the event's time closure instead. The original model is never touched.

`mutateClaims` first requires every claim to pass, then measures the steps one claim check of the original takes and gives each mutant four times that (at least four million), so a mutant that loops forever stops at the budget. Above the cap (200), a seeded sample keeps the stable ids. Each mutant runs `checkClaims` as usual. A claim that fails kills it; a compile error, a runtime error in the default run, or an error in a sweep sample or compare run counts as killed by the engine. A mutant no claim catches is fingerprinted: `fingerprint` hashes each run twice, once over what claims can see and once over everything. What claims can see comes from `claimVisible`: the state names claim expressions read (through derived values), closed over the rules' data and control dependences (each assignment and list call is an edge from the names it reads, including enclosing conditions, to the name it writes; loops with `break` or `continue` make all their conditions context), plus the signals `whenever` claims watch. It over-approximates, so a change is never wrongly classed as invisible. If both hashes match the original at every param set the claims use (the current params, every sweep sample, both sides of every compare), the mutant is equivalent; if only the full hash differs, it is visual only; otherwise it survived, unless `mutate.ignore` lists its key.

The score is killed (by claims or the engine) over killed plus survived. `check.mjs` formats the report and `--json` returns it whole; `build.mjs` stores a summary (`pageMutation`) as a JSON block in the page, which the runtime only displays.

## The Page

`build.mjs` reads the engine modules in dependency order, strips their `import` lines and `export` keywords, checks that no two modules declare the same top-level name, and wraps them in one function that returns the public API as `WM`. That bundle, the spec as JSON, `runtime.js` and `page.css` are inlined into one HTML file with a Content Security Policy of `default-src 'none'`, so the page cannot make a network request. Its `script-src` lists the SHA-256 hashes of the two inline scripts (line endings normalised to LF first, as the HTML parser does), not `'unsafe-inline'`, so no other script can run even if spec text ever reached the page as markup; the runtime only ever inserts spec text with `textContent`.

`runtime.js`:

- compiles the spec with `WM.compileModel` and runs `WM.checkClaims` at the current params (once at load, and again on every slider move, batched to one run per animation frame);
- draws the diagram as SVG in a viewBox of 80 by 64 units per grid cell. Each part has a `layout` step (geometry, depends on the current scale) and an `update` step (values at the current moment);
- interpolates between ticks for smooth motion (tank level, gauge needle, chip positions, chart heads), precomputes particle schedules from the trace, and plays with `requestAnimationFrame`;
- keeps text readable: every text has a size at full scale and a minimum on-screen size, and parts re-lay themselves out when the scale changes (one-line counters, wrapped box text, legend on its own row, single-state nodes);
- exposes `window.workingModel` (time control, params, summary, and `layoutReport()`), which the `layout` command and the browser tests use.

`layoutReport()` measures the rendered page: parts outside the diagram, overlapping parts, text spilling out of its part or its pill, texts colliding inside a part, text rendered below 7.5 pixels, sideways page scroll, and binding errors.

## Command Line

`scripts/working-model.mjs` parses arguments and dispatches. `check.mjs` formats reports for the terminal or as JSON. `chrome.mjs` finds a local Chrome, Edge or Chromium, starts it headless with a throwaway profile on 127.0.0.1 and a random port, and speaks the DevTools protocol over Node's built-in WebSocket. `capture.mjs` builds a temporary page, opens it, and runs the layout check at 1280 by 800 and 390 by 844 at several moments, or captures screenshots and GIF frames (assembled with ffmpeg, retried at smaller widths until the file is under the size limit).

The command line has no runtime dependencies. `playwright-core` is a development dependency used only by the browser tests.

## Tests

- `tests/dsl.test.mjs`: lexer, operator precedence, every statement type, list functions, error codes and locations, and the security properties of the rule language.
- `tests/engine.test.mjs`: determinism, scheduling, every claim kind with its counterexample, sweeps, compares, lint rules and formatting.
- `tests/spec.test.mjs`: the schema file is current; broken fixtures fail with the expected codes and paths; every example passes `check`, has a breakable claim and sources; the examples together use every part and claim kind; the inlined bundle gives the same results as the modules; built pages are offline; the CLI's exit codes and outputs.
- `tests/mutate.test.mjs`: every mutation operator with its location, stable numbering, mutants that run as intended, equivalent and visual-only detection across sweep samples, engine kills and the step budget, `mutate.ignore`, the seeded cap, the CLI (`--json`, `--mutate-strict`, `--min-score`, `build --mutate`), the first-come-first-served teaching case from `references/claims.md`, and that the scores in the gallery pages, the gallery index and the README equal what the CLI computes.
- `tests/e2e/pages.e2e.mjs`: every example in headless Chrome with all requests aborted: claims panel equals Node, playback, keyboard, the layout report at both sizes, sliders and choice buttons that flip claims and reset, dark theme and reduced motion.
