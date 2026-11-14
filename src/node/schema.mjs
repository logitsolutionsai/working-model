// The JSON Schema for *.model.json, built in code so the shared pieces are
// written once. `node scripts/working-model.mjs schema` writes it to
// schema/model.schema.json, and a test checks the file is up to date.

const NAME = '^[A-Za-z_][A-Za-z0-9_]{0,39}$';
const ID = '^[A-Za-z_][A-Za-z0-9_-]{0,59}$';
const TONES = ['ink', 'muted', 'accent', 'ok', 'bad', 'warn', 'soft', 'info'];

const str = (description, extra) => ({ type: 'string', ...(description ? { description } : {}), ...(extra || {}) });
const num = (description, extra) => ({ type: 'number', ...(description ? { description } : {}), ...(extra || {}) });
const numOrExpr = (description) => ({ type: ['number', 'string'], description: description + ' A number, or an expression over params.' });
const expr = (description) => str(description + ' An expression in the rule language.');
const code = (description) => ({
  description: description + ' Rule code: one string, or an array of lines.',
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
});
const tone = {
  description: 'A colour token (' + TONES.join(', ') + '), a #rrggbb colour, or an expression that returns one.',
  type: 'string',
};
const at = {
  type: 'array', description: '[column, row, width, height] on the layout grid, in whole cells.',
  items: { type: 'integer', minimum: 0 }, minItems: 4, maxItems: 4,
};
const signals = { description: 'Event or emit() name(s).', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };

const common = {
  id: str('Unique part id, used by links.', { pattern: ID }),
  type: str('Part type.'),
  label: str('Small caption drawn with the part.'),
  visible: { type: ['string', 'boolean'], description: 'Expression: draw the part only while this is true.' },
  highlight: { type: ['string', 'boolean'], description: 'Expression: ring the part in the accent colour while true.' },
  pulse: signals,
  tone,
  note: str('Free text for authors; not shown.'),
};

function part(type, props, required = []) {
  return {
    type: 'object',
    description: `A ${type} part.`,
    properties: { ...common, type: { const: type }, ...(type === 'link' ? {} : { at }), ...props },
    required: ['id', 'type', ...(type === 'link' ? [] : ['at']), ...required],
    additionalProperties: false,
  };
}

const EXPECT = 'An independent expression the shown value must equal at every tick at the default params; check reports E_BINDING_EXPECT when they differ.';

const PARTS = {
  box: part('box', { text: str('Template text shown inside, such as "{accepted} served".') }),
  tank: part('tank', { level: expr('Fill level from 0 to 1.'), text: str('Template text under the level.'), expect: expr(EXPECT) }, ['level']),
  queue: part('queue', {
    items: expr('A list; each item becomes a chip, head first.'), slots: numOrExpr('Number of slots drawn.'),
    ends: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, description: 'Captions for the two ends, such as ["most recent", "evicted next"].' },
    showValues: { type: 'boolean', description: 'Write each item in its chip (default true).' },
  }, ['items']),
  stack: part('stack', {
    items: expr('A list drawn bottom-up.'), slots: numOrExpr('Number of slots drawn.'),
    ends: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, description: 'Captions for the bottom and top.' },
    showValues: { type: 'boolean', description: 'Write each item in its chip (default true).' },
  }, ['items']),
  grid: part('grid', {
    cells: expr('A list of cell values.'),
    cols: { type: 'integer', minimum: 1, description: 'Cells per row (default: as square as possible).' },
    tones: { type: 'object', description: 'Map from a cell value (as text) to a tone.', additionalProperties: { type: 'string' } },
    showValues: { type: 'boolean', description: 'Write each value in its cell (default true).' },
    mark: expr('An index or list of indexes to ring.'),
  }, ['cells']),
  counter: part('counter', {
    value: expr('The number shown.'), format: str('Number format such as ".1", "%", ",", "int", "ord".'), unit: str('Unit text after the number.'),
    expect: expr(EXPECT),
  }, ['value']),
  gauge: part('gauge', {
    value: expr('The needle value.'), min: numOrExpr('Dial minimum (default 0).'), max: numOrExpr('Dial maximum.'),
    format: str('Number format.'), unit: str('Unit text.'), expect: expr(EXPECT),
    zones: { type: 'array', items: { type: 'object', properties: { from: num(), to: num(), tone: { type: 'string' } }, required: ['from', 'to', 'tone'], additionalProperties: false } },
  }, ['value', 'max']),
  lamp: part('lamp', { on: expr('Lit while true.'), text: str('Template text beside the lamp.') }, ['on']),
  node: part('node', {
    state: expr('Returns the id of the active state.'),
    states: {
      type: 'array', minItems: 1,
      items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, tone: { type: 'string' } }, required: ['id'], additionalProperties: false }] },
    },
  }, ['state', 'states']),
  link: part('link', {
    from: str('Part id where the arrow starts.'), to: str('Part id the arrow points at.'),
    on: signals,
    tone: { description: 'A tone, or a map from signal name to tone.', type: ['string', 'object'], additionalProperties: { type: 'string' } },
    via: { type: 'array', description: 'Bend points as [col, row] grid positions.', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
    travel: num('Seconds of model time a particle takes to cross (default: about 0.7 s of playback).', { exclusiveMinimum: 0 }),
    active: { type: ['string', 'boolean'], description: 'Expression: draw solid while true, dashed while false.' },
    after: str('Id of another link: particles start when they reach the end of that link, so flows chain.'),
  }, ['from', 'to']),
  chart: part('chart', {
    series: {
      type: 'array', minItems: 1,
      items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { expr: { type: 'string' }, label: { type: 'string' }, tone: { type: 'string' } }, required: ['expr'], additionalProperties: false }] },
    },
    y: { type: 'array', description: '[min, max] of the y axis; numbers or param expressions (default: fitted).', items: { type: ['number', 'string'] }, minItems: 2, maxItems: 2 },
    refs: { type: 'array', items: { type: 'object', properties: { y: { type: ['number', 'string'] }, label: { type: 'string' }, tone: { type: 'string' } }, required: ['y'], additionalProperties: false } },
    step: { type: 'boolean', description: 'Draw as steps instead of straight segments.' },
  }, ['series']),
  label: part('label', {
    text: str('Template text.'), align: { enum: ['left', 'center', 'right'] }, size: { enum: ['s', 'm', 'l'] },
  }, ['text']),
  group: part('group', {}),
};

const timeField = (d) => numOrExpr(d);

function claim(kind, props, required) {
  return {
    type: 'object',
    properties: { id: str('Unique claim id, cited by captions.', { pattern: ID }), kind: { const: kind }, text: str('The plain sentence readers see. May use {param} holes.'), note: str('Author note; not shown.'), ...props },
    required: ['id', 'kind', 'text', ...required],
    additionalProperties: false,
  };
}
function innerClaim(kind, props, required) {
  return { type: 'object', properties: { kind: { const: kind }, ...props }, required: ['kind', ...required], additionalProperties: false };
}

const CLAIM_PROPS = {
  at: [{ t: timeField('The moment to check.'), expr: expr('Must be true at time t.') }, ['t', 'expr']],
  always: [{ expr: expr('Must be true at every tick.'), from: timeField('Start of the checked window.'), until: timeField('End of the checked window.') }, ['expr']],
  never: [{ expr: expr('Must be false at every tick.'), from: timeField('Start of the checked window.'), until: timeField('End of the checked window.') }, ['expr']],
  eventually: [{ expr: expr('Must become true at some tick.'), from: timeField('Earliest time that counts.'), by: timeField('Deadline (default: end of run).') }, ['expr']],
  whenever: [{ event: str('Event or emit() name.'), expr: expr('Checked right after each firing (payload holds the emit payload).'), within: timeField('If set: expr must become true within this much time instead.') }, ['event', 'expr']],
};

const CLAIMS = {};
const INNER = {};
for (const [k, [props, req]] of Object.entries(CLAIM_PROPS)) {
  CLAIMS[k] = claim(k, props, req);
  INNER[k] = innerClaim(k, props, req);
}
CLAIMS.sweep = claim('sweep', {
  samples: { type: 'integer', minimum: 2, maximum: 400, description: 'Number of sampled param sets (default 24).' },
  vary: {
    description: 'Params to sample: a list of ids (whole slider range) or a map id -> [min, max].',
    anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object', additionalProperties: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }],
  },
  claim: { description: 'The claim checked on every sample.', allOf: Object.keys(INNER).map((k) => ({ if: { properties: { kind: { const: k } }, required: ['kind'] }, then: { $ref: `#/$defs/inner_${k}` } })), properties: { kind: { enum: Object.keys(INNER) } }, required: ['kind'] },
  holdsWhen: expr('Param condition (checked at t = 0 of each sample): the claim must hold inside it and fail outside it.'),
  seed: { type: ['integer', 'string'], description: 'Sampling seed (default: derived from the model seed and claim id).' },
}, ['claim']);
CLAIMS.compare = claim('compare', {
  a: { type: 'object', description: 'Param overrides for run a.', additionalProperties: { type: ['number', 'string'] } },
  b: { type: 'object', description: 'Param overrides for run b.', additionalProperties: { type: ['number', 'string'] } },
  measure: {
    type: 'object',
    properties: {
      of: str('Expression measured at every tick.'), agg: { enum: ['max', 'min', 'mean', 'final', 'sum', 'at'] },
      t: timeField('Time for agg "at".'), label: str('Name shown in counterexamples, such as "peak retry load".'),
    },
    required: ['of'], additionalProperties: false,
  },
  expect: expr('Compares the two measures, named a and b, such as "a < b".'),
}, ['a', 'b', 'measure', 'expect']);

export function buildSchema() {
  const defs = {};
  for (const [k, v] of Object.entries(PARTS)) defs['part_' + k] = v;
  for (const [k, v] of Object.entries(CLAIMS)) defs['claim_' + k] = v;
  for (const [k, v] of Object.entries(INNER)) defs['inner_' + k] = v;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/logitsolutionsai/working-model/schema/model.schema.json',
    title: 'working-model spec',
    description: 'A small discrete-time model with visual parts, captions and claims that are checked by simulation.',
    type: 'object',
    properties: {
      $schema: { type: 'string' },
      id: str('Short kebab-case id.', { pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }),
      title: str('Page title.', { minLength: 1 }),
      summary: str('One or two sentences under the title. May use {param} holes.'),
      sources: {
        type: 'array', description: 'Where the key facts come from.',
        items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, note: { type: 'string' } }, required: ['title'], additionalProperties: false },
      },
      timeUnit: str('Unit of model time shown in the page, such as "s", "day", "RTT", "year".'),
      dt: num('Length of one tick in model time.', { exclusiveMinimum: 0 }),
      duration: num('Total model time simulated.', { exclusiveMinimum: 0 }),
      seed: { type: 'integer', description: 'Seed for rand() and random events (default 1).' },
      params: {
        type: 'array', description: 'Sliders.',
        items: {
          type: 'object',
          properties: {
            id: str('Name used in expressions.', { pattern: NAME }), label: str('Slider label.'),
            min: num(), max: num(), step: num(undefined, { exclusiveMinimum: 0 }), default: num(), unit: str(), help: str('One-line help under the slider.'),
            choices: { type: 'array', items: { type: 'string' }, minItems: 2, description: 'Names for each step from min to max; the page shows buttons instead of a slider.' },
            format: str('How the value is shown, such as "%" for 0.4 as 40%, ".2", "," or "int".'),
          },
          required: ['id', 'min', 'max', 'default'], additionalProperties: false,
        },
      },
      state: {
        type: 'object', description: 'Starting values: numbers, true/false, lists, or expression strings (use quotes inside for text, such as "\'closed\'").',
        propertyNames: { pattern: NAME },
        additionalProperties: { type: ['number', 'boolean', 'string', 'array'] },
      },
      derived: {
        type: 'object', description: 'Named expressions recomputed from state at every moment.',
        propertyNames: { pattern: NAME }, additionalProperties: { type: 'string' },
      },
      events: {
        type: 'array', description: 'The scenario: when things happen.',
        items: {
          type: 'object',
          properties: {
            name: str('Event name; rules.on.<name> handles it.', { pattern: '^[A-Za-z_][A-Za-z0-9_-]{0,39}$' }),
            at: { description: 'One time, a list of times, or an expression.', type: ['number', 'string', 'array'], items: { type: 'number' } },
            every: numOrExpr('Period of a repeating event.'),
            rate: numOrExpr('Random arrivals per unit of time (Poisson, seeded).'),
            from: numOrExpr('First time for every/rate (default 0).'),
            until: numOrExpr('Last time for every/rate (default: end of run).'),
            count: numOrExpr('How many fire at each occurrence (a burst). Default 1.'),
            label: str('Name shown on the timeline.'),
          },
          required: ['name'], additionalProperties: false,
        },
      },
      rules: {
        type: 'object',
        properties: {
          init: code('Runs once at t = 0 after state is set.'),
          tick: code('Runs every tick, before that tick\'s events.'),
          on: { type: 'object', description: 'Event handlers by event name.', additionalProperties: code('Handler.') },
        },
        additionalProperties: false,
      },
      layout: {
        type: 'object',
        properties: { cols: { type: 'integer', minimum: 2, maximum: 24 }, rows: { type: 'integer', minimum: 2, maximum: 24 } },
        additionalProperties: false,
      },
      parts: {
        type: 'array', description: 'Visual parts bound to the model.',
        items: {
          type: 'object',
          properties: { type: { enum: Object.keys(PARTS) } },
          required: ['type', 'id'],
          allOf: Object.keys(PARTS).map((k) => ({ if: { properties: { type: { const: k } }, required: ['type'] }, then: { $ref: `#/$defs/part_${k}` } })),
        },
      },
      narration: {
        type: 'array', description: 'Captions shown during playback.',
        items: {
          type: 'object',
          properties: {
            from: num('Start time.'), to: num('End time (default: next caption).'),
            text: str('Caption text with live {expression} holes.'),
            cites: { type: 'array', items: { type: 'string' }, description: 'Claim ids this caption relies on.' },
          },
          required: ['from', 'text'], additionalProperties: false,
        },
      },
      claims: {
        type: 'array', description: 'Statements checked by simulation.', minItems: 1,
        items: {
          type: 'object',
          properties: { kind: { enum: Object.keys(CLAIMS) } },
          required: ['kind', 'id'],
          allOf: Object.keys(CLAIMS).map((k) => ({ if: { properties: { kind: { const: k } }, required: ['kind'] }, then: { $ref: `#/$defs/claim_${k}` } })),
        },
      },
      playback: {
        type: 'object',
        properties: { speed: num('Model time per second of playback (default: duration / 15).', { exclusiveMinimum: 0 }), autoplay: { type: 'boolean' } },
        additionalProperties: false,
      },
      lint: {
        type: 'object',
        properties: { allowNumbers: { type: 'array', items: { type: 'number' }, description: 'Numbers allowed as literals in text.' } },
        additionalProperties: false,
      },
      mutate: {
        type: 'object',
        description: 'Settings for check --mutate.',
        properties: {
          ignore: {
            type: 'array',
            description: 'Surviving mutants that are truly harmless, each with the reason. They are left out of the mutation score.',
            items: {
              type: 'object',
              properties: {
                mutant: { type: 'string', minLength: 1, description: 'The mutant as check --mutate prints it: location and change, such as "rules.tick:1:8 t > 12 → t >= 12".' },
                reason: { type: 'string', minLength: 1, description: 'Why no claim can or should notice this change.' },
              },
              required: ['mutant', 'reason'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      limits: {
        type: 'object',
        properties: { steps: { type: 'integer', minimum: 1000, maximum: 50000000, description: 'Rule steps allowed per simulation (default 2000000).' } },
        additionalProperties: false,
      },
    },
    required: ['title', 'dt', 'duration', 'state', 'parts', 'claims'],
    additionalProperties: false,
    $defs: defs,
  };
}
