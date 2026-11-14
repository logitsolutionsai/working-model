# Trace Security

Traces, mappings, model specs, document references and issue text are untrusted data. This page lists what the Reality Bridge does with them and what it refuses.

## Nothing Runs

- A trace is parsed with `JSON.parse`, one line at a time, and checked field by field. There is no `eval`, no `Function`, no regular expression from user input, and no plugin or callback.
- Mapping selectors are fixed forms (`subject`, `attrs.<key>`, `literal:<text>`, `event.<key>`, `payload`, `payload[<n>]`), checked against fixed patterns. A `when` filter is an equality test. Nothing in a mapping is an expression.
- Model rule code still runs only in the bounded rule language described in `docs/ARCHITECTURE.md`; replay uses the same compiled closures and the same step limit.

## Nothing Leaves The Machine

- No command makes a network request. A `sourceRefs` URL is text; it must be `https:` and is never fetched.
- A spec can only name files inside its own folder (no URLs, absolute paths, `..` or symbolic links that leave it). A path typed on the command line is the user's explicit local choice.
- Synchronous output goes to the local terminal and to files the user names.

## Less Data In, Less Data Out

- Import keeps an attribute only when the mapping reads it or the user lists it; everything else is dropped and counted. Headers, tokens, IP addresses, SQL text and e-mail addresses are dropped by default because nothing asks for them.
- The source path stays in a `private` block, which is excluded from the trace digest and from every public output.
- Subjects are often identifying (request ids, user ids). They appear in local reports, which stay on the machine; they never appear in a public bundle.
- The demo trace in `examples/reality-bridge/` is synthetic. Never commit a real production trace to a README or a gallery.

## Public Bundles

`bundle --public` is the only way to make something meant for publishing, and it is built by allowlist.

```bash
# a simulated counterexample from fuzz or minimize: no trace data at all
node scripts/working-model.mjs bundle examples/reality-bridge/circuit-breaker.model.json --public --case .working-model/minimized.json
# an observed comparison: refused unless the trace is marked synthetic or you acknowledge the projection
node scripts/working-model.mjs bundle examples/reality-bridge/circuit-breaker.model.json --public \
  --trace examples/reality-bridge/observed.normalized.json --mapping examples/reality-bridge/trace-map.json --synthetic --preview
```

- Without `--public` the command refuses. For an observed trace it also refuses (`E_PRIVACY_ACK`, exit 2) unless you pass `--synthetic` (the trace is generated) or `--acknowledge-privacy` (you reviewed the projection).
- `--preview` prints every key path the bundle would contain and writes nothing. Every run prints the same list.
- The projection holds: the model title and digest, model claim counts, each assertion's id, kind, status and test, the first mismatch's type, kinds and cause, coverage counts, the model's assumptions, and a timeline of **counts per relative time bucket** for the output kinds the mapping names.
- It never holds subjects, attributes, event ids, timestamps, the source path, commands, URLs from the trace, unmapped kind names, or literal correlation values (replaced by `literal:<redacted>`). This holds even when the local normalized trace kept every attribute: `tests/evidence-privacy.test.mjs` imports a trace full of IP addresses, an authorization header, a JWT, an e-mail address, an API secret, personal subject ids, a private file path and an internal URL, and checks that none reaches `evidence.json`, `evidence.html` or `manifest.json`, and that every key is on the allowlist.
- `evidence.html` has no script at all and a CSP of `default-src 'none'`. No PNG is produced.
- `manifest.json` lists the SHA-256 of each file. That proves which bytes were packaged, not that the evidence is true.

## Bounded Work

| Limit | Default | Hard |
| --- | --- | --- |
| Trace file size | 5 MiB | 100 MiB |
| Trace events | 50,000 | 500,000 |
| Attributes per event | 32 | 32 |
| String attribute length | 256 | 256 |
| Replay ticks | 100,000 | 100,000 |
| Replay firings | 200,000 | 200,000 |
| `withinMs` | one tick | 3,600,000 |
| Rule steps | the spec's `limits.steps` (2,000,000) | 50,000,000 |

Nested JSON in attributes is refused, and the spec check refuses JSON nested more than 64 levels. A limit that is hit is an error with exit code 3, never a pass.

## Errors

Every error has a stable code, a message, a location (a trace line, an event id or a mapping path) and a fix. Messages quote at most a short excerpt of the offending value.
