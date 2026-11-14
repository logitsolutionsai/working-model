// `working-model new <name>`: a small spec that passes check and layout,
// ready to be replaced piece by piece.

export function scaffold(name) {
  const id = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-model';
  const title = id.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  return {
    $schema: 'https://raw.githubusercontent.com/logitsolutionsai/working-model/main/schema/model.schema.json',
    id,
    title,
    summary: 'Water flows in at {inflow} litres per second and drains in proportion to how full the tank is, so the level settles where outflow equals inflow.',
    sources: [{ title: 'Replace with the source for the key facts', note: 'for example a textbook chapter or an RFC' }],
    timeUnit: 's',
    dt: 0.1,
    duration: 30,
    seed: 1,
    params: [
      { id: 'inflow', label: 'Inflow', min: 0.5, max: 5, step: 0.5, default: 2, unit: 'L/s' },
      { id: 'drain', label: 'Drain rate', min: 0.05, max: 1, step: 0.05, default: 0.4, unit: 'per s' },
    ],
    state: { level: 0 },
    derived: { outflow: 'drain * level', target: 'inflow / drain' },
    events: [],
    rules: { tick: 'level += (inflow - drain * level) * dt' },
    layout: { cols: 12, rows: 8 },
    parts: [
      { id: 'tap', type: 'box', at: [0, 0, 3, 2], label: 'Inflow', text: '{inflow} L/s' },
      { id: 'tank', type: 'tank', at: [4, 0, 4, 5], label: 'Tank', level: 'clamp(level / 12, 0, 1)', text: '{level:.1} L' },
      { id: 'out', type: 'counter', at: [9, 0, 3, 2], label: 'Outflow', value: 'outflow', format: '.1', unit: 'L/s' },
      { id: 'in-link', type: 'link', from: 'tap', to: 'tank' },
      { id: 'out-link', type: 'link', from: 'tank', to: 'out' },
      { id: 'chart', type: 'chart', at: [0, 5, 12, 3], label: 'Level over time', series: [{ expr: 'level', label: 'level', tone: 'accent' }], refs: [{ y: 'target', label: 'balance point' }] },
    ],
    narration: [
      { from: 0, to: 10, text: 'The tank starts empty and fills at {inflow} L/s; the drain grows as the level rises.', cites: ['never-negative', 'no-overshoot'] },
      { from: 10, to: 30, text: 'Outflow is now {outflow:.1} L/s. The level settles near {target:.1} L, where outflow matches inflow.', cites: ['settles'] },
    ],
    claims: [
      { id: 'never-negative', kind: 'always', expr: 'level >= 0', text: 'The level never goes below empty.' },
      { id: 'no-overshoot', kind: 'always', expr: 'outflow <= inflow + 0.000001', text: 'The level rises without overshooting: outflow never exceeds inflow.' },
      { id: 'settles', kind: 'eventually', by: 20, expr: 'abs(outflow - inflow) < 0.05 * inflow', text: 'Within twenty seconds, outflow comes within five percent of inflow.' },
    ],
  };
}
