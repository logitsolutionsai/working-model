// Turns a parsed *.model.json spec into a runnable model: checks names and
// references, compiles every piece of rule code, binding, caption and claim,
// and collects every error it finds (not just the first).

import { ModelError } from './errors.mjs';
import { compileProgramSource, compileExpressionSource, nameProblem, kindOf } from './compile.mjs';
import { compileTemplate } from './format.mjs';

export const PART_TYPES = ['box', 'tank', 'queue', 'stack', 'grid', 'counter', 'gauge', 'lamp', 'node', 'link', 'chart', 'label', 'group'];
export const CLAIM_KINDS = ['at', 'always', 'never', 'eventually', 'whenever', 'sweep', 'compare'];
export const TONES = ['ink', 'muted', 'accent', 'ok', 'bad', 'warn', 'soft', 'info'];
const AGGS = ['max', 'min', 'mean', 'final', 'sum', 'at'];

export function codeText(code) {
  return Array.isArray(code) ? code.join('\n') : String(code);
}

export function compileModel(spec) {
  const errors = [];
  const warnings = [];
  const attempt = (fn) => {
    try { return fn(); } catch (e) {
      if (e instanceof ModelError) { errors.push(e); return null; }
      throw e;
    }
  };
  const fail = (code, msg, path, hint) => { const e = new ModelError(code, msg, { path }); if (hint) e.hint = hint; errors.push(e); };

  const dt = spec.dt;
  const duration = spec.duration;
  if (!(dt > 0)) fail('E_TIME', '"dt" must be a positive number', 'dt');
  if (!(duration > 0)) fail('E_TIME', '"duration" must be a positive number', 'duration');
  const K = dt > 0 && duration > 0 ? Math.round(duration / dt) : 0;
  if (K > 100000) fail('E_TIME', `duration / dt makes ${K} ticks; keep it under 100000`, 'duration');
  if (dt > 0 && duration > 0 && Math.abs(K * dt - duration) > dt * 1e-6) {
    warnings.push(warn('W_DURATION_ROUNDED', `duration ${duration} is not a whole number of ticks of ${dt}; the run ends at ${K * dt}`, 'duration'));
  }

  // ---- names ---------------------------------------------------------------
  const owners = new Map(); // name -> what
  const claimName = (name, what, path) => {
    const p = nameProblem(name);
    if (p) { fail('E_NAME', `${what} name "${name}": ${p}`, path); return false; }
    if (owners.has(name)) { fail('E_DUPLICATE_NAME', `"${name}" is used as both ${owners.get(name)} and ${what}`, path); return false; }
    owners.set(name, what);
    return true;
  };

  const params = [];
  const paramIds = new Set();
  (spec.params || []).forEach((p, i) => {
    const path = `params[${i}]`;
    if (!claimName(p.id, 'a param', path + '.id')) return;
    const step = p.step != null ? p.step : niceStep(p.min, p.max);
    if (!(p.max > p.min)) fail('E_PARAM_RANGE', `param "${p.id}": max must be greater than min`, path);
    if (!(step > 0)) fail('E_PARAM_RANGE', `param "${p.id}": step must be positive`, path + '.step');
    if (p.default < p.min || p.default > p.max) fail('E_PARAM_RANGE', `param "${p.id}": default ${p.default} is outside ${p.min}..${p.max}`, path + '.default');
    if (p.choices && Math.round((p.max - p.min) / step) + 1 !== p.choices.length) {
      fail('E_PARAM_RANGE', `param "${p.id}": ${p.choices.length} choices but min, max and step give ${Math.round((p.max - p.min) / step) + 1} values`, path + '.choices');
    }
    paramIds.add(p.id);
    params.push({ id: p.id, label: p.label || p.id, min: p.min, max: p.max, step, default: p.default, unit: p.unit || '', help: p.help || '', format: p.format || null, choices: p.choices || null });
  });

  const stateNames = Object.keys(spec.state || {});
  stateNames.forEach((name) => claimName(name, 'a state value', `state.${name}`));
  const derivedNames = Object.keys(spec.derived || {});
  derivedNames.forEach((name) => claimName(name, 'a derived value', `derived.${name}`));

  const stateSet = new Set(stateNames);
  const emits = new Set();

  // ---- state initial values -------------------------------------------------
  const stateInit = [];
  const earlier = new Set();
  for (const name of stateNames) {
    const v = spec.state[name];
    const path = `state.${name}`;
    if (typeof v === 'string') {
      const fn = attempt(() => compileExpressionSource(v, path, { params: paramIds, state: new Set(earlier), implicit: new Set(['pi']), what: 'a starting value' }));
      stateInit.push({ name, fn });
    } else {
      const k = kindOf(v);
      if (k === 'invalid' || (k === 'list' && !validLiteral(v))) fail('E_STATE_VALUE', `state "${name}" must be a number, true/false, a list, or a string expression`, path);
      stateInit.push({ name, value: v });
    }
    earlier.add(name);
  }

  // ---- derived values (each may use earlier ones) -----------------------------
  const derivedGetters = new Map();
  const derived = [];
  for (const name of derivedNames) {
    const path = `derived.${name}`;
    const fn = attempt(() => compileExpressionSource(String(spec.derived[name]), path, {
      params: paramIds, state: stateSet, derived: new Map(derivedGetters), what: 'a derived value',
    }));
    if (fn) {
      derivedGetters.set(name, fn);
      derived.push({ name, fn });
    }
  }

  const exprBase = (what) => ({ params: paramIds, state: stateSet, derived: derivedGetters, what });
  const paramOnly = (what) => ({ params: paramIds, implicit: new Set(['pi']), what });

  // ---- events ---------------------------------------------------------------
  const events = [];
  const eventNames = new Set();
  (spec.events || []).forEach((ev, i) => {
    const path = `events[${i}]`;
    if (typeof ev.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,39}$/.test(ev.name) || ev.name.startsWith('__')) {
      fail('E_NAME', `event name "${ev.name}" must use letters, digits, "-" and "_", and not start with "__"`, path + '.name');
      return;
    }
    eventNames.add(ev.name);
    const num = (key, dflt) => {
      const v = ev[key];
      if (v == null) return dflt == null ? null : () => dflt;
      if (typeof v === 'number') return () => v;
      const f = attempt(() => compileExpressionSource(String(v), `${path}.${key}`, paramOnly('an event time')));
      return f ? (env) => f(env) : null;
    };
    const modes = ['at', 'every', 'rate'].filter((k) => ev[k] != null);
    if (modes.length !== 1) {
      fail('E_EVENT', `event "${ev.name}" needs exactly one of "at", "every" or "rate"`, path);
      return;
    }
    const mode = modes[0];
    let atList = null;
    if (mode === 'at' && Array.isArray(ev.at)) atList = ev.at.slice();
    events.push({
      name: ev.name, index: i, mode, path, label: ev.label || null,
      at: mode === 'at' && !atList ? num('at') : null,
      atList,
      every: mode === 'every' ? num('every') : null,
      rate: mode === 'rate' ? num('rate') : null,
      from: num('from', null),
      until: num('until', null),
      count: num('count', 1),
    });
  });

  // ---- rules ----------------------------------------------------------------
  const rules = { init: null, tick: null, on: new Map() };
  const ruleBase = (implicit) => ({ params: paramIds, state: stateSet, derived: derivedGetters, implicit: new Set(implicit), emits });
  const R = spec.rules || {};
  if (R.init != null) rules.init = attempt(() => compileProgramSource(codeText(R.init), 'rules.init', ruleBase(['t', 'dt', 'tick', 'pi'])));
  if (R.tick != null) rules.tick = attempt(() => compileProgramSource(codeText(R.tick), 'rules.tick', ruleBase(['t', 'dt', 'tick', 'pi'])));
  for (const [name, code] of Object.entries(R.on || {})) {
    const path = `rules.on.${name}`;
    if (!eventNames.has(name)) {
      fail('E_UNKNOWN_EVENT', `rules.on has a handler for "${name}" but no event with that name is scheduled`, path,
        eventNames.size ? 'events: ' + [...eventNames].join(', ') : 'add it to "events"');
      continue;
    }
    const fn = attempt(() => compileProgramSource(codeText(code), path, ruleBase(['t', 'dt', 'tick', 'pi', 'seq', 'batch'])));
    if (fn) rules.on.set(name, fn);
  }

  for (const name of emits) {
    if (eventNames.has(name)) fail('E_EMIT_NAME', `emit('${name}') reuses the name of a scheduled event, so "whenever ${name}" would be ambiguous; pick another emit name`, 'rules');
  }
  const signalNames = new Set([...eventNames, ...emits]);

  // ---- layout and parts ------------------------------------------------------
  const layout = { cols: (spec.layout && spec.layout.cols) || 12, rows: (spec.layout && spec.layout.rows) || 8 };
  const partIds = new Set();
  const parts = [];
  (spec.parts || []).forEach((p, i) => {
    const path = `parts.${p.id || i}`;
    if (typeof p.id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,39}$/.test(p.id) || p.id.startsWith('__')) { fail('E_NAME', `part id "${p.id}" must use letters, digits, "-" and "_", and not start with "__"`, `parts[${i}].id`); return; }
    if (partIds.has(p.id)) { fail('E_DUPLICATE_NAME', `two parts are called "${p.id}"`, path); return; }
    partIds.add(p.id);
    if (!PART_TYPES.includes(p.type)) { fail('E_PART_TYPE', `part "${p.id}" has unknown type "${p.type}"`, path + '.type', 'types: ' + PART_TYPES.join(', ')); return; }
    if (p.type !== 'link') {
      const at = p.at;
      if (!Array.isArray(at) || at.length !== 4 || !at.every((x) => Number.isInteger(x))) {
        fail('E_LAYOUT', `part "${p.id}" needs "at": [col, row, width, height] in whole grid cells`, path + '.at');
        return;
      }
      const [c, r, w, h] = at;
      if (c < 0 || r < 0 || w < 1 || h < 1 || c + w > layout.cols || r + h > layout.rows) {
        fail('E_LAYOUT_BOUNDS', `part "${p.id}" at [${at.join(', ')}] does not fit the ${layout.cols}×${layout.rows} grid`, path + '.at');
      }
    }
    const bind = (key, kind) => {
      const v = p[key];
      if (v == null) return null;
      const bp = `${path}.${key}`;
      if (kind === 'template') return attempt(() => compileTemplate(String(v), bp, exprBase('a caption or label')));
      if (typeof v === 'number' || typeof v === 'boolean') { const c = v; return () => c; }
      return attempt(() => compileExpressionSource(String(v), bp, exprBase('a part binding')));
    };
    const tone = (key) => {
      const v = p[key];
      if (v == null) return null;
      if (typeof v === 'string' && (TONES.includes(v) || /^#[0-9a-fA-F]{6}$/.test(v))) { const c = v; return () => c; }
      if (typeof v === 'object' && !Array.isArray(v)) return null; // handled per type (link tone maps)
      return bind(key, 'expr');
    };
    const cp = {
      id: p.id, type: p.type, at: p.at, label: p.label != null ? String(p.label) : null, spec: p,
      expect: (p.type === 'counter' || p.type === 'gauge' || p.type === 'tank') ? bind('expect') : null,
      visible: bind('visible'), highlight: bind('highlight'), tone: tone('tone'),
      pulse: p.pulse == null ? [] : (Array.isArray(p.pulse) ? p.pulse : [p.pulse]),
    };
    for (const name of cp.pulse) {
      if (!signalNames.has(name)) fail('E_UNKNOWN_SIGNAL', `part "${p.id}" pulses on "${name}", which is never emitted and is not an event`, path + '.pulse', hintNames(signalNames));
    }
    switch (p.type) {
      case 'box': cp.text = bind('text', 'template'); break;
      case 'tank': cp.level = need(bind('level'), 'level'); cp.text = bind('text', 'template'); break;
      case 'queue': case 'stack':
        cp.items = need(bind('items'), 'items'); cp.slots = bind('slots'); cp.showValues = p.showValues !== false; break;
      case 'grid':
        cp.cells = need(bind('cells'), 'cells'); cp.mark = bind('mark');
        cp.cols = p.cols || null; cp.tones = p.tones || null; cp.showValues = p.showValues !== false; break;
      case 'counter': cp.value = need(bind('value'), 'value'); cp.format = p.format || null; cp.unit = p.unit || ''; break;
      case 'gauge':
        cp.value = need(bind('value'), 'value'); cp.min = bind('min') || (() => 0); cp.max = need(bind('max'), 'max');
        cp.format = p.format || null; cp.unit = p.unit || ''; cp.zones = p.zones || []; break;
      case 'lamp': cp.on = need(bind('on'), 'on'); cp.text = bind('text', 'template'); break;
      case 'node':
        cp.state = need(bind('state'), 'state');
        cp.states = Array.isArray(p.states) ? p.states.map((s) => (typeof s === 'string' ? { id: s, label: s } : s)) : [];
        if (!cp.states.length) fail('E_PART', `node "${p.id}" needs a "states" list`, path + '.states');
        break;
      case 'link': {
        if (!p.from || !p.to) fail('E_PART', `link "${p.id}" needs "from" and "to"`, path);
        cp.from = p.from; cp.to = p.to; cp.via = p.via || [];
        cp.on = p.on == null ? [] : (Array.isArray(p.on) ? p.on : [p.on]);
        cp.toneMap = p.tone && typeof p.tone === 'object' && !Array.isArray(p.tone) ? p.tone : null;
        cp.travel = p.travel || null;
        cp.active = bind('active');
        if (p.after != null && !(spec.parts || []).some((q) => q.id === p.after && q.type === 'link')) fail('E_UNKNOWN_PART', `link "${p.id}" follows "${p.after}", which is not a link`, path + '.after');
        for (const name of cp.on) {
          if (!signalNames.has(name)) fail('E_UNKNOWN_SIGNAL', `link "${p.id}" listens for "${name}", which is never emitted and is not an event`, path + '.on', hintNames(signalNames));
        }
        break;
      }
      case 'chart': {
        const series = Array.isArray(p.series) ? p.series : [];
        if (!series.length) fail('E_PART', `chart "${p.id}" needs at least one series`, path + '.series');
        cp.series = series.map((s, j) => {
          const sp = `${path}.series[${j}]`;
          const src = typeof s === 'string' ? s : s.expr;
          const fn = attempt(() => compileExpressionSource(String(src), sp, exprBase('a chart series')));
          return { fn, label: (s && s.label) || String(src), tone: (s && s.tone) || null };
        });
        cp.y = Array.isArray(p.y) ? p.y.map((v, j) => (typeof v === 'number' ? () => v : attempt(() => compileExpressionSource(String(v), `${path}.y[${j}]`, paramOnly('a chart axis'))))) : null;
        cp.refs = (p.refs || []).map((r, j) => ({
          fn: typeof r.y === 'number' ? (() => r.y) : attempt(() => compileExpressionSource(String(r.y), `${path}.refs[${j}].y`, exprBase('a chart reference line'))),
          label: r.label || '', tone: r.tone || 'muted',
        }));
        cp.step = !!p.step;
        break;
      }
      case 'label': cp.text = need(bind('text', 'template'), 'text'); cp.align = p.align || 'center'; cp.size = p.size || 'm'; break;
      case 'group': break;
      default: break;
    }
    parts.push(cp);
    function need(v, key) {
      if (v == null && p[key] == null) fail('E_PART', `${p.type} "${p.id}" needs "${key}"`, `${path}.${key}`);
      return v;
    }
  });
  for (const cp of parts) {
    if (cp.type === 'link') {
      for (const end of ['from', 'to']) {
        const target = cp[end];
        if (target && !partIds.has(target)) fail('E_UNKNOWN_PART', `link "${cp.id}" ${end} "${target}" is not a part`, `parts.${cp.id}.${end}`);
        else if (target && parts.find((q) => q.id === target && q.type === 'link')) fail('E_UNKNOWN_PART', `link "${cp.id}" cannot attach to another link`, `parts.${cp.id}.${end}`);
      }
    }
  }
  // static overlap check: solid parts may not share grid cells (groups may contain them)
  const solid = parts.filter((p) => p.type !== 'link' && p.type !== 'group' && Array.isArray(p.at));
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      if (rectsOverlap(solid[i].at, solid[j].at)) {
        fail('E_LAYOUT_OVERLAP', `parts "${solid[i].id}" and "${solid[j].id}" overlap on the grid`, `parts.${solid[j].id}.at`);
      }
    }
  }

  // ---- narration ---------------------------------------------------------------
  const narration = [];
  (spec.narration || []).forEach((n, i) => {
    const path = `narration[${i}]`;
    const text = attempt(() => compileTemplate(String(n.text), path + '.text', exprBase('a caption')));
    const from = typeof n.from === 'number' ? n.from : 0;
    const to = typeof n.to === 'number' ? n.to : null;
    narration.push({ index: i, from, to, text, raw: String(n.text), cites: Array.isArray(n.cites) ? n.cites : [], path });
  });
  narration.sort((a, b) => a.from - b.from);
  narration.forEach((n, i) => { if (n.to == null) n.to = i + 1 < narration.length ? narration[i + 1].from : duration; });

  // ---- claims ----------------------------------------------------------------
  const claimIds = new Set();
  const claims = [];
  (spec.claims || []).forEach((c, i) => {
    const path = `claims.${c.id || i}`;
    if (typeof c.id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,59}$/.test(c.id) || c.id.startsWith('__')) { fail('E_NAME', `claim id "${c.id}" must use letters, digits, "-" and "_", and not start with "__"`, `claims[${i}].id`); return; }
    if (claimIds.has(c.id)) { fail('E_DUPLICATE_NAME', `two claims are called "${c.id}"`, path); return; }
    claimIds.add(c.id);
    const text = attempt(() => compileTemplate(String(c.text || ''), path + '.text', paramOnly('claim text')));
    const cc = attempt(() => compileClaim(c, path, false));
    if (cc) { cc.id = c.id; cc.text = text; cc.raw = String(c.text || ''); cc.index = i; claims.push(cc); }
  });
  for (const n of narration) {
    n.cites.forEach((id, j) => {
      if (!claimIds.has(id)) fail('E_UNKNOWN_CLAIM', `caption cites claim "${id}", which does not exist`, `${n.path}.cites[${j}]`, hintNames(claimIds));
    });
  }

  function timeValue(v, path) {
    if (v == null) return null;
    if (typeof v === 'number') return () => v;
    const f = compileExpressionSource(String(v), path, paramOnly('a claim time'));
    return f;
  }

  function compileClaim(c, path, inner) {
    if (!CLAIM_KINDS.includes(c.kind)) throw new ModelError('E_CLAIM_KIND', `claim kind "${c.kind}" is not one of ${CLAIM_KINDS.join(', ')}`, { path: path + '.kind' });
    const out = { kind: c.kind, path };
    const expr = (key, base) => {
      if (c[key] == null) throw new ModelError('E_CLAIM', `${c.kind} claim needs "${key}"`, { path: `${path}.${key}` });
      return compileExpressionSource(String(c[key]), `${path}.${key}`, base);
    };
    switch (c.kind) {
      case 'at':
        if (c.t == null) throw new ModelError('E_CLAIM', 'an "at" claim needs "t"', { path: path + '.t' });
        out.t = timeValue(c.t, path + '.t');
        out.expr = expr('expr', exprBase('a claim'));
        break;
      case 'always':
      case 'never':
        out.expr = expr('expr', exprBase('a claim'));
        out.from = timeValue(c.from, path + '.from');
        out.until = timeValue(c.until, path + '.until');
        break;
      case 'eventually':
        out.expr = expr('expr', exprBase('a claim'));
        out.from = timeValue(c.from, path + '.from');
        out.by = timeValue(c.by, path + '.by');
        break;
      case 'whenever': {
        if (typeof c.event !== 'string') throw new ModelError('E_CLAIM', 'a "whenever" claim needs "event"', { path: path + '.event' });
        if (!signalNames.has(c.event)) {
          const e = new ModelError('E_UNKNOWN_SIGNAL', `whenever claim watches "${c.event}", which is never emitted and is not an event`, { path: path + '.event' });
          e.hint = hintNames(signalNames);
          throw e;
        }
        out.event = c.event;
        out.scheduled = eventNames.has(c.event);
        const imp = ['t', 'dt', 'tick', 'pi', 'payload'];
        if (out.scheduled) imp.push('seq', 'batch');
        out.expr = expr('expr', { ...exprBase('a claim'), implicit: new Set(imp) });
        out.within = timeValue(c.within, path + '.within');
        if (out.within) out.expr = expr('expr', exprBase('a claim')); // checked on later snapshots: no payload
        break;
      }
      case 'sweep': {
        if (inner) throw new ModelError('E_CLAIM', 'a sweep cannot contain another sweep or a compare', { path });
        if (!c.claim || typeof c.claim !== 'object') throw new ModelError('E_CLAIM', 'a sweep needs an inner "claim"', { path: path + '.claim' });
        if (c.claim.kind === 'sweep' || c.claim.kind === 'compare') throw new ModelError('E_CLAIM', 'a sweep cannot contain another sweep or a compare', { path: path + '.claim.kind' });
        out.inner = compileClaim(c.claim, path + '.claim', true);
        out.samples = Math.max(2, Math.min(400, c.samples || 24));
        const vary = c.vary == null ? params.map((p) => p.id) : c.vary;
        out.vary = [];
        const entries = Array.isArray(vary) ? vary.map((id) => [id, null]) : Object.entries(vary);
        for (const [id, range] of entries) {
          const p = params.find((q) => q.id === id);
          if (!p) throw new ModelError('E_UNKNOWN_PARAM', `sweep varies "${id}", which is not a param`, { path: path + '.vary' });
          const lo = range ? range[0] : p.min;
          const hi = range ? range[1] : p.max;
          if (!(hi >= lo)) throw new ModelError('E_PARAM_RANGE', `sweep range for "${id}" is empty`, { path: path + '.vary' });
          out.vary.push({ id, lo, hi, step: p.step, min: p.min });
        }
        if (!out.vary.length) throw new ModelError('E_CLAIM', 'a sweep needs at least one param to vary', { path: path + '.vary' });
        out.holdsWhen = c.holdsWhen != null ? expr('holdsWhen', exprBase('holdsWhen')) : null;
        out.seed = c.seed != null ? c.seed : null;
        break;
      }
      case 'compare': {
        if (inner) throw new ModelError('E_CLAIM', 'a sweep cannot contain a compare', { path });
        const runs = {};
        for (const side of ['a', 'b']) {
          const o = c[side];
          if (!o || typeof o !== 'object' || Array.isArray(o)) throw new ModelError('E_CLAIM', `a compare claim needs "${side}": an object of param overrides`, { path: `${path}.${side}` });
          runs[side] = Object.entries(o).map(([id, v]) => {
            if (!paramIds.has(id)) throw new ModelError('E_UNKNOWN_PARAM', `compare "${side}" sets "${id}", which is not a param`, { path: `${path}.${side}.${id}` });
            const fn = typeof v === 'number' ? (() => v) : compileExpressionSource(String(v), `${path}.${side}.${id}`, paramOnly('a compare override'));
            return { id, fn, raw: v };
          });
        }
        out.runs = runs;
        const m = c.measure;
        if (!m || typeof m !== 'object' || m.of == null) throw new ModelError('E_CLAIM', 'a compare claim needs "measure": { "of": expr, "agg": "max" }', { path: path + '.measure' });
        const agg = m.agg || 'max';
        if (!AGGS.includes(agg)) throw new ModelError('E_CLAIM', `measure.agg must be one of ${AGGS.join(', ')}`, { path: path + '.measure.agg' });
        out.measure = {
          of: compileExpressionSource(String(m.of), path + '.measure.of', exprBase('a measure')),
          agg, raw: String(m.of),
          t: agg === 'at' ? timeValue(m.t, path + '.measure.t') : null,
          label: m.label || null,
        };
        if (agg === 'at' && !out.measure.t) throw new ModelError('E_CLAIM', 'measure.agg "at" needs "t"', { path: path + '.measure.t' });
        const get = (k) => (env) => env.cmp[k];
        out.expect = expr('expect', { params: paramIds, implicit: new Set(['pi']), extra: new Map([['a', get('a')], ['b', get('b')]]), what: 'a compare expectation' });
        break;
      }
      default: break;
    }
    return out;
  }

  const summary = spec.summary != null ? attempt(() => compileTemplate(String(spec.summary), 'summary', paramOnly('the summary'))) : null;

  const model = {
    spec, title: spec.title || 'Untitled model', summary, timeUnit: spec.timeUnit || 's',
    dt, duration, K, seed: spec.seed != null ? spec.seed : 1,
    maxSteps: (spec.limits && spec.limits.steps) || null,
    params, paramIds, stateNames, stateInit, derived, derivedGetters,
    events, eventNames, emits, signalNames, rules, layout, parts, narration, claims,
    playback: spec.playback || {},
  };
  return { model, errors, warnings };
}

function warn(code, message, path) { return { code, severity: 'warning', message, path }; }

function hintNames(set) {
  const xs = [...set];
  return xs.length ? 'known: ' + xs.join(', ') : 'nothing is emitted yet; call emit(\'name\') in a rule';
}

function validLiteral(v) {
  const k = kindOf(v);
  if (k === 'invalid') return false;
  if (k === 'list') return v.length <= 10000 && v.every(validLiteral);
  return true;
}

function rectsOverlap(a, b) {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

export function niceStep(min, max) {
  const span = max - min;
  if (!(span > 0)) return 1;
  const raw = span / 100;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return mag;
}

// Snap a value to a param's step grid and remove float noise (0.30000000000000004 -> 0.3).
export function snapToStep(v, p) {
  const steps = Math.round((v - p.min) / p.step);
  const x = p.min + steps * p.step;
  const decimals = Math.min(10, Math.max(decimalsOf(p.step), decimalsOf(p.min)));
  const y = Number(x.toFixed(decimals));
  return Math.min(p.max, Math.max(p.min, y));
}

function decimalsOf(x) {
  const s = String(x);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
