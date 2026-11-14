# Parts Reference

Parts are the visual primitives. Each is placed on the layout grid with `"at": [col, row, width, height]` in whole cells (default grid 12 by 8). Solid parts may not overlap (`E_LAYOUT_OVERLAP`); a `group` may surround others. Links connect parts and have no `at`.

Every binding is an expression over state, derived values, params and `t`, evaluated at each moment. Text fields are templates (`"{accepted} served"`).

## Fields Every Part Accepts

| Field | Meaning |
| --- | --- |
| `id` | Unique; links refer to it. Letters, digits, `-` and `_`, not starting with `__`. |
| `type` | One of the types below. |
| `label` | Small uppercase caption in the top-left corner. Keep it short: it must fit at phone width. |
| `visible` | Expression; the part is drawn only while it is true. |
| `highlight` | Expression; an accent ring is drawn while it is true. |
| `pulse` | Event or emit name(s); the part flashes briefly when they happen. |
| `tone` | `ink`, `muted`, `accent`, `ok`, `bad`, `warn`, `soft`, `info`, a `#rrggbb` colour, or an expression returning one, such as `"lastHit ? 'ok' : 'bad'"`. The page draws tones in ink, by weight and shape rather than hue: `bad` and `ink` strongest (solid ink), `ok` and `accent` an ink outline, `warn` hatched, `info` and `muted` quiet, `soft` dashed. A `#rrggbb` colour is drawn as body ink. |

## Types

### `box`

A framed box with a line of text. Long text wraps onto up to three lines.

```json
{ "id": "server", "type": "box", "at": [9, 0, 3, 2], "label": "Server", "text": "{accepted} served", "pulse": "accept" }
```

A `tone` expression that turns `bad` draws the frame heavier, as an alarm; a fixed tone does not.

### `tank`

A vessel whose fill level is `level`, from 0 to 1, with a moving surface and a hatched liquid.

```json
{ "id": "bucket", "type": "tank", "at": [4, 0, 4, 4], "label": "Bucket", "level": "tokens / capacity", "text": "{tokens:.1} of {capacity}", "tone": "accent" }
```

### `queue` and `stack`

A row (queue, head on the left) or column (stack, bottom up) of chips, one per list item. Chips are matched by value between ticks, so an item that moves slides to its new slot.

```json
{ "id": "recency", "type": "queue", "at": [4, 0, 8, 2], "label": "Recency order", "items": "cache", "slots": "capacity", "ends": ["most recent", "evicted next"] }
```

| Field | Meaning |
| --- | --- |
| `items` | A list. |
| `slots` | Number of slots drawn (default: the list length). Items beyond the visible slots show as "+N more". |
| `ends` | Two captions for the two ends. |
| `showValues` | `false` draws plain chips (useful for job queues). |

### `grid`

Cells for bit arrays, cache slots or a population.

```json
{ "id": "town", "type": "grid", "at": [0, 0, 4, 4], "label": "The town", "cells": "cells", "cols": 10, "showValues": false, "tones": { "S": "soft", "I": "bad", "R": "ok" } }
```

| Field | Meaning |
| --- | --- |
| `cells` | A list of values. Non-zero numbers, `true` and non-empty strings are drawn filled. |
| `cols` | Cells per row (default: as square as the space allows). |
| `tones` | Map from a cell value, as text, to a tone. |
| `mark` | An index or list of indexes to ring with a heavy ink outline. |
| `showValues` | `false` hides the values (default shows them when cells are large enough). |

### `counter`

A large number. In a part one row tall, the label and value share one line.

```json
{ "id": "lead", "type": "counter", "at": [7, 0, 5, 2], "label": "Compound is ahead by", "value": "gap", "format": ",.0", "unit": "" }
```

`format` uses the template formats (`.1`, `%`, `,`, `int`, `ord`). The counter flashes when its value changes, unless it changes almost every tick.

**`expect`: test the binding.** No claim checks what a part shows, so a counter can show the wrong number while every claim passes. Give a `counter`, `gauge` or `tank` an `expect`, an independent way to compute what it should show, and `check` compares the two at every tick at the default params:

```json
{ "id": "waiting", "type": "counter", "at": [8, 0, 3, 2], "label": "Waiting", "value": "queued", "expect": "threads - served - inside" }
```

When they differ, `check` fails with `E_BINDING_EXPECT`, the first moment and both values. Write the expect from different state than the binding (a count from a list, a total from its parts); `"expect": "queued"` for `"value": "queued"` tests nothing.

### `gauge`

A half-circle dial.

```json
{ "id": "reff", "type": "gauge", "at": [4, 0, 4, 2], "label": "Effective R", "value": "Reff", "max": 4, "format": ".2",
  "zones": [{ "from": 0, "to": 1, "tone": "ok" }, { "from": 1, "to": 4, "tone": "bad" }] }
```

`min` defaults to 0. `min` and `max` may be expressions.

### `lamp`

A light that is on while `on` is true, with optional text beside it.

```json
{ "id": "service", "type": "lamp", "at": [9, 0, 3, 2], "label": "Service", "on": "healthy", "text": "{healthy ? 'healthy' : 'failing'}", "tone": "ok" }
```

### `node`

A multi-state element, such as a circuit breaker's closed, open and half-open. `state` returns the id of the active state.

```json
{ "id": "breaker", "type": "node", "at": [4, 0, 4, 2], "label": "Breaker", "state": "mode",
  "states": [{ "id": "closed", "tone": "ok" }, { "id": "open", "tone": "bad" }, { "id": "half-open", "tone": "warn" }] }
```

States are drawn as pills in a row or a column; when neither fits (on a phone), only the active state is shown.

### `link`

An arrow between two parts. Particles run along it whenever one of the `on` signals happens (an `emit` name or an event name), one per firing.

```json
{ "id": "in", "type": "link", "from": "clients", "to": "bucket", "on": ["accept", "reject"], "tone": { "accept": "accent", "reject": "bad" } }
{ "id": "pass", "type": "link", "from": "bucket", "to": "server", "on": "accept", "after": "in" }
```

| Field | Meaning |
| --- | --- |
| `from`, `to` | Part ids. |
| `on` | Signal name(s) that send a particle. |
| `tone` | One tone, or a map from signal name to tone. A particle whose tone is `bad` is drawn as a hollow ring (rejected, dropped); the others are solid ink. |
| `after` | Another link id: particles start when they reach the end of that link, so a flow reads as one journey. |
| `via` | Bend points as `[col, row]` grid positions (fractions allowed). |
| `travel` | Model time a particle takes to cross (default: about 0.7 seconds of playback). |
| `active` | Expression; the line is dashed while it is false. |
| `label` | Small text at the middle of the arrow. |

Leave an empty row or column between linked parts so the arrow is visible. `layout` warns (`W_LINK_CROSSES`) when an arrow is drawn across another part; move a part or add `via` points to route around it.

### `chart`

A line chart of any expressions over the whole run. The past is drawn solid up to the playhead; the future is a faint dotted preview.

```json
{ "id": "chart", "type": "chart", "at": [0, 5, 12, 3], "label": "Tokens in the bucket",
  "series": [{ "expr": "tokens", "label": "tokens", "tone": "accent" }], "y": [0, "capacity"],
  "refs": [{ "y": "capacity", "label": "bucket size" }], "step": false }
```

| Field | Meaning |
| --- | --- |
| `series` | Expressions, or `{ expr, label, tone }`. Two or more series are told apart by dash pattern and named at the end of each line. |
| `y` | `[min, max]`, numbers or param expressions. Default: fitted to the data, rounded up. |
| `refs` | Dashed reference lines `{ y, label, tone }`. |
| `step` | Draw as steps (for counts that jump). |

### `label`

Free text.

```json
{ "id": "note", "type": "label", "at": [4, 4, 4, 1], "text": "refills +{refill} tokens per second", "size": "s", "align": "center" }
```

`size`: `s`, `m`, `l`. `align`: `left`, `center`, `right`.

### `group`

A dashed frame with a label, drawn behind other parts, to show that they belong together.

```json
{ "id": "accounts", "type": "group", "at": [0, 0, 6, 4], "label": "Same deposit, same rate" }
```

## How Text Stays Readable

Each text has a size at full width and a minimum size in screen pixels. On a narrow screen the diagram shrinks, but text stays at or above its minimum, so parts lay themselves out again with relatively larger text: a counter one row tall puts its label and value on one line, a box wraps its text, a chart moves its legend to a second row. If text still does not fit, it is shrunk a little further and the `layout` command reports it. The fix is almost always more grid cells or a shorter label.
