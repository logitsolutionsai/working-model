# Explanation CI

`working-model ci` keeps an explanation and the system it describes from drifting apart. It runs, per model: the claims, mutation testing, fuzzing, the observed-trace assertions and a browser parity check, each only when the config enables it, and writes JSON, Markdown (for a pull request summary) and JUnit XML.

```bash
node scripts/working-model.mjs ci --config .working-model-ci.json --format markdown
node scripts/working-model.mjs ci examples/reality-bridge/ --format json
node scripts/working-model.mjs ci --config .working-model-ci.json --base base-report.json
```

This is a documentation and engineering check, not a security certification and not formal verification.

## Config (`.working-model-ci.json`)

```json
{
  "schemaVersion": 1,
  "models": ["examples/reality-bridge/*.model.json"],
  "checks": {
    "claims": { "required": true },
    "mutation": { "enabled": true, "minScore": 50 },
    "fuzz": { "enabled": true, "cases": 250, "seed": 7, "strict": false },
    "reality": { "enabled": true, "strictObserved": false },
    "parity": { "enabled": true }
  },
  "output": { "json": "artifacts/working-model-ci.json", "markdown": "artifacts/working-model-ci.md", "junit": "artifacts/working-model-ci.junit.xml" }
}
```

For editor completion, point `$schema` at `schema/working-model-ci.schema.json`. `models` are paths or patterns relative to the config file; `*` matches inside one path segment. Without a config, the folder or file on the command line is used with the defaults below. Unknown keys, unknown checks and out-of-range thresholds are errors (exit 2): a threshold is never loosened silently, and every threshold is printed beside its result and stored in the report's `thresholds`.

| Check | Default | Passes when | Otherwise |
| --- | --- | --- | --- |
| `claims` | required | every claim passes and lint has no errors | fail (or inconclusive when `required` is false) |
| `mutation` | off | the score is at least `minScore` percent | fail; skipped while a claim fails |
| `fuzz` | off | no sampled case fails a claim or hits a limit | inconclusive, or fail with `strict` |
| `reality` | on | the observed status is pass | fail on a failed assertion; inconclusive stays inconclusive unless `strictObserved`; skipped when the spec has no `reality` block |
| `parity` | off | the comparison page, run in a local Chrome, Edge or Chromium, gives the same result as Node | skipped, with the reason, when no browser is found |

The aggregate status is `fail` if any check fails or errors, `pass-with-inconclusive` if some check is inconclusive, otherwise `pass`. The command exits 1 on `fail`, 0 otherwise, 2 for an invalid config, 3 when a file cannot be written.

## What The Summary Holds

The Markdown summary is meant for a pull request: the actual denominators for every check, each observed counterexample with its event ids, the explicit assumptions from each spec's `reality` block, and the commands that reproduce every result. The JSON report adds digests of each spec, its rules, its claims, its mapping and its trace, and the engine version.

With `--base <report.json>` (a report from the base branch), the summary lists what changed, by kind: claim text or expressions changed, model rules changed, trace mapping changed, observed trace changed, counterexample changed, and every check whose status moved. A text change is not a behaviour change; the statuses are what was checked.

## GitHub Actions

`.github/workflows/working-model-ci.example.yml` is a starter to copy. It runs on `pull_request` only (never `pull_request_target`), with `permissions: contents: read`, no secrets, `persist-credentials: false`, and no `npm install`. It runs the tool from the base branch, so the pull request can change models, mappings and traces but not the code that checks them; those files are data, read by the bounded rule language. Pin each action to a reviewed commit SHA before use. Chrome is usually present on GitHub's Ubuntu runners; where it is not, the parity check reports itself as skipped.
