# Spec Format Reference

A working model is one JSON file, by convention `<name>.model.json`. The JSON Schema is `schema/model.schema.json` (add `"$schema": "../schema/model.schema.json"` for editor completion). `working-model check` validates the schema first, then compiles every piece of rule code, binding, caption and claim, then simulates.

## Top-Level Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Page title. |
| `summary` | no | One or two sentences under the title. May use `{param}` holes. State model assumptions here. |
| `sources` | no (expected) | `[{ "title", "url"?, "note"? }]`: where the key facts come from. Shown in the page footer. |
| `id` | no | Short kebab-case id. |
| `timeUnit` | no | Unit shown for time, such as `s`, `days`, `RTT`, `years`. Default `s`. |
| `dt` | yes | Length of one tick in model time. |
| `duration` | yes | Total model time. `duration / dt` ticks are simulated (at most 100000). |
| `seed` | no | Seed for `rand()` and random events. Default 1. Same seed, same run, in Node and in every browser. |
| `params` | no | Sliders (see below). |
| `state` | yes | Starting values (see below). |
| `derived` | no | Named expressions recomputed from state, such as `"fill": "tokens / capacity"`. |
| `events` | no | The scenario: when things happen. |
| `rules` | no | `init`, `tick` and `on.<event>` rule code. |
| `layout` | no | `{ "cols": 12, "rows": 8 }` grid for parts. 2 to 24 each. |
| `parts` | yes | Visual parts; see `parts.md`. |
| `narration` | no | Captions shown during playback. |
| `claims` | yes | At least one; see `claims.md`. |
| `playback` | no | `{ "speed": <model time per second>, "autoplay": true }`. Default speed plays the whole run in about 15 seconds. |
| `lint` | no | `{ "allowNumbers": [72] }`: numbers allowed as literals in text. |
| `limits` | no | `{ "steps": 2000000 }`: rule steps allowed per simulation. |
| `mutate` | no | `{ "ignore": [{ "mutant", "reason" }] }`: surviving mutants of `check --mutate` that are truly harmless (see below). |

## Params

```json
{ "id": "capacity", "label": "Bucket size", "min": 1, "max": 30, "step": 1, "default": 10, "unit": "tokens",
  "help": "One line under the slider.", "format": "int" }
```

- `id` must be a valid name (letters, digits, `_`; not a keyword; not `t`, `dt`, `tick`, `seq`, `batch`, `payload`, `pi`; not starting with `__`).
- `format` controls how the value is shown: `"%"` (0.4 as 40%), `".2"`, `","`, `"int"`.
- `choices: ["round robin", "least connections"]` turns a param into buttons, one per step from `min` to `max`.
- Params are read-only in rules. Copy a param into state if it has to change.

## State

```json
"state": { "tokens": "capacity", "accepted": 0, "queue": [], "mode": "'closed'", "slots": "fill(capacity, '')" }
```

- Numbers, `true`/`false` and lists are used as they are.
- A string is an **expression** over params and earlier state values. A text value therefore needs inner quotes: `"'closed'"`.
- A state value keeps its type: assigning text to a number is `E_TYPE_CHANGE`.

## Events

Events drive the scenario. Each needs a `name` and exactly one of `at`, `every` or `rate`:

| Form | Example | Fires |
| --- | --- | --- |
| one time | `{ "name": "request", "at": 1 }` | at t = 1 |
| several times | `{ "name": "ping", "at": [2, 5, 9] }` | at each time |
| burst | `{ "name": "request", "at": 1, "count": "burst" }` | `burst` firings in the same tick; handlers see `batch = 0, 1, 2 ...` |
| periodic | `{ "name": "request", "every": "1 / rate", "from": 8, "until": 16 }` | every period from `from` (default 0) to `until` (default end) |
| random | `{ "name": "request", "rate": "load", "until": 50 }` | Poisson arrivals at `rate` per unit of time, from the seeded generator |

`at`, `every`, `rate`, `from`, `until` and `count` take numbers or expressions over params. Several event entries may share a name. An event fires in the first tick whose time is at or after it. Each firing runs `rules.on.<name>`; inside a handler `seq` counts firings of that event (0, 1, 2 ...).

## Rules

```json
"rules": {
  "init": "...",                     // once at t = 0, after state is set
  "tick": ["line 1", "line 2"],      // every tick from the first, before that tick's events
  "on": { "request": "..." }         // per event firing
}
```

Rule code is a string or an array of lines. Order within a tick: `tick` rules, then that tick's events in spec order, then a snapshot of the state. Tick 0 runs `init` and events at t = 0, then takes snapshot 0.

### The Rule Language

A tiny language with a hand-written parser and interpreter. There is no `eval`, no `Function`, no member access (`a.b` is a syntax error), and no way to reach JavaScript globals or prototypes: a name is either a local, a state value, a param, a derived value, or one of `t dt tick seq batch payload pi`.

**Values:** numbers, strings (`'x'` or `"x"`), `true`, `false`, `null`, lists `[1, 2, [3]]`. Lists compare by value (`[1, 2] == [1, 2]`).

**Lists are values.** Storing a list copies it: `a = b`, `let x = b`, `[b, b]`, `push(xs, b)` and an `emit` payload all store a copy, so changing `a` afterwards leaves `b` alone. To change a list inside another list, reach it through an index: `push(queues[i], job)`, `queues[i][0] -= 1`. `for x in xs` loops over a copy of `xs`.

**Operators, loosest to tightest:**

| Operators | Notes |
| --- | --- |
| `c ? a : b` | right associative |
| `or`, `\|\|` | short-circuit; both sides must be true/false |
| `and`, `&&` | short-circuit |
| `not`, `!` | `not a == b` means `not (a == b)` |
| `== != < <= > >=` | cannot be chained: `a < b < c` is `E_CHAINED_COMPARISON` |
| `+ -` | `+` also joins two strings or two lists |
| `* / %` | `%` follows the sign of the divisor (`-7 % 3 == 2`); dividing by zero is `E_DIV_ZERO` |
| `-x`, `+x` | unary |
| `**` | right associative; `-2 ** 2 == -4` |
| `f(x)`, `a[i]` | calls and indexing; negative indexes count from the end |

No implicit conversions: `1 + 'a'` and `if 1 { }` are `E_TYPE`. Use `str(x)` to turn a value into text.

**Statements:**

```
let x = 1                  # a local, visible to the end of its block
x = 2; x += 1              # = += -= *= /= %= **=
xs[0] = 5; grid[i][j] += 1 # list elements
if a { } else if b { } else { }
while cond { break; continue }
for item in list { }       # iterates a copy of the list
emit('name')               # fires a signal for links, pulses and whenever claims
emit('name', payload)
```

Comments start with `#` or `//`. Newlines end statements, except inside `( )` and `[ ]`; `;` also separates statements.

**Functions.** Pure ones can be used anywhere (bindings, captions, claims); the others change a list, draw random numbers or fire a signal, so they are only allowed in rules (`E_IMPURE` elsewhere).

| Pure | |
| --- | --- |
| maths | `min max abs floor ceil round(x, digits?) sqrt pow exp log(x, base?) clamp(x, lo, hi) sign sin cos` |
| lists | `len contains indexOf count slice(list, start, end?) sum mean range(n) range(a, b) fill(n, value) sorted reversed` |
| text | `str(x)`, and `len`, `slice`, indexing on strings |

| Rules only | |
| --- | --- |
| random | `rand()`, `rand(max)`, `rand(lo, hi)`, `randint(lo, hi)`, `chance(p)`, `pick(list)` |
| lists | `push(list, x)`, `unshift(list, x)`, `insert(list, i, x)`, `pop(list)`, `shift(list)`, `remove(list, x)`, `removeAt(list, i)` |
| signals | `emit('name', payload?)`. The name must be a quoted literal, so links and claims can be checked before running. It must not reuse the name of a scheduled event. |

**Limits.** Each simulation may run at most `limits.steps` steps (default two million; `E_STEP_LIMIT`). A statement is one step, and a function that copies or scans a list (`fill`, `range`, `sum`, `contains`, `sorted`, `==` on lists, storing a list) costs one more step per item, so copying a big list every tick adds up. Lists hold at most 10000 items and one list value at most a million items counting nested lists (`E_LIST_LIMIT`); strings hold at most 10000 characters; expressions, blocks and nested lists go at most 100 deep (`E_TOO_DEEP`); each code string is at most 20000 characters. The run keeps a copy of the state at every tick, at most ten million values in all (`E_TRACE_LIMIT`: use a larger `dt`, a shorter run or smaller lists). Events may fire at most 200000 times per run, bursts and random arrivals included (`E_EVENT`). One claim check, with all its sweep samples and compare runs, shares a budget of 200 million steps, where each tick also counts as 32 (`E_STEP_LIMIT`). A non-finite number is `E_NONFINITE`.

### Writing Rules That Behave

- **Time is a floating-point number.** `t` is `tick × dt`, so `0.1 × 33` is `3.3000000000000003`, and `t + lead` stored at one tick is not exactly `t` at the later tick. Comparing such times with `<=` or `==` silently fires a tick late, or never. Store tick numbers instead, `due = tick + round(lead / dt)` and `tick >= due`, or count ticks down. The same goes for countdowns: `left -= dt` drifts, so `left <= 0` can come a tick late.
- **Exact boundaries meet rounding noise.** When a claim's boundary is an equality (no sale is lost while `reorder >= demand * lead`), sliders can land exactly on it, and `0.7 + 0.7 + ...` then comes out `1e-14` short, which turns `lost > 0` true. Keep quantities that should be exact rounded (`stock = round(stock - sold, 6)`) or count them in whole units.
- **There are no user functions.** To run the same code from `init` and from a handler, put it once in `rules.tick` behind a flag (`dirty = true` in the handler, `if dirty { ...; dirty = false }` in the tick), or repeat it.
- **Prefer parallel lists to lists of pairs.** `sorted` only sorts numbers or strings, and expressions cannot map over a list, so `dueTick` and `dueQty` side by side are easier than `[[tick, qty], ...]`: `sum(dueQty)` is then the amount on order.
- **Bindings are not tested, unless you say what they should show.** A part, chart or caption can show a wrong number while every claim passes. Give counters, gauges and tanks an `expect` (an independent expression; see `parts.md`), look at the screenshot, and claim anything a reader will rely on.

## Text Templates

`summary`, captions, claim text and some part texts are templates. Write `{expression}` or `{expression:format}`:

| Format | Example | Shows |
| --- | --- | --- |
| none | `{tokens}` | `9.2`, `10`, `12,345` |
| `.N` | `{tokens:.1}` | fixed decimals |
| `,` / `,.N` | `{balance:,.0}` | thousands separators |
| `%` / `.N%` | `{share:%}` | 0.417 as `42%` |
| `int` | `{I:int}` | rounded |
| `ord` | `{capacity + 1:ord}` | `11th` |

`{{` and `}}` give literal braces. Captions may use state and derived values (they update as the animation plays); `summary` and claim text may use params only.

## Narration

```json
{ "from": 1, "to": 3, "text": "The first {capacity} requests spend the stored tokens.", "cites": ["burst-passes"] }
```

`to` defaults to the next caption's `from`. `cites` lists claim ids; the page shows each as a live pass or fail chip, and a caption that cites a failing claim is marked.

## Lint

`check` lints every spec:

| Code | Severity | Meaning |
| --- | --- | --- |
| `W_LITERAL_NUMBER` | warning | A number typed into a caption or claim text instead of bound to the model. The fix suggests the binding (`{capacity}`, `{capacity + 1:ord}`). `0`, `1` and `lint.allowNumbers` are allowed. A constant in braces, such as `{300}`, counts too. |
| `W_UNCITED_CLAIM` | warning | No caption cites the claim. |
| `E_CITES_FAILING_CLAIM` | error | A caption cites a claim that fails at the default params. |
| `W_CONSTANT_CLAIM` | warning | The claim only looks at params, so it says nothing about behaviour. |
| `W_VACUOUS_CLAIM` | warning | A `whenever` claim whose event never fires at the defaults. |
| `W_NOT_BREAKABLE` | warning | No slider at either end makes any claim fail. |
| `W_PARAM_EXTREME_ERROR` | warning | The model itself fails at a slider's end. |
| `E_BINDING_EXPECT` | error | A counter, gauge or tank shows a different value than its `expect` at some tick of the default run. |

## Mutation Testing

`check --mutate` tests the claims: it compiles small deliberate bugs into the rules (mutants) and reports which claims catch them. `references/claims.md` explains the operators, the report and how to act on it.

| Option | Meaning |
| --- | --- |
| `--mutate`, `--mutate=N` | Test up to N mutants (default 200); above N, a sample drawn with a seeded generator, so the same spec gives the same sample. |
| `--mutate-seed s` | Seed for that sample (default: the spec's `seed`). |
| `--mutate-strict` | Exit 1 when a claim never fails, or the score is below `--min-score`. |
| `--min-score P` | With `--mutate-strict`: the lowest acceptable score, in percent. |
| `--json` | The full report under `mutation`: per mutant `id`, `op`, `at`, `change`, `key`, `status` (`killed`, `engine`, `equivalent`, `visual`, `ignored`, `survived`) and `killedBy`; per claim its kills; the counts and `score`. |

`build --mutate` and `gallery` store the score in the page, which shows it under the claims. A page never computes a score itself.

A mutant that is truly harmless (it renames something, or reorders something the mechanism treats alike) goes into `mutate.ignore`, keyed by the text `check --mutate` prints after the id, location and change together:

```json
"mutate": { "ignore": [
  { "mutant": "rules.on.access:3:29 20 → 21", "reason": "Only renames the scan keys. Any names the loop never uses behave the same." }
] }
```

Ignored mutants are left out of the score and listed with their reasons. An entry that matches no surviving mutant (it is killed now, or the rule changed) is reported as `W_MUTATE_IGNORE_UNUSED`. The key holds a line and column, so it goes stale when the rule above it changes; `check --mutate` says so.

## Error Codes

Errors carry a code and a location `path:line:col` with the offending line underlined.

| Code | Cause |
| --- | --- |
| `E_JSON` | The file is not valid JSON (line and column given). |
| `E_SCHEMA_REQUIRED`, `E_SCHEMA_TYPE`, `E_SCHEMA_ENUM`, `E_SCHEMA_UNKNOWN_KEY`, `E_SCHEMA_RANGE`, `E_SCHEMA_PATTERN`, `E_SCHEMA_ITEMS` | The JSON does not match the schema. Unknown keys get a "did you mean" hint. |
| `E_SYNTAX`, `E_UNTERMINATED_STRING`, `E_CHAINED_COMPARISON`, `E_USELESS_EXPRESSION`, `E_ASSIGN_IN_EXPRESSION`, `E_TOO_DEEP`, `E_TOO_LONG` | The rule code does not parse. |
| `E_UNKNOWN_NAME`, `E_UNKNOWN_FUNCTION`, `E_ARITY`, `E_IMPURE`, `E_SHADOW`, `E_DUPLICATE_LET`, `E_ASSIGN_READONLY`, `E_BREAK_OUTSIDE_LOOP`, `E_EMIT_NAME` | The rule code parses but refers to something it cannot. |
| `E_NAME`, `E_DUPLICATE_NAME`, `E_PARAM_RANGE`, `E_STATE_VALUE`, `E_TIME`, `E_EVENT`, `E_UNKNOWN_EVENT`, `E_UNKNOWN_SIGNAL`, `E_UNKNOWN_PART`, `E_UNKNOWN_CLAIM`, `E_UNKNOWN_PARAM`, `E_PART`, `E_PART_TYPE`, `E_LAYOUT`, `E_LAYOUT_BOUNDS`, `E_LAYOUT_OVERLAP`, `E_CLAIM`, `E_CLAIM_KIND`, `E_TEMPLATE` | The spec is inconsistent. |
| `E_TYPE`, `E_TYPE_CHANGE`, `E_DIV_ZERO`, `E_INDEX`, `E_EMPTY_LIST`, `E_DOMAIN`, `E_NONFINITE`, `E_LIST_LIMIT`, `E_STRING_LIMIT`, `E_STEP_LIMIT`, `E_TRACE_LIMIT`, `E_CLAIM_NOT_BOOLEAN`, `E_CLAIM_TIME` | Found while simulating; the message gives the simulated time. |
