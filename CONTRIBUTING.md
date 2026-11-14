# Contributing

Thank you for helping. The project values explanations that are true, so the bar for an example is that its claims hold for the real mechanism and are backed by a source.

## Setup

```bash
git clone https://github.com/logitsolutionsai/working-model
cd working-model
npm install            # installs playwright-core for the browser tests; it never downloads a browser
npm test
npm run test:e2e       # needs a local Chrome, Edge or Chromium (set WORKING_MODEL_CHROME to choose)
```

Node 22 or newer is needed for the browser tests and for `layout`, `snap` and `gif`.

## Adding an Example

1. Start from a scaffold or the closest example:

   ```bash
   node scripts/working-model.mjs new my-mechanism --dir examples
   ```

2. Write the model following the workflow in `SKILL.md`. Keep it small: one mechanism, one scenario, two to four sliders.
3. Requirements, all checked by `npm test`:
   - `check` passes with no lint errors, no `W_LITERAL_NUMBER` and no `W_UNCITED_CLAIM` warnings;
   - three to eight claims, at least one of which a slider can break (it shows in the "Sliders that break a claim" report);
   - a `sources` list for the key facts, and the model's assumptions in the `summary`.
4. Run the layout check and look at the screenshots:

   ```bash
   node scripts/working-model.mjs layout examples/my-mechanism.model.json --out tests/output
   ```

5. Add the example to `examples/gallery.json` and rebuild the gallery:

   ```bash
   npm run gallery
   ```

6. If the example demonstrates a slider that flips a claim, consider adding it to `FLIPS` in `tests/e2e/pages.e2e.mjs`.

Claims must be true of the mechanism, not just of the model. If a claim only holds because of a modelling shortcut, narrow the claim or fix the model.

## Adding a Part Type

A part touches four places:

1. **Schema** (`src/node/schema.mjs`): add an entry to `PARTS` with its fields and required fields, then regenerate the schema file:

   ```bash
   node scripts/working-model.mjs schema
   ```

2. **Compiler** (`src/engine/model.mjs`): add the type to `PART_TYPES` and a `case` in the parts switch that compiles its bindings with `bind(key)` (expressions) or `bind(key, 'template')` (text).
3. **Renderer** (`src/page/runtime.js`): add a maker to `MAKERS`. A maker builds the SVG elements once and sets:
   - `v.layout()`: geometry, called whenever the scale changes. Use `U(role)` for text-dependent sizes and `place(text, x, y, maxWidth, anchor)` for text;
   - `v.update(fr)`: values at the current moment. `fr.env0` and `fr.env1` are the snapshots before and after, `fr.f` the fraction between them;
   - optionally `v.recompute()` after each simulation, and `v.extraTexts()` for texts the layout report should check.
   Push every text record into `v.texts` so the layout report measures it.
4. **Docs and tests**: describe it in `references/parts.md`, use it in an example, and add it to the part-type list in `tests/spec.test.mjs`.

## Changing the Engine

The engine (`src/engine/`) must stay free of dependencies and of Node or browser APIs, because it is inlined into every page. Import lines must fit on one line, and top-level names must be unique across modules; the bundler checks both. Add tests for any new function, statement or claim behaviour, and keep error codes stable: they are part of the interface.

## Changing The Reality Bridge

The trace, fuzz, bundle and CI code lives in `src/trace/`, `src/fuzz/`, `src/evidence/`, `src/ci/` and the `src/node/*-cli.mjs` files. It must not change the engine files that every page inlines (`ENGINE_FILES` in `src/node/build.mjs`), `runtime.js`, `fluid.js` or `page.css`: `tests/baseline.test.mjs` compares every example's check report, default run, mutation report and gallery page with values frozen before the Reality Bridge existed. Never regenerate `tests/fixtures/baseline/golden.json` to make that test pass. Keep the pure modules free of Node and browser APIs; `build --trace` bundles them into the page.

## Model Pull Request Review

A pull request that adds or changes a model, a mapping or a trace should say:

- **Sources** for the mechanism facts, and which `sourceRefs` are background only.
- **Assumptions**, in the spec's `reality.assumptions`, kept apart from the claims.
- **Claims**: the list, the `check` line and which slider breaks which claim.
- **Mutation**: the `check --mutate` score and every surviving mutant you did not fix, with the reason.
- **Fuzz**: the seed and case count, and the minimized counterexample if one was found.
- **Observed trace**: its origin (synthetic or real, never a real production trace in this repository), its declared completeness and why.
- **Counterexample**: the first mismatch and its event ids, if any.
- **Limitations**: what the evidence does not establish.

Suggested labels: `new-algorithm`, `adversarial-counterexample`, `otel-mapping`, `accessibility`.

## Style

- Plain JavaScript modules, no build step.
- Error messages say what is wrong and how to fix it, in plain words.
- Documentation uses Title Case headings, no contractions and no exclamation marks.
