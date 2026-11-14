// Lint: an explainer must not lie.
//  W_LITERAL_NUMBER       a number typed into a caption or claim text instead of bound to the model
//  W_UNCITED_CLAIM        no caption points the reader at this claim
//  E_CITES_FAILING_CLAIM  a caption cites a claim that fails at the default params
//  W_CONSTANT_CLAIM       the claim never looks at state or time, so it says nothing about behaviour
//  W_VACUOUS_CLAIM        the claim was never exercised (its event never fired)
//  W_NOT_BREAKABLE        no slider position makes any claim fail, so readers cannot see where it stops holding
//  W_PARAM_EXTREME_ERROR  at a slider's end the model itself fails (division by zero and the like)

import { literalText } from './format.mjs';
import { checkClaims } from './claims.mjs';
import { autoNumber, formatValue } from './format.mjs';
import { snapshotEnv } from './simulate.mjs';
import { deepEqual } from './compile.mjs';

const NUM_RE = /(?<![A-Za-z0-9_.])(\d+(?:\.\d+)?)(st|nd|rd|th|x|%)?(?![A-Za-z0-9_])/g;

export function findLiteralNumbers(text) {
  const lit = literalText(text);
  const out = [];
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(lit))) out.push({ raw: m[0], value: Number(m[1]), suffix: m[2] || '' });
  return out;
}

function suggestions(model, value, suffix) {
  const out = [];
  for (const p of model.params) {
    const d = p.default;
    if (suffix === '%' && Math.abs(d * 100 - value) < 1e-9) out.push(`{${p.id}:%}`);
    else if (Math.abs(d - value) < 1e-9) out.push(suffix && /st|nd|rd|th/.test(suffix) ? `{${p.id}:ord}` : `{${p.id}}`);
    else if (Math.abs(d + 1 - value) < 1e-9) out.push(suffix && /st|nd|rd|th/.test(suffix) ? `{${p.id} + 1:ord}` : `{${p.id} + 1}`);
  }
  for (const si of model.stateInit) {
    if (typeof si.value === 'number' && Math.abs(si.value - value) < 1e-9) out.push(`{${si.name}}`);
  }
  return out;
}

export function lintModel(model, defaults, opts = {}) {
  const issues = [];
  const allow = new Set([0, 1, ...(((model.spec.lint || {}).allowNumbers) || [])]);
  const add = (code, severity, message, path, fix) => issues.push(fix ? { code, severity, message, path, fix } : { code, severity, message, path });

  const scan = (text, path, what) => {
    for (const n of findLiteralNumbers(text)) {
      if (allow.has(n.value)) continue;
      const sug = suggestions(model, n.value, n.suffix);
      const fix = sug.length
        ? `write ${sug.slice(0, 2).join(' or ')} instead of "${n.raw}" so the text follows the sliders`
        : `bind "${n.raw}" to the model with {expression}, or add ${n.value} to lint.allowNumbers if it is a true constant`;
      add('W_LITERAL_NUMBER', 'warning', `${what} has the literal number "${n.raw}"`, path, fix);
    }
  };
  for (const n of model.narration) scan(n.raw, n.path + '.text', 'caption');
  for (const c of model.claims) scan(c.raw, c.path + '.text', `claim "${c.id}"`);
  // {300} is a literal number in disguise: a hole that uses no param, state
  // or time never follows the sliders
  const scanHoles = (fn, path, what) => {
    for (const h of (fn && fn.parts) || []) {
      if (h.expr == null || !h.refs || h.refs.size > 0 || !/^[\s\d.+\-*/%()]+$/.test(h.expr)) continue;
      add('W_LITERAL_NUMBER', 'warning', `${what} has the constant {${h.expr.trim()}}, which never follows the sliders`, path, 'bind it to a param or state value, or write the number as text and add it to lint.allowNumbers if it is a true constant');
    }
  };
  for (const n of model.narration) scanHoles(n.text, n.path + '.text', 'caption');
  for (const c of model.claims) scanHoles(c.text, c.path + '.text', `claim "${c.id}"`);

  const cited = new Set();
  for (const n of model.narration) for (const id of n.cites) cited.add(id);
  const byId = new Map((defaults ? defaults.results : []).map((r) => [r.id, r]));
  for (const c of model.claims) {
    if (!cited.has(c.id)) add('W_UNCITED_CLAIM', 'warning', `no caption cites claim "${c.id}"`, c.path, `add "${c.id}" to the cites of the caption where the reader sees it happen`);
  }
  for (const n of model.narration) {
    for (const id of n.cites) {
      const r = byId.get(id);
      if (r && !r.pass) add('E_CITES_FAILING_CLAIM', 'error', `caption cites claim "${id}", which fails at the default params`, n.path + '.cites', 'fix the model or the claim; never cite a claim that fails');
    }
  }

  for (const c of model.claims) {
    const inner = c.kind === 'sweep' ? c.inner : c;
    if (inner.kind === 'compare' || !inner.expr) continue;
    const refs = inner.expr.refs;
    const dynamic = [...refs].some((r) => model.stateNames.includes(r) || model.derivedGetters.has(r) || r === 't' || r === 'tick' || r === 'payload' || r === 'seq' || r === 'batch');
    if (!dynamic) add('W_CONSTANT_CLAIM', 'warning', `claim "${c.id}" only looks at params and constants, so it says nothing about how the system behaves`, c.path + '.expr', 'refer to state, derived values or t');
  }

  // a part's "expect": an independent expression its shown value must equal
  if (defaults && defaults.trace && !defaults.trace.error) {
    for (const p of model.parts) {
      if (!p.expect) continue;
      const key = p.type === 'tank' ? 'level' : 'value';
      const shown = p[key];
      if (!shown) continue;
      const trace = defaults.trace;
      for (let k = 0; k <= trace.K; k++) {
        const env = snapshotEnv(trace, k);
        let a;
        let b;
        try { a = shown(env); b = p.expect(env); } catch (e) {
          add('E_BINDING_EXPECT', 'error', `part "${p.id}": ${e.message || e} while comparing its ${key} with its expect at t = ${autoNumber(Math.round(env.t * 1e6) / 1e6)}`, `parts.${p.id}.expect`);
          break;
        }
        const same = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)) : deepEqual(a, b);
        if (!same) {
          add('E_BINDING_EXPECT', 'error', `part "${p.id}" shows ${key} ${formatValue(a)} at t = ${autoNumber(Math.round(env.t * 1e6) / 1e6)}, but its expect "${p.spec.expect}" is ${formatValue(b)}`, `parts.${p.id}.${key}`, 'fix the binding (or the expect, if it was the one that was wrong); the reader sees the binding');
          break;
        }
      }
    }
  }

  if (defaults) {
    for (const r of defaults.results) {
      if (r.kind === 'whenever' && r.pass && r.stats && r.stats.fired === 0) {
        add('W_VACUOUS_CLAIM', 'warning', `claim "${r.id}" passes only because its event never fires at the default params`, `claims.${r.id}`, 'change the scenario so the event happens, or drop the claim');
      }
    }
  }

  if (opts.probes) {
    const breaks = opts.probes.filter((p) => p.failing.length);
    if (model.params.length && model.claims.length && !breaks.length) {
      add('W_NOT_BREAKABLE', 'warning', 'no slider at either end makes any claim fail, so readers cannot see where the explanation stops holding', 'claims', 'add a claim that depends on a param, such as one that only holds while load stays below capacity');
    }
    for (const p of opts.probes) {
      if (p.errors.length) {
        add('W_PARAM_EXTREME_ERROR', 'warning', `with ${p.param} = ${autoNumber(p.value)} the model fails: ${p.errors[0]}`, `params.${p.param}`, 'guard the rule (for example max(x, tiny)) or narrow the slider range');
      }
    }
  }
  return issues;
}

// Try every slider at its min and max (others at default) and record which claims fail.
export function probeParams(model) {
  const out = [];
  for (const p of model.params) {
    for (const value of [p.min, p.max]) {
      if (value === p.default) continue;
      const res = checkClaims(model, { [p.param || p.id]: value });
      const failing = res.results.filter((r) => !r.pass).map((r) => r.id);
      const errors = res.results.filter((r) => r.status === 'error').map((r) => `${r.error.code} ${r.error.message}`);
      out.push({ param: p.id, value, failing, errors: [...new Set(errors)] });
    }
  }
  return out;
}
