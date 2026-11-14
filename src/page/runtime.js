/* working-model page runtime. Plain browser JavaScript, inlined into every
   built page after the engine bundle (window-less global WM). No network,
   no storage, no timers beyond requestAnimationFrame. */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var CW = 80;
  var CH = 64;
  var GUT = 7;
  var root = document.getElementById('wm');
  var spec = JSON.parse(document.getElementById('wm-spec').textContent);
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var TONE_SET = { ink: 1, muted: 1, accent: 1, ok: 1, bad: 1, warn: 1, soft: 1, info: 1 };
  // Spec tones keep their names, but the page draws them in ink: status is
  // weight and shape, never hue. "accent" in a spec is a diagram emphasis, not
  // the page accent, which is kept for what the reader touches or has selected.
  var TONE_INK = { ink: 'var(--ink)', bad: 'var(--ink)', warn: 'var(--ink-2)', accent: 'var(--ink-2)', ok: 'var(--ink-2)', info: 'var(--muted)', muted: 'var(--muted)', soft: 'var(--line-strong)' };
  var PULSE = 'color-mix(in srgb, var(--ink) 9%, transparent)';

  // ------------------------------------------------------------ helpers --
  function h(tag, cls, text, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function s(tag, attrs, parent) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function setAttr(e, k, v) {
    var key = '_' + k;
    if (e[key] === v) return;
    e[key] = v;
    e.setAttribute(k, v);
  }
  // A tone name (or a spec's own #rrggbb, drawn as body ink) to an ink colour.
  function tone(v, fallback) {
    if (typeof v === 'string' && TONE_SET[v]) return TONE_INK[v];
    if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return 'var(--ink-2)';
    return TONE_INK[fallback] || 'var(--ink)';
  }
  function soft(v) {
    return 'color-mix(in srgb, ' + tone(v, 'accent') + ' 10%, transparent)';
  }
  // Paint a cell or chip by tone, as the page's status levels:
  // bad and ink are solid ink (L3), ok and accent an ink outline (L2), warn a
  // hatched outline, info and muted a quiet fill (L1), soft a dashed empty (L0).
  function paintTone(rect, textEl, tn, w) {
    var st = rect.style;
    var key = typeof tn === 'string' && TONE_SET[tn] ? tn : 'accent';
    var lw = w || 1.5;
    st.strokeDasharray = '';
    if (key === 'bad' || key === 'ink') { st.fill = 'var(--ink)'; st.stroke = 'var(--ink)'; st.strokeWidth = String(lw); }
    else if (key === 'warn') { st.fill = hatch('warn'); st.stroke = 'var(--ink-2)'; st.strokeWidth = String(lw); }
    else if (key === 'info' || key === 'muted') { st.fill = 'var(--surface-2)'; st.stroke = 'var(--line-strong)'; st.strokeWidth = '1'; }
    else if (key === 'soft') { st.fill = 'transparent'; st.stroke = 'var(--line-strong)'; st.strokeWidth = '1'; st.strokeDasharray = '3 2'; }
    else if (key === 'ok') { st.fill = 'var(--surface)'; st.stroke = 'var(--ink)'; st.strokeWidth = String(lw); }
    else { st.fill = 'var(--surface-2)'; st.stroke = 'var(--ink-2)'; st.strokeWidth = String(lw * 0.85); }
    if (textEl) textEl.style.fill = key === 'bad' || key === 'ink' ? 'var(--bg)' : key === 'info' || key === 'muted' ? 'var(--muted)' : 'var(--ink)';
  }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function lerp(a, b, f) { return a + (b - a) * f; }
  function icon(name) {
    var paths = {
      play: 'M5 3.5v9l8-4.5z',
      pause: 'M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z',
      back: 'M11.5 3.5v9L5.5 8zM4 3.5h1.5v9H4z',
      fwd: 'M4.5 3.5v9l6-4.5zM10.5 3.5H12v9h-1.5z',
      restart: 'M8 3a5 5 0 1 1-4.6 3H1.6L4.3 3l2.6 3H5.2A3.4 3.4 0 1 0 8 4.6z',
      check: 'M3 8.5l3 3 7-7.5',
      cross: 'M4 4l8 8M12 4l-8 8',
      reset: 'M3 8a5 5 0 1 0 1.5-3.6M3 2.5v3h3',
    };
    var stroke = name === 'check' || name === 'cross' || name === 'reset';
    var svgEl = s('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    var p = s('path', { d: paths[name] }, svgEl);
    if (stroke) { p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); } else p.setAttribute('fill', 'currentColor');
    return svgEl;
  }
  // Chip materialise (damping 1, response 0.25): scale 0.9 -> 1 and opacity 0 -> 1
  // on one spring. A new target retargets from the live value, so a chip that is
  // still appearing reverses smoothly, and nothing is ever locked.
  function chipSpring(el) {
    var sp = Fluid.spring({
      value: 1, response: 0.25, damping: 1,
      onUpdate: function (x) {
        var u = clamp(x, 0, 1);
        el.style.opacity = u >= 1 ? '' : u.toFixed(3);
        el.style.transform = u >= 1 ? '' : 'scale(' + (0.9 + 0.1 * u).toFixed(4) + ')';
      },
      onRest: function (x) { if (x <= 0) el.hidden = true; },
    });
    return {
      show: function () { if (el.hidden) { sp.set(0); el.hidden = false; } sp.to(1); },
      hide: function () { if (!el.hidden) sp.to(0); },
      // the chip's content changed: appear again, from wherever it is now
      pop: function () { if (sp.value >= 1 && sp.target >= 1) sp.set(0); el.hidden = false; sp.to(1); },
      jump: function (on) { sp.set(on ? 1 : 0); el.hidden = !on; },
    };
  }
  // The counterexample well: a disclosure body on a height spring (damping 1,
  // response 0.35) that reverses mid-flight from its live height.
  function wellSpring(well, inner) {
    var open = !well.hidden;
    var running = false;
    var sp = Fluid.spring({
      value: 0, response: 0.35, damping: 1,
      onUpdate: function (x) { well.style.height = Math.max(0, x).toFixed(1) + 'px'; },
      onRest: function () { running = false; well.style.height = ''; if (!open) well.hidden = true; },
    });
    return {
      get open() { return open; },
      set: function (on, animate) {
        if (on === open && !running) return;
        open = on;
        if (!animate) { sp.stop(); running = false; well.style.height = ''; well.hidden = !on; return; }
        if (!running) sp.set(on ? 0 : well.offsetHeight);
        well.hidden = false;
        running = true;
        sp.to(on ? inner.offsetHeight : 0);
      },
    };
  }
  // Press spring on a native slider thumb (1 -> 1.18, damping 1, response 0.18;
  // back with damping 0.8, response 0.3). The thumb is a pseudo-element, so the
  // spring writes --thumb-s, which the thumb's transform reads.
  function thumbPress(input) {
    var sp = Fluid.spring({ value: 1, response: 0.18, damping: 1, onUpdate: function (x) { input.style.setProperty('--thumb-s', x.toFixed(4)); } });
    function up() {
      if (!input.hasAttribute('data-pressed')) return;
      input.removeAttribute('data-pressed');
      sp.to(1, { response: 0.3, damping: 0.8 });
    }
    input.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      input.setAttribute('data-pressed', '');
      if (!Fluid.reduce()) sp.to(1.18, { response: 0.18, damping: 1 });
    });
    ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'].forEach(function (n) { input.addEventListener(n, up); });
    document.addEventListener('pointerup', up);
    return sp;
  }
  function press(el, scale) { if (window.Fluid) Fluid.pressable(el, scale ? { scale: scale } : null); return el; }
  function fmt(v, f) { return WM.formatValue(v, f); }
  function fmtTime(t) {
    var u = model.timeUnit || '';
    var digits = model.dt < 0.01 ? 3 : model.dt < 0.1 ? 2 : model.dt < 1 ? 1 : 0;
    return 't = ' + t.toFixed(digits) + (u ? ' ' + u : '');
  }
  function fmtSpan(a, b) {
    var u = model.timeUnit ? ' ' + model.timeUnit : '';
    return WM.formatValue(Math.round(a * 1000) / 1000) + ' to ' + WM.formatValue(Math.round(b * 1000) / 1000) + u;
  }

  // ------------------------------------------------------------ compile --
  var compiled;
  try { compiled = WM.compileModel(spec); } catch (e) { return fatal('Internal error: ' + e.message); }
  if (compiled.errors.length) {
    return fatal('This model has errors:\n' + compiled.errors.map(function (e) { return e.code + ' ' + (e.loc && e.loc.path ? e.loc.path + ': ' : '') + e.message; }).join('\n'));
  }
  var model = compiled.model;
  function fatal(msg) { root.innerHTML = ''; h('div', 'wm-error', msg, root); window.workingModel = { ready: true, error: msg }; return null; }

  var defaults = {};
  model.params.forEach(function (p) { defaults[p.id] = p.default; });
  var params = Object.assign({}, defaults);
  var baseSpeed = (model.playback && model.playback.speed) || model.duration / 15;
  var check = null;
  var trace = null;
  var T = 0;
  var playing = false;
  var speedMul = 1;
  var lastNow = 0;
  var bindingErrors = [];

  // ---------------------------------------------------------------- DOM --
  document.title = model.title + ' - working model';
  root.innerHTML = '';
  var head = h('header', 'wm-head', null, root);
  h('div', 'wm-kicker', 'Working model', head);
  h('h1', 'wm-title', model.title, head);
  var summaryEl = h('p', 'wm-summary', '', head);
  // The claims counter: "6 of 6 claims hold", or "5 of 6 claims hold · 1 fails"
  // with the fails part as an inverse (L3) chip. It sits straight and never bounces.
  var counter = h('div', 'wm-counter', null, head);
  counter.setAttribute('role', 'status');
  counter.setAttribute('aria-live', 'polite');
  counter.setAttribute('data-testid', 'claims-counter');
  var counterText = h('span', null, '', counter);
  counterText.setAttribute('data-testid', 'claims-summary');
  var counterSep = h('span', 'sep', '·', counter);
  counterSep.setAttribute('aria-hidden', 'true');
  var failChip = h('span', 'wm-chip l3', null, counter);
  failChip.setAttribute('data-testid', 'claims-fails');
  failChip.setAttribute('data-level', '3');
  failChip.appendChild(icon('cross'));
  var failChipText = h('span', null, '', failChip);
  var failChipSp = chipSpring(failChip);

  var main = h('main', 'wm-main', null, root);
  var stage = h('section', 'wm-stage', null, main);
  stage.setAttribute('aria-label', 'Animated model');
  var figure = h('figure', 'wm-figure', null, stage);
  var VW = model.layout.cols * CW;
  var VH = model.layout.rows * CH;
  var svg = s('svg', { 'class': 'wm-diagram', viewBox: '0 0 ' + VW + ' ' + VH, role: 'img', 'aria-label': model.title + ' diagram' }, figure);
  var defs = s('defs', null, svg);
  var layerGroups = s('g', null, svg);
  var layerLinks = s('g', null, svg);
  var layerParts = s('g', null, svg);
  var layerParticles = s('g', { 'pointer-events': 'none' }, svg);

  var caption = h('div', 'wm-caption', null, stage);
  caption.setAttribute('aria-live', 'polite');
  var capTime = h('div', 'wm-caption-time', '', caption);
  var capText = h('p', 'wm-caption-text', '', caption);
  var capCites = h('div', 'wm-caption-cites', null, caption);
  var capNote = h('div', 'wm-cite-note', '', caption);
  capNote.hidden = true;

  var transport = h('div', 'wm-transport', null, stage);
  var bPlay = h('button', 'wm-btn primary', null, transport);
  bPlay.type = 'button';
  var bBack = h('button', 'wm-btn', null, transport);
  bBack.type = 'button'; bBack.setAttribute('aria-label', 'Step back one tick'); bBack.appendChild(icon('back'));
  var bFwd = h('button', 'wm-btn', null, transport);
  bFwd.type = 'button'; bFwd.setAttribute('aria-label', 'Step forward one tick'); bFwd.appendChild(icon('fwd'));
  press(bPlay); press(bBack); press(bFwd);
  var scrubWrap = h('div', 'wm-scrubwrap', null, transport);
  scrubWrap.setAttribute('data-testid', 'scrubber');
  var marks = h('div', 'wm-marks', null, scrubWrap);
  var track = h('div', 'wm-track', null, scrubWrap);
  var trackFill = h('div', 'wm-track-fill', null, track);
  var scrub = h('input', 'wm-scrub', null, scrubWrap);
  scrub.type = 'range'; scrub.min = '0'; scrub.max = String(model.duration); scrub.step = 'any'; scrub.value = '0';
  scrub.setAttribute('aria-label', 'Time');
  var thumb = h('div', 'wm-thumb', null, scrubWrap);
  thumb.setAttribute('aria-hidden', 'true');
  var clock = h('span', 'wm-clock', '', transport);
  var speedBox = h('div', 'wm-speed', null, transport);
  speedBox.setAttribute('role', 'group');
  speedBox.setAttribute('aria-label', 'Playback speed');
  [0.5, 1, 2, 4].forEach(function (m) {
    var b = press(h('button', null, (m === 0.5 ? '½' : m) + '×', speedBox), 0.94);
    b.type = 'button';
    b.setAttribute('aria-pressed', m === 1 ? 'true' : 'false');
    b.setAttribute('aria-label', 'Speed ' + m + ' times');
    b.addEventListener('click', function () {
      speedMul = m;
      Array.prototype.forEach.call(speedBox.children, function (c) { c.setAttribute('aria-pressed', c === b ? 'true' : 'false'); });
    });
  });

  var side = h('aside', 'wm-side', null, main);
  var claimsPanel = h('section', 'wm-panel wm-claims', null, side);
  claimsPanel.setAttribute('aria-label', 'Claims');
  var claimsH = h('h2', null, 'Claims', claimsPanel);
  var claimsN = h('span', 'wm-chip l1', '', claimsH);
  claimsN.setAttribute('data-level', '1');
  var claimsList = h('ol', null, null, claimsPanel);
  var claimResetRow = h('div', 'wm-reset-row', null, claimsPanel);
  h('p', null, 'A claim fails at these settings. The explanation only holds inside the range where its claims pass.', claimResetRow);
  var bResetClaims = press(h('button', 'wm-btn wm-mini', null, claimResetRow));
  bResetClaims.type = 'button'; bResetClaims.setAttribute('data-action', 'reset');
  bResetClaims.appendChild(icon('reset')); bResetClaims.appendChild(document.createTextNode('Reset parameters'));
  claimResetRow.hidden = true;
  // Mutation score, only when it was computed at build time and stored in the page.
  var mutation = null;
  var mutationEl = document.getElementById('wm-mutation');
  if (mutationEl) {
    try { mutation = JSON.parse(mutationEl.textContent); } catch (e) { mutation = null; }
  }
  if (mutation && typeof mutation.scorePercent === 'number') {
    var mutP = h('p', 'wm-mutation', null, claimsPanel);
    h('strong', null, 'Mutation score ' + mutation.scorePercent + '%', mutP);
    mutP.appendChild(document.createTextNode(': at build time, the rules were broken on purpose in ' + mutation.scored +
      ' observable ways; ' + mutation.killed + ' of them made a claim fail or the model stop with an error.'));
  }

  var paramsPanel = null;
  var paramViews = [];
  if (model.params.length) {
    paramsPanel = h('section', 'wm-panel wm-params', null, side);
    paramsPanel.setAttribute('aria-label', 'Parameters');
    h('h2', null, 'Parameters', paramsPanel);
    model.params.forEach(function (p) {
      var row = h('div', 'wm-param', null, paramsPanel);
      var lab = h('label', null, null, row);
      var id = 'wm-p-' + p.id;
      lab.htmlFor = id;
      h('span', null, p.label, lab);
      var out = h('output', null, '', lab);
      out.htmlFor = id;
      var pv = { p: p, out: out };
      if (p.choices) {
        var group = h('div', 'wm-choice', null, row);
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', p.label);
        group.setAttribute('data-param', p.id);
        group.id = id;
        pv.buttons = p.choices.map(function (label, i) {
          var b = press(h('button', null, label, group), 0.96);
          b.type = 'button';
          b.setAttribute('role', 'radio');
          var val = p.min + i * p.step;
          b.setAttribute('data-value', String(val));
          b.addEventListener('click', function () { params[p.id] = val; updateParamView(pv); scheduleRecompute(); });
          return b;
        });
      } else {
        var input = h('input', null, null, row);
        input.type = 'range'; input.id = id; input.min = String(p.min); input.max = String(p.max); input.step = String(p.step);
        input.value = String(p.default);
        input.setAttribute('data-param', p.id);
        thumbPress(input);
        var rng = h('div', 'range', null, row);
        h('span', null, fmt(p.min, p.format), rng);
        h('span', null, fmt(p.max, p.format), rng);
        input.addEventListener('input', function () {
          params[p.id] = Number(input.value);
          updateParamView(pv);
          scheduleRecompute();
        });
        pv.input = input;
      }
      if (p.help) h('p', 'help', p.help, row);
      paramViews.push(pv);
      updateParamView(pv);
    });
    var pr = h('div', 'wm-reset-row', null, paramsPanel);
    h('p', null, 'Drag a slider and watch the claims re-check.', pr);
    var bResetParams = press(h('button', 'wm-btn wm-mini', null, pr));
    bResetParams.type = 'button'; bResetParams.setAttribute('data-action', 'reset-params');
    bResetParams.appendChild(icon('reset')); bResetParams.appendChild(document.createTextNode('Reset'));
    bResetParams.addEventListener('click', resetParams);
  }
  bResetClaims.addEventListener('click', resetParams);

  var foot = h('footer', 'wm-foot', null, root);
  var footL = h('div', null, null, foot);
  if (spec.sources && spec.sources.length) {
    h('div', null, 'Sources', footL).style.fontWeight = '600';
    var ul = h('ul', null, null, footL);
    spec.sources.forEach(function (src) {
      var li = h('li', null, null, ul);
      if (src.url && /^https?:\/\//.test(src.url)) {
        var a = h('a', null, src.title, li);
        a.href = src.url; a.rel = 'noopener noreferrer'; a.target = '_blank';
      } else h('span', null, src.title, li);
      if (src.note) li.appendChild(document.createTextNode(' - ' + src.note));
    });
  }
  var keys = h('div', 'wm-keys', null, footL);
  keys.innerHTML = '<kbd>Space</kbd> play or pause &nbsp; <kbd>&larr;</kbd> <kbd>&rarr;</kbd> step &nbsp; <kbd>Home</kbd> start';
  h('div', 'brand', 'Built with working-model. Every claim is re-checked in this page by simulation.', foot);

  function updateParamView(pv) {
    var v = params[pv.p.id];
    pv.out.classList.toggle('changed', v !== pv.p.default);
    if (pv.buttons) {
      var idx = Math.round((v - pv.p.min) / pv.p.step);
      pv.out.textContent = '';
      pv.buttons.forEach(function (b, i) { b.setAttribute('aria-checked', i === idx ? 'true' : 'false'); b.tabIndex = i === idx ? 0 : -1; });
      return;
    }
    pv.out.textContent = fmt(v, pv.p.format) + (pv.p.unit ? ' ' + WM.unitFor(v, pv.p.unit) : '');
    if (Number(pv.input.value) !== v) pv.input.value = String(v);
    var f = (v - pv.p.min) / (pv.p.max - pv.p.min) * 100;
    pv.input.style.setProperty('--fill', f + '%');
  }

  // -------------------------------------------------------- claims panel --
  var claimViews = model.claims.map(function (c) {
    var li = h('li', 'wm-claim', null, claimsList);
    li.setAttribute('data-claim-id', c.id);
    li.id = 'wm-claim-' + c.id;
    var mark = h('div', 'mark', null, li);
    var body = h('div', 'body', null, li);
    var text = h('p', 'text', '', body);
    var meta = h('div', 'meta', null, body);
    h('span', 'cid', kindLabel(c), meta);
    var well = h('div', 'well', null, body);
    well.hidden = true;
    var wellIn = h('div', 'well-in', null, well);
    var why = h('div', 'why', '', wellIn);
    var show = press(h('button', 'wm-btn wm-mini show', 'Show when it fails', wellIn));
    show.type = 'button';
    show.addEventListener('click', function () {
      var r = resultOf(c.id);
      if (r && r.counterexample && r.counterexample.t != null) { pause(); setTime(r.counterexample.t); }
    });
    return { c: c, li: li, mark: mark, markSp: chipSpring(mark), well: wellSpring(well, wellIn), text: text, why: why, show: show, status: null };
  });
  function kindLabel(c) {
    switch (c.kind) {
      case 'at': return 'at a moment';
      case 'always': return 'always';
      case 'never': return 'never';
      case 'eventually': return 'eventually';
      case 'whenever': return 'whenever ' + c.event;
      case 'sweep': return 'sweep of ' + c.samples + ' param sets';
      case 'compare': return 'compare two runs';
      default: return c.kind;
    }
  }
  function resultOf(id) {
    if (!check) return null;
    for (var i = 0; i < check.results.length; i++) if (check.results[i].id === id) return check.results[i];
    return null;
  }
  function updateClaims() {
    var passed = check.passed;
    var total = check.total;
    var allPass = passed === total;
    var fails = total - passed;
    var first = counter.getAttribute('data-passed') == null;
    counterText.textContent = passed + ' of ' + total + ' claims hold';
    counter.setAttribute('data-status', allPass ? 'pass' : 'fail');
    counter.setAttribute('data-passed', String(passed));
    counter.setAttribute('data-total', String(total));
    counter.setAttribute('data-fails', String(fails));
    if (fails > 0) failChipText.textContent = fails + ' fails';
    counterSep.hidden = fails === 0;
    if (first) failChipSp.jump(fails > 0); else if (fails > 0) failChipSp.show(); else failChipSp.hide();
    claimsN.textContent = passed + ' of ' + total;
    claimViews.forEach(function (cv) {
      var r = resultOf(cv.c.id);
      if (!r) return;
      var flipped = cv.status !== null && cv.status !== r.status;
      cv.text.textContent = r.text;
      cv.li.setAttribute('data-status', r.status);
      if (flipped || cv.status === null) {
        cv.mark.innerHTML = '';
        cv.mark.appendChild(icon(r.pass ? 'check' : 'cross'));
      }
      cv.mark.setAttribute('aria-label', r.pass ? 'passes' : 'fails');
      cv.mark.setAttribute('data-level', r.pass ? '1' : '3');
      if (!r.pass) cv.why.textContent = r.line;
      cv.show.hidden = !(r.counterexample && r.counterexample.t != null);
      // a claim that flips materialises its new state; the well opens or
      // closes from its live height, so dragging back mid-flight reverses it
      if (flipped) cv.markSp.pop();
      cv.well.set(!r.pass, flipped);
      cv.status = r.status;
    });
    claimResetRow.hidden = allPass;
  }

  // ------------------------------------------------------------- text fit --
  // Text keeps a readable on-screen size at every width: a role gives a size
  // in viewBox units at full scale and a minimum in screen pixels. Parts lay
  // themselves out from these sizes, so a phone gets the same diagram with
  // relatively larger text instead of unreadable text.
  var ROLES = {
    label: { base: 11.5, min: 8.5 },
    value: { base: 16, min: 10 },
    big: { base: 28, min: 13 },
    small: { base: 11, min: 8.5 },
    chip: { base: 13, min: 8.5 },
  };
  var scale = 1;
  var laidOut = false;
  var texts = [];
  function U(role) { var r = ROLES[role]; return Math.max(r.base, r.min / scale); }
  function T_(parent, cls, role, attrs) {
    var e = s('text', attrs || null, parent);
    if (cls) e.setAttribute('class', cls);
    var rec = { el: e, role: role, base: null, min: null, maxW: null, str: null, fs: 0 };
    texts.push(rec);
    return rec;
  }
  function baseOf(rec) { return rec.base != null ? rec.base : ROLES[rec.role].base; }
  function minOf(rec) { return rec.min != null ? rec.min : ROLES[rec.role].min; }
  function setText(rec, str) {
    if (rec.str === str) return;
    var relen = rec.str == null || rec.str.length !== str.length;
    rec.str = str;
    rec.el.textContent = str;
    if (relen || !rec.fs) fit(rec);
  }
  function fit(rec) {
    var fs = Math.max(baseOf(rec), minOf(rec) / scale);
    if (rec.maxH) fs = Math.max(minOf(rec) * 0.88 / scale, Math.min(fs, rec.maxH / 1.05));
    if (rec.wrapped) { rec.wrapped = false; rec.el.textContent = rec.str || ''; }
    rec.el.setAttribute('font-size', fs.toFixed(2));
    rec.fs = fs;
    if (rec.maxW && rec.str) {
      var w = 0;
      try { w = rec.el.getComputedTextLength(); } catch (e) { w = 0; }
      if (w > rec.maxW) {
        var floor = (minOf(rec) * 0.88) / scale;
        var want = fs * rec.maxW / w;
        if (want < floor && rec.wrap && rec.str.indexOf(' ') > 0) {
          wrapText(rec, Math.max(floor, Math.min(fs, (minOf(rec) / scale))), w / fs);
          return;
        }
        fs = Math.max(floor, want);
        rec.el.setAttribute('font-size', fs.toFixed(2));
        rec.fs = fs;
      }
    }
  }
  // Break text into at most rec.wrap lines; perEm is the text width per unit of font size.
  function wrapText(rec, fs, perEm) {
    var words = rec.str.split(' ');
    var charW = perEm * fs / rec.str.length;
    var perLine = Math.max(4, Math.floor(rec.maxW / charW));
    var lines = [];
    var cur = '';
    words.forEach(function (wd) {
      if (cur && (cur + ' ' + wd).length > perLine) { lines.push(cur); cur = wd; } else cur = cur ? cur + ' ' + wd : wd;
    });
    if (cur) lines.push(cur);
    var maxLines = rec.wrap === true ? 3 : rec.wrap;
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = lines[maxLines - 1].split(" ").slice(0, -1).join(" ") + "…";
    }
    var longest = lines.reduce(function (a, b) { return Math.max(a, b.length); }, 0);
    if (longest * charW > rec.maxW) fs = Math.max((minOf(rec) * 0.8) / scale, fs * rec.maxW / (longest * charW));
    rec.el.textContent = '';
    rec.el.setAttribute('font-size', fs.toFixed(2));
    var x = rec.el.getAttribute('x');
    lines.forEach(function (ln, i) {
      var ts = s('tspan', { x: x, dy: i === 0 ? (-(lines.length - 1) * 0.6) + 'em' : '1.2em' }, rec.el);
      ts.textContent = ln;
    });
    rec.fs = fs;
    rec.wrapped = true;
  }
  function place(rec, x, y, maxW, anchor, maxH) {
    rec.el.setAttribute('x', x.toFixed(2));
    rec.el.setAttribute('y', y.toFixed(2));
    if (anchor) rec.el.setAttribute('text-anchor', anchor);
    rec.maxW = maxW != null ? Math.max(4, maxW) : null;
    rec.maxH = maxH != null ? Math.max(4, maxH) : null;
  }
  function dropText(rec) {
    var i = texts.indexOf(rec);
    if (i >= 0) texts.splice(i, 1);
  }
  function applyScale(force) {
    var w = svg.getBoundingClientRect().width;
    if (!w) {
      if (!laidOut) { laidOut = true; views.forEach(function (v) { if (v.layout) v.layout(); }); views.forEach(function (v) { if (v.layoutLink) v.layoutLink(); }); }
      return;
    }
    laidOut = true;
    var ns = w / VW;
    if (!force && Math.abs(ns - scale) < 0.002 && texts.length && texts[0].fs) return;
    scale = ns;
    views.forEach(function (v) { v.legendRow2 = false; if (v.layout) v.layout(); });
    texts.forEach(fit);
    views.forEach(function (v) { if (v.layoutLink) v.layoutLink(); if (v.afterFit) v.afterFit(); });
  }

  // ---------------------------------------------------------------- parts --
  function rectOf(at) {
    return { x: at[0] * CW + GUT, y: at[1] * CH + GUT, w: at[2] * CW - 2 * GUT, h: at[3] * CH - 2 * GUT };
  }
  function evalB(fn, env, fallback, where) {
    if (!fn) return fallback;
    try { return fn(env); } catch (e) {
      if (bindingErrors.length < 20) bindingErrors.push(where + ': ' + (e.code || '') + ' ' + e.message);
      return fallback;
    }
  }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function alarmOn(p, tn) { return tn === 'bad' && !(p.spec && typeof p.spec.tone === 'string' && TONE_SET[p.spec.tone]); }

  var views = [];
  // maps keyed by names from the spec have no prototype, so an emit or part
  // called "constructor" or "toString" cannot match an inherited property
  var viewById = Object.create(null);
  var hatchIds = Object.create(null);
  function hatch(tn) {
    var key = tn || 'accent';
    if (hatchIds[key]) return 'url(#' + hatchIds[key] + ')';
    var id = 'wm-hatch-' + Object.keys(hatchIds).length;
    hatchIds[key] = id;
    var pat = s('pattern', { id: id, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(40)' }, defs);
    var bg = s('rect', { width: 7, height: 7 }, pat);
    bg.style.fill = soft(key);
    var ln = s('line', { x1: 0, y1: 0, x2: 0, y2: 7, 'stroke-width': 2.2 }, pat);
    ln.style.stroke = tone(key, 'accent');
    ln.style.opacity = '0.55';
    return 'url(#' + id + ')';
  }

  function frameBox(g, r) {
    var fr = s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 6, 'class': 'frame' }, g);
    var pulse = s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 6, opacity: 0 }, g);
    pulse.style.pointerEvents = 'none';
    return { frame: fr, pulse: pulse };
  }
  // The area under the part's label.
  function content(v) {
    var r = v.r;
    var top = r.y + 6;
    if (v.labelText) top += U('label') * 1.25 + 3;
    return { x: r.x + 10, y: top, w: r.w - 20, h: r.y + r.h - 6 - top, bottom: r.y + r.h - 6 };
  }
  // A part too short for a label row above its value puts both on one line.
  function isCompact(v) {
    if (!v.labelText) return false;
    return v.r.h - 12 < U('label') * 1.25 + 3 + U('value') * 1.3;
  }
  function layoutCompact(v, valueRec) {
    var r = v.r;
    var cy = r.y + r.h / 2;
    place(v.labelText, r.x + 10, cy, r.w * 0.56 - 14, 'start');
    place(valueRec, r.x + r.w - 10, cy, r.w * 0.44 - 12, 'end', r.h - 8);
  }
  function makeLabel(v, g) {
    if (!v.part.label) return;
    v.labelText = T_(g, 'p-label', 'label');
    v.texts.push(v.labelText);
    setText(v.labelText, v.part.label.toUpperCase());
  }
  function layoutLabel(v) {
    if (!v.labelText) return;
    place(v.labelText, v.r.x + 10, v.r.y + 6 + U('label') * 0.62, v.r.w - 20, 'start');
  }

  function makeView(part) {
    var g = s('g', { 'data-part': part.id, 'data-type': part.type });
    var v = { part: part, g: g, texts: [] };
    var r = part.at ? rectOf(part.at) : null;
    v.r = r;
    v.anchor = r;
    if (r) v.bounds = s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: 'none', stroke: 'none', 'class': 'bounds' }, g);
    var mk = MAKERS[part.type];
    if (mk) mk(v, g, r, part);
    if (r && part.type !== 'group' && part.type !== 'label') v.hl = s('rect', { x: r.x - 4, y: r.y - 4, width: r.w + 8, height: r.h + 8, rx: 9, 'class': 'hl' }, g);
    return v;
  }

  var MAKERS = {
    group: function (v, g, r, p) {
      var rr = { x: r.x - GUT * 0.5, y: r.y - GUT * 0.5, w: r.w + GUT, h: r.h + GUT };
      s('rect', { x: rr.x, y: rr.y, width: rr.w, height: rr.h, rx: 10, 'class': 'group-frame' }, g);
      if (p.label) {
        var t = T_(g, 'p-label', 'label');
        t.el.style.paintOrder = 'stroke';
        t.el.style.stroke = 'var(--surface)';
        t.el.style.strokeWidth = '6px';
        t.el.style.strokeLinejoin = 'round';
        setText(t, p.label.toUpperCase());
        v.texts.push(t);
        v.layout = function () { place(t, rr.x + 14, rr.y, rr.w - 28, 'start'); };
      }
    },
    box: function (v, g, r, p) {
      var f = frameBox(g, r);
      makeLabel(v, g);
      v.text = T_(g, 'p-value', 'value');
      v.text.wrap = true;
      v.texts.push(v.text);
      v.layout = function () {
        if (isCompact(v)) { v.text.wrap = false; layoutCompact(v, v.text); return; }
        v.text.wrap = true;
        layoutLabel(v);
        var c = content(v);
        place(v.text, r.x + r.w / 2, c.y + c.h / 2, r.w - 18, 'middle', c.h);
      };
      v.update = function (fr) {
        var tn = evalB(p.tone, fr.env0, null, p.id + '.tone');
        f.frame.classList.toggle('alarm', alarmOn(p, tn));
        if (p.text) setText(v.text, evalB(p.text, fr.env0, '', p.id + '.text'));
        pulseFill(v, f.pulse, tn || 'accent', fr);
      };
    },
    counter: function (v, g, r, p) {
      var f = frameBox(g, r);
      makeLabel(v, g);
      v.text = T_(g, 'p-big', 'big');
      v.texts.push(v.text);
      v.layout = function () {
        if (isCompact(v)) { v.text.role = 'value'; layoutCompact(v, v.text); return; }
        v.text.role = 'big';
        layoutLabel(v);
        var c = content(v);
        place(v.text, r.x + r.w / 2, c.y + c.h / 2 + 1, r.w - 16, 'middle', c.h);
      };
      v.update = function (fr) {
        var val = evalB(p.value, fr.env0, 0, p.id + '.value');
        var tn = evalB(p.tone, fr.env0, null, p.id + '.tone');
        v.text.el.style.fill = tn === 'muted' || tn === 'info' || tn === 'soft' ? 'var(--ink-2)' : 'var(--ink)';
        f.frame.classList.toggle('alarm', alarmOn(p, tn));
        setText(v.text, fmt(val, p.format) + (p.unit ? ' ' + p.unit : ''));
        var since = v.changes ? sinceLast(v.changes, fr.k) : Infinity;
        var a = reduceMotion ? 0 : clamp(1 - (since * model.dt) / (0.3 * baseSpeed), 0, 1) * 0.6;
        if (v.pulseTimes) {
          var t0 = lastBefore(v.pulseTimes, fr.t);
          if (t0 != null && !reduceMotion) a = Math.max(a, clamp(1 - (fr.t - t0) / (0.4 * baseSpeed), 0, 1));
        }
        f.pulse.style.fill = PULSE;
        setAttr(f.pulse, 'opacity', a.toFixed(2));
      };
      v.recompute = function () {
        v.changes = [];
        var prev;
        for (var k = 0; k <= trace.K; k++) {
          var val = evalB(p.value, WM.snapshotEnv(trace, k), 0, p.id + '.value');
          if (k > 0 && val !== prev) v.changes.push(k);
          prev = val;
        }
        // a value that changes nearly every tick would flash all the time
        if (v.changes.length > trace.K * 0.25) v.changes = null;
      };
    },
    tank: function (v, g, r, p) {
      makeLabel(v, g);
      var tn0 = typeof p.spec.tone === 'string' && TONE_SET[p.spec.tone] ? p.spec.tone : 'accent';
      var cid = 'wm-clip-' + p.id.replace(/[^A-Za-z0-9_-]/g, '');
      var cp = s('clipPath', { id: cid }, defs);
      var clipPathEl = s('path', null, cp);
      var shell = s('g', null, g);
      var liquid = s('g', { 'clip-path': 'url(#' + cid + ')' }, g);
      v.fill = s('rect', null, liquid);
      v.fill.style.fill = hatch(tn0);
      v.surface = s('path', { d: '', 'stroke-width': 2.2, fill: 'none' }, liquid);
      v.surface.style.stroke = tone(tn0, 'accent');
      v.surface.style.vectorEffect = 'non-scaling-stroke';
      var outline = s('g', null, g);
      v.pulse = s('path', { opacity: 0 }, g);
      if (p.text) { v.text = T_(g, 'p-value', 'value'); v.texts.push(v.text); }
      v.layout = function () {
        layoutLabel(v);
        var c = content(v);
        var textH = p.text ? U('value') * 1.3 + 2 : 0;
        var vh = Math.max(14, c.h - textH - 2);
        var vw = Math.min(c.w - 8, Math.max(36, vh * 1.05));
        var vx = r.x + (r.w - vw) / 2;
        var vy = c.y + 2;
        var rad = Math.min(14, vw / 5, vh / 3);
        v.geo = { vx: vx, vy: vy, vw: vw, vh: vh };
        v.anchor = { x: vx, y: vy, w: vw, h: vh };
        var vessel = 'M' + vx + ',' + vy + ' L' + vx + ',' + (vy + vh - rad) + ' Q' + vx + ',' + (vy + vh) + ' ' + (vx + rad) + ',' + (vy + vh) +
          ' L' + (vx + vw - rad) + ',' + (vy + vh) + ' Q' + (vx + vw) + ',' + (vy + vh) + ' ' + (vx + vw) + ',' + (vy + vh - rad) + ' L' + (vx + vw) + ',' + vy;
        clipPathEl.setAttribute('d', vessel + ' Z');
        shell.textContent = '';
        s('path', { d: vessel + ' Z', 'class': 'frame' }, shell).style.stroke = 'none';
        outline.textContent = '';
        for (var i = 1; i < 4; i++) {
          var yy = vy + vh - (vh * i) / 4;
          s('line', { x1: vx + vw - Math.min(10, vw / 6), x2: vx + vw, y1: yy, y2: yy, 'class': 'hair' }, outline);
        }
        s('path', { d: vessel, 'class': 'hair' }, outline).style.strokeWidth = '2';
        s('line', { x1: vx - 6, x2: vx + 3, y1: vy, y2: vy, 'class': 'hair' }, outline);
        s('line', { x1: vx + vw - 3, x2: vx + vw + 6, y1: vy, y2: vy, 'class': 'hair' }, outline);
        v.pulse.setAttribute('d', vessel + ' Z');
        if (v.text) place(v.text, r.x + r.w / 2, c.bottom - U('value') * 0.62, r.w - 12, 'middle');
      };
      v.update = function (fr) {
        var G = v.geo;
        var a = num(evalB(p.level, fr.env0, 0, p.id + '.level'), 0);
        var b = num(evalB(p.level, fr.env1, a, p.id + '.level'), a);
        var lv = clamp(lerp(a, b, fr.f), 0, 1);
        var ly = G.vy + G.vh - lv * G.vh;
        setAttr(v.fill, 'x', (G.vx - 2).toFixed(2));
        setAttr(v.fill, 'width', (G.vw + 4).toFixed(2));
        setAttr(v.fill, 'y', ly.toFixed(2));
        setAttr(v.fill, 'height', Math.max(0, G.vy + G.vh - ly + 2).toFixed(2));
        var amp = reduceMotion || lv <= 0.001 || lv >= 0.999 ? 0 : 2;
        var ph = fr.t / Math.max(1e-9, baseSpeed) * 2.4;
        var d = 'M' + (G.vx - 2).toFixed(2) + ',' + ly.toFixed(2);
        for (var i = 1; i <= 12; i++) {
          var x = G.vx - 2 + ((G.vw + 4) * i) / 12;
          d += ' L' + x.toFixed(2) + ',' + (ly + Math.sin(ph + i * 0.9) * amp).toFixed(2);
        }
        setAttr(v.surface, 'd', d);
        setAttr(v.surface, 'opacity', lv <= 0.001 ? 0 : 1);
        if (p.text) setText(v.text, evalB(p.text, fr.env0, '', p.id + '.text'));
        pulseFill(v, v.pulse, tn0, fr);
      };
    },
    lamp: function (v, g, r, p) {
      var f = frameBox(g, r);
      makeLabel(v, g);
      v.bulb = s('circle', { 'class': 'hair' }, g);
      v.bulb.style.strokeWidth = '1.5';
      v.glyph = s('path', { fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      v.glyph.style.stroke = 'var(--bg)';
      v.glyph.style.vectorEffect = 'non-scaling-stroke';
      if (p.text) { v.text = T_(g, 'p-value', 'value'); v.texts.push(v.text); }
      v.layout = function () {
        layoutLabel(v);
        var c = content(v);
        if (c.h < U('value') * 1.2) {
          v.labelText && place(v.labelText, r.x + 10, r.y + r.h / 2, r.w * 0.4, 'start');
          c = { x: r.x + r.w * 0.42, y: r.y + 6, w: r.w * 0.58 - 10, h: r.h - 12, bottom: r.y + r.h - 6 };
        }
        var rad = clamp(c.h / 2 - 3, 5, 15);
        var cx = c.x + rad + 2;
        var cy = c.y + c.h / 2;
        v.geo = { cx: cx, cy: cy, rad: rad };
        v.glyphKey = null;
        v.bulb.setAttribute('cx', cx); v.bulb.setAttribute('cy', cy); v.bulb.setAttribute('r', rad);
        if (v.text) place(v.text, cx + rad + 10, cy, r.x + r.w - (cx + rad + 10) - 8, 'start');
      };
      v.update = function (fr) {
        var on = evalB(p.on, fr.env0, false, p.id + '.on') === true;
        var tn = evalB(p.tone, fr.env0, null, p.id + '.tone') || 'ok';
        v.bulb.style.fill = on ? (tn === 'bad' || tn === 'ink' ? 'var(--ink)' : 'var(--ink-2)') : 'var(--surface)';
        v.bulb.style.stroke = on ? 'var(--ink)' : 'var(--muted)';
        var gk = on ? (tn === 'bad' ? 'cross' : tn === 'ok' ? 'check' : '') : '';
        if (gk !== v.glyphKey && v.geo) {
          v.glyphKey = gk;
          var G = v.geo, q = G.rad * 0.42;
          v.glyph.setAttribute('d', gk === 'cross' ? 'M' + (G.cx - q) + ',' + (G.cy - q) + 'L' + (G.cx + q) + ',' + (G.cy + q) + 'M' + (G.cx + q) + ',' + (G.cy - q) + 'L' + (G.cx - q) + ',' + (G.cy + q)
            : gk === 'check' ? 'M' + (G.cx - q * 1.1) + ',' + (G.cy + q * 0.05) + 'L' + (G.cx - q * 0.3) + ',' + (G.cy + q * 0.8) + 'L' + (G.cx + q * 1.1) + ',' + (G.cy - q * 0.75) : '');
        }
        if (p.text) setText(v.text, evalB(p.text, fr.env0, '', p.id + '.text'));
        pulseFill(v, f.pulse, tn, fr);
      };
    },
    gauge: function (v, g, r, p) {
      var f = frameBox(g, r);
      makeLabel(v, g);
      var track = s('path', { fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'round' }, g);
      track.style.stroke = 'var(--line-strong)';
      v.zones = s('g', null, g);
      v.val = s('path', { d: '', fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'round' }, g);
      v.needle = s('line', { 'class': 'hair' }, g);
      v.needle.style.strokeWidth = '2';
      var hub = s('circle', { r: 4 }, g);
      hub.style.fill = 'var(--ink-2)';
      v.text = T_(g, 'p-big', 'value');
      v.texts.push(v.text);
      function arc(G, a0, a1, rr) {
        var p0 = [G.cx + rr * Math.cos(a0), G.cy + rr * Math.sin(a0)];
        var p1 = [G.cx + rr * Math.cos(a1), G.cy + rr * Math.sin(a1)];
        return 'M' + p0[0].toFixed(2) + ',' + p0[1].toFixed(2) + ' A' + rr + ',' + rr + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) + ' 1 ' + p1[0].toFixed(2) + ',' + p1[1].toFixed(2);
      }
      v.layout = function () {
        layoutLabel(v);
        var c = content(v);
        var textH = U('value') * 1.3;
        var wide = c.w > c.h * 2.6;
        var rad, G;
        if (wide) {
          rad = Math.max(10, Math.min(c.w * 0.3, c.h - 12));
          G = { cx: c.x + 8 + rad, cy: c.y + 4 + rad, rad: rad };
          place(v.text, G.cx + rad + 18, c.y + c.h / 2 + 2, c.x + c.w - (G.cx + rad + 18), 'start');
        } else {
          rad = Math.max(10, Math.min(c.w / 2 - 8, c.h - textH - 10));
          G = { cx: r.x + r.w / 2, cy: c.y + rad + 6, rad: rad };
          place(v.text, G.cx, Math.min(c.bottom - U('value') * 0.6, G.cy + 8 + U('value') * 0.75), r.w - 16, 'middle');
        }
        v.geo = G;
        track.setAttribute('d', arc(G, Math.PI, 2 * Math.PI, rad));
        hub.setAttribute('cx', G.cx); hub.setAttribute('cy', G.cy);
        v.zonesKey = null;
      };
      v.update = function (fr) {
        var G = v.geo;
        var lo = num(evalB(p.min, fr.env0, 0, p.id + '.min'), 0);
        var hi = num(evalB(p.max, fr.env0, 1, p.id + '.max'), 1);
        if (!(hi > lo)) hi = lo + 1;
        var a = num(evalB(p.value, fr.env0, lo, p.id + '.value'), lo);
        var b = num(evalB(p.value, fr.env1, a, p.id + '.value'), a);
        var u = clamp((lerp(a, b, fr.f) - lo) / (hi - lo), 0, 1);
        var ang = Math.PI + u * Math.PI;
        setAttr(v.val, 'd', u > 0.002 ? arc(G, Math.PI, ang, G.rad) : '');
        var tn = evalB(p.tone, fr.env0, null, p.id + '.tone') || 'accent';
        v.val.style.stroke = tn === 'bad' || tn === 'ink' ? 'var(--ink)' : 'var(--ink-2)';
        setAttr(v.needle, 'x1', G.cx.toFixed(2)); setAttr(v.needle, 'y1', G.cy.toFixed(2));
        setAttr(v.needle, 'x2', (G.cx + (G.rad - 2) * Math.cos(ang)).toFixed(2));
        setAttr(v.needle, 'y2', (G.cy + (G.rad - 2) * Math.sin(ang)).toFixed(2));
        var zk = lo + ':' + hi + ':' + G.rad;
        if (v.zonesKey !== zk) {
          v.zonesKey = zk;
          v.zones.textContent = '';
          (p.zones || []).forEach(function (z) {
            var z0 = Math.PI + clamp((z.from - lo) / (hi - lo), 0, 1) * Math.PI;
            var z1 = Math.PI + clamp((z.to - lo) / (hi - lo), 0, 1) * Math.PI;
            var zp = s('path', { d: arc(G, z0, z1, G.rad + 8), fill: 'none', 'stroke-width': z.tone === 'bad' ? 3 : 2 }, v.zones);
            zp.style.stroke = z.tone === 'bad' ? 'var(--ink)' : z.tone === 'warn' ? 'var(--ink-2)' : 'var(--line-strong)';
            if (z.tone === 'warn') zp.style.strokeDasharray = '3 2';
          });
        }
        setText(v.text, fmt(a, p.format) + (p.unit ? ' ' + p.unit : ''));
        pulseFill(v, f.pulse, tn, fr);
      };
    },
    node: function (v, g, r, p) {
      var f = frameBox(g, r);
      makeLabel(v, g);
      v.pills = p.states.map(function (st) {
        var pg = s('g', null, g);
        var rect = s('rect', null, pg);
        rect.style.strokeWidth = '1.5';
        rect.style.vectorEffect = 'non-scaling-stroke';
        var t = T_(pg, 'p-value', 'value');
        setText(t, st.label || st.id);
        v.texts.push(t);
        return { st: st, rect: rect, t: t };
      });
      v.layout = function () {
        layoutLabel(v);
        var c = content(v);
        var n = v.pills.length;
        var ph0 = U('value') * 1.75;
        var longest = v.pills.reduce(function (a, pl) { return Math.max(a, (pl.st.label || pl.st.id).length); }, 0);
        var need = longest * U('value') * 0.56 + 16;
        var vertical = c.h >= n * (ph0 * 0.8 + 4) && (c.w / n - 6 < need || c.w / n < 96);
        // too narrow for a row and too short for a column: show only the active state
        v.single = !vertical && c.w / n - 6 < need * 0.8;
        v.pills.forEach(function (pl, i) {
          var pw, ph, px, py;
          if (v.single) { pw = Math.min(c.w, need + 24); ph = Math.min(ph0 + 8, c.h); px = c.x + (c.w - pw) / 2; py = c.y + (c.h - ph) / 2; }
          else if (vertical) { ph = Math.min(ph0 + 6, c.h / n - 4); pw = Math.min(c.w, Math.max(need + 20, c.w * 0.7)); px = c.x + (c.w - pw) / 2; py = c.y + i * (c.h / n) + (c.h / n - ph) / 2; } else { pw = c.w / n - 6; ph = Math.min(ph0 + 8, c.h); px = c.x + i * (c.w / n) + 3; py = c.y + (c.h - ph) / 2; }
          pl.rect.setAttribute('x', px.toFixed(2)); pl.rect.setAttribute('y', py.toFixed(2));
          pl.rect.setAttribute('width', pw.toFixed(2)); pl.rect.setAttribute('height', ph.toFixed(2));
          pl.rect.setAttribute('rx', (ph / 2).toFixed(2));
          place(pl.t, px + pw / 2, py + ph / 2 + 0.5, pw - 10, 'middle');
        });
      };
      v.update = function (fr) {
        var cur = evalB(p.state, fr.env0, null, p.id + '.state');
        v.pills.forEach(function (pl) {
          var on = pl.st.id === cur;
          pl.rect.parentNode.style.display = v.single && !on ? 'none' : '';
          var lv = on ? (pl.st.tone === 'muted' || pl.st.tone === 'info' ? 1 : pl.st.tone === 'warn' ? 2 : pl.st.tone === 'soft' ? 0 : 3) : -1;
          pl.rect.style.fill = lv === 3 ? 'var(--ink)' : lv === 1 ? 'var(--surface-2)' : 'transparent';
          pl.rect.style.stroke = lv === 3 || lv === 2 ? 'var(--ink)' : 'var(--line-strong)';
          pl.rect.style.strokeWidth = lv === 2 ? '2' : '1.5';
          pl.rect.style.strokeDasharray = lv === 0 ? '3 2' : '';
          pl.rect.parentNode.setAttribute('data-level', String(lv));
          pl.t.el.style.fill = lv === 3 ? 'var(--bg)' : lv === 2 ? 'var(--ink)' : lv === 1 ? 'var(--ink-2)' : 'var(--muted)';
          pl.t.el.style.fontWeight = on ? '700' : '500';
        });
        pulseFill(v, f.pulse, 'accent', fr);
      };
    },
    queue: function (v, g, r, p) { listMaker(v, g, r, p, false); },
    stack: function (v, g, r, p) { listMaker(v, g, r, p, true); },
    grid: function (v, g, r, p) {
      var f = frameBox(g, r);
      makeLabel(v, g);
      v.cellsG = s('g', null, g);
      v.cells = [];
      v.n = -1;
      v.layoutCells = function (n) {
        var A = v.area;
        var cols = p.cols || Math.max(1, Math.ceil(Math.sqrt(n * A.w / Math.max(1, A.h))));
        var rows = Math.max(1, Math.ceil(n / cols));
        var size = Math.min(A.w / cols, A.h / rows);
        var ox = A.x + (A.w - size * cols) / 2;
        var oy = A.y + (A.h - size * rows) / 2;
        while (v.cells.length < n) {
          var cg = s('g', null, v.cellsG);
          var rect = s('rect', { rx: 3 }, cg);
          rect.style.vectorEffect = 'non-scaling-stroke';
          var t = T_(cg, 'p-small', 'small');
          v.cells.push({ g: cg, rect: rect, t: t });
        }
        v.cells.forEach(function (c, i) {
          c.g.style.display = i < n ? '' : 'none';
          if (i >= n) return;
          var cx = ox + (i % cols) * size;
          var cy = oy + Math.floor(i / cols) * size;
          var pad = Math.max(1.5, size * 0.08);
          c.rect.setAttribute('x', (cx + pad).toFixed(2));
          c.rect.setAttribute('y', (cy + pad).toFixed(2));
          c.rect.setAttribute('width', (size - 2 * pad).toFixed(2));
          c.rect.setAttribute('height', (size - 2 * pad).toFixed(2));
          place(c.t, cx + size / 2, cy + size / 2 + 0.5, size - 2 * pad - 3, 'middle');
          c.t.base = Math.min(13, size * 0.42);
          c.size = size;
          fit(c.t);
        });
        v.n = n;
      };
      v.layout = function () {
        layoutLabel(v);
        var c = content(v);
        v.area = { x: c.x, y: c.y + 2, w: c.w, h: c.h - 2 };
        if (v.n >= 0) v.layoutCells(v.n);
      };
      v.update = function (fr) {
        var cells = evalB(p.cells, fr.env0, [], p.id + '.cells');
        if (!Array.isArray(cells)) cells = [];
        if (cells.length !== v.n) v.layoutCells(cells.length);
        var markV = evalB(p.mark, fr.env0, null, p.id + '.mark');
        var marked = {};
        if (typeof markV === 'number') marked[markV] = 1;
        else if (Array.isArray(markV)) markV.forEach(function (x) { marked[x] = 1; });
        cells.forEach(function (val, i) {
          var c = v.cells[i];
          var key = typeof val === 'boolean' ? String(val) : val == null ? 'null' : String(val);
          var tn = p.tones && own(p.tones, key) ? p.tones[key] : null;
          var filled = tn != null || val === true || (typeof val === 'number' && val !== 0) || (typeof val === 'string' && val !== '');
          if (tn == null) tn = 'accent';
          if (filled) paintTone(c.rect, c.t.el, tn, 1.25);
          else { c.rect.style.fill = 'transparent'; c.rect.style.stroke = 'var(--line-strong)'; c.rect.style.strokeWidth = '1'; c.rect.style.strokeDasharray = ''; c.t.el.style.fill = ''; }
          if (marked[i]) { c.rect.style.stroke = 'var(--ink)'; c.rect.style.strokeWidth = '2.5'; c.rect.style.strokeDasharray = ''; }
          var show = p.showValues && val !== null && val !== false && val !== '' && !(typeof val === 'number' && val === 0 && !p.tones) && c.size * scale >= 13;
          setText(c.t, show ? (typeof val === 'boolean' ? '1' : fmt(val)) : '');
        });
        pulseFill(v, f.pulse, 'accent', fr);
      };
      v.extraTexts = function () { return v.cells.slice(0, Math.max(0, v.n)).map(function (c) { return c.t; }); };
    },
    label: function (v, g, r, p) {
      var role = p.size === 's' ? 'small' : p.size === 'l' ? 'big' : 'value';
      v.text = T_(g, p.size === 'l' ? 'p-value' : 'p-small', role);
      if (p.size === 'l') v.text.base = 22;
      v.texts.push(v.text);
      v.layout = function () {
        var anchor = p.align === 'left' ? 'start' : p.align === 'right' ? 'end' : 'middle';
        var x = p.align === 'left' ? r.x + 4 : p.align === 'right' ? r.x + r.w - 4 : r.x + r.w / 2;
        place(v.text, x, r.y + r.h / 2, r.w - 8, anchor);
      };
      v.update = function (fr) {
        setText(v.text, evalB(p.text, fr.env0, '', p.id + '.text'));
        var tn = evalB(p.tone, fr.env0, null, p.id + '.tone');
        v.text.el.style.fill = tn ? tone(tn) : '';
        v.text.el.style.fontWeight = tn === 'bad' ? '700' : '';
      };
    },
    chart: function (v, g, r, p) { chartMaker(v, g, r, p); },
    link: function (v, g, r, p) {
      v.path = s('path', { 'class': 'link-path' }, g);
      v.head = s('path', null, g);
      v.head.style.fill = 'var(--ink-2)';
      if (p.label) {
        v.text = T_(g, 'p-small', 'small');
        v.text.el.style.paintOrder = 'stroke';
        v.text.el.style.stroke = 'var(--surface)';
        v.text.el.style.strokeWidth = '5px';
        setText(v.text, p.label);
        v.texts.push(v.text);
      }
      v.layoutLink = function () {
        var a = viewById[p.from];
        var b = viewById[p.to];
        if (!a || !b || !a.anchor || !b.anchor) return;
        var ra = a.anchor;
        var rb = b.anchor;
        var ca = [ra.x + ra.w / 2, ra.y + ra.h / 2];
        var cb = [rb.x + rb.w / 2, rb.y + rb.h / 2];
        var via = (p.via || []).map(function (q) { return [q[0] * CW, q[1] * CH]; });
        var first = via.length ? via[0] : cb;
        var last = via.length ? via[via.length - 1] : ca;
        var q0 = edgePoint(ra, ca, first, 0);
        var q1 = edgePoint(rb, cb, last, 0);
        var gap = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
        var p0 = edgePoint(ra, ca, first, Math.min(6, gap * 0.2));
        var p1 = edgePoint(rb, cb, last, Math.min(9, gap * 0.3));
        v.g.style.visibility = gap < 10 && !via.length ? 'hidden' : '';
        var pts = [p0].concat(via, [p1]);
        v.pts = pts;
        v.len = 0;
        v.seg = [];
        for (var i = 1; i < pts.length; i++) {
          var L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          v.seg.push(L);
          v.len += L;
        }
        setAttr(v.path, 'd', 'M' + pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' L'));
        var e = pts[pts.length - 1];
        var d0 = pts[pts.length - 2];
        var ang = Math.atan2(e[1] - d0[1], e[0] - d0[0]);
        var hl = 11;
        var hw = 5.5;
        var tip = [e[0] + Math.cos(ang) * 2, e[1] + Math.sin(ang) * 2];
        var bx = tip[0] - Math.cos(ang) * hl;
        var by = tip[1] - Math.sin(ang) * hl;
        setAttr(v.head, 'd', 'M' + tip[0].toFixed(1) + ',' + tip[1].toFixed(1) + ' L' + (bx + Math.sin(ang) * hw).toFixed(1) + ',' + (by - Math.cos(ang) * hw).toFixed(1) +
          ' L' + (bx - Math.sin(ang) * hw).toFixed(1) + ',' + (by + Math.cos(ang) * hw).toFixed(1) + ' Z');
        if (v.text) {
          var mid = v.pointAt(0.5);
          place(v.text, mid[0], mid[1] - U('small') * 0.9, null, 'middle');
          fit(v.text);
        }
      };
      v.pointAt = function (u) {
        var d = clamp(u, 0, 1) * v.len;
        for (var i = 0; i < v.seg.length; i++) {
          if (d <= v.seg[i] || i === v.seg.length - 1) {
            var f = v.seg[i] ? d / v.seg[i] : 0;
            return [lerp(v.pts[i][0], v.pts[i + 1][0], f), lerp(v.pts[i][1], v.pts[i + 1][1], f)];
          }
          d -= v.seg[i];
        }
        return v.pts[0];
      };
      v.update = function (fr) {
        var act = p.active ? evalB(p.active, fr.env0, true, p.id + '.active') !== false : true;
        v.path.classList.toggle('inactive', !act);
      };
    },
  };

  function edgePoint(rc, c, toward, pad) {
    var dx = toward[0] - c[0];
    var dy = toward[1] - c[1];
    if (!dx && !dy) return c.slice();
    var hw = rc.w / 2 + pad;
    var hh = rc.h / 2 + pad;
    var tx = dx ? hw / Math.abs(dx) : Infinity;
    var ty = dy ? hh / Math.abs(dy) : Infinity;
    var t = Math.min(tx, ty);
    return [c[0] + dx * t, c[1] + dy * t];
  }

  function sinceLast(ticks, k) {
    var lo = 0;
    var hi = ticks.length - 1;
    var best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (ticks[mid] <= k) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best < 0 ? Infinity : k - ticks[best];
  }
  function pulseFill(v, el, tn, fr) {
    if (!el || !v.pulseTimes) return;
    var t = lastBefore(v.pulseTimes, fr.t);
    var a = t == null || reduceMotion ? 0 : clamp(1 - (fr.t - t) / (0.4 * baseSpeed), 0, 1);
    el.style.fill = PULSE;
    setAttr(el, 'opacity', (a * 0.95).toFixed(2));
  }
  function lastBefore(times, t) {
    var lo = 0;
    var hi = times.length - 1;
    var best = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (times[mid] <= t + 1e-9) { best = times[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  // queue and stack: chips keyed by value so they slide when items move
  function listMaker(v, g, r, p, vertical) {
    var f = frameBox(g, r);
    makeLabel(v, g);
    var ends = p.spec.ends;
    v.slotsG = s('g', null, g);
    v.chipsG = s('g', null, g);
    v.chips = {};
    if (ends) {
      v.e0 = T_(g, 'p-small', 'small');
      v.e1 = T_(g, 'p-small', 'small');
      setText(v.e0, String(ends[0] || ''));
      setText(v.e1, String(ends[1] || ''));
      v.texts.push(v.e0, v.e1);
    }
    v.more = T_(g, 'p-small', 'small');
    v.texts.push(v.more);
    v.layout = function () {
      layoutLabel(v);
      var c = content(v);
      var endsH = ends ? U('small') * 1.3 + 2 : 0;
      v.area = { x: c.x, y: c.y + 2, w: c.w, h: c.h - 2 - (vertical ? endsH * 2 : endsH) };
      if (vertical && ends) v.area.y += endsH;
      if (ends) {
        if (vertical) {
          place(v.e1, r.x + r.w / 2, c.y + U('small') * 0.65, c.w, 'middle');
          place(v.e0, r.x + r.w / 2, c.bottom - U('small') * 0.6, c.w, 'middle');
        } else {
          place(v.e0, c.x, c.bottom - U('small') * 0.6, c.w / 2 - 4, 'start');
          place(v.e1, c.x + c.w, c.bottom - U('small') * 0.6, c.w / 2 - 4, 'end');
        }
      }
      place(v.more, r.x + r.w - 10, r.y + 6 + U('label') * 0.62, c.w / 2, 'end');
      v.slotCount = -1;
    };
    function geom(n) {
      var A = v.area;
      n = Math.max(1, n);
      var gap = 5;
      if (vertical) {
        var sh = Math.min(30, (A.h - gap * (n - 1)) / n);
        return function (i) { return { x: A.x, y: A.y + A.h - (i + 1) * sh - i * gap, w: A.w, h: sh }; };
      }
      var sw = Math.min(64, (A.w - gap * (n - 1)) / n);
      var shh = Math.min(34, A.h);
      var oy = A.y + (A.h - shh) / 2;
      return function (i) { return { x: A.x + i * (sw + gap), y: oy, w: sw, h: shh }; };
    }
    function keyed(items) {
      var seen = {};
      return items.map(function (it) {
        var base = typeof it === 'string' ? 's:' + it : 'v:' + JSON.stringify(it);
        seen[base] = (seen[base] || 0) + 1;
        return base + '#' + seen[base];
      });
    }
    function chip(k) {
      var c = v.chips[k];
      if (c) return c;
      var cg = s('g', null, v.chipsG);
      var rect = s('rect', { rx: 5 }, cg);
      rect.style.strokeWidth = '1.5';
      rect.style.vectorEffect = 'non-scaling-stroke';
      var t = T_(cg, 'p-value', 'chip');
      return (v.chips[k] = { g: cg, rect: rect, t: t });
    }
    function drawChip(c, q, x, y, tn, label, op) {
      setAttr(c.rect, 'x', (x + 1).toFixed(2)); setAttr(c.rect, 'y', (y + 1).toFixed(2));
      setAttr(c.rect, 'width', Math.max(1, q.w - 2).toFixed(2)); setAttr(c.rect, 'height', Math.max(1, q.h - 2).toFixed(2));
      paintTone(c.rect, c.t.el, tn);
      setAttr(c.t.el, 'x', (x + q.w / 2).toFixed(2)); setAttr(c.t.el, 'y', (y + q.h / 2 + 0.5).toFixed(2));
      var mw = q.w - 6;
      var base = Math.min(14, q.h * 0.5);
      if (c.t.maxW !== mw || c.t.base !== base) { c.t.maxW = mw; c.t.base = base; c.t.str = null; }
      setText(c.t, label);
      setAttr(c.g, 'opacity', op.toFixed(2));
    }
    v.update = function (fr) {
      var a = evalB(p.items, fr.env0, [], p.id + '.items');
      var b = evalB(p.items, fr.env1, a, p.id + '.items');
      if (!Array.isArray(a)) a = [];
      if (!Array.isArray(b)) b = a;
      var n = Math.max(1, Math.round(num(evalB(p.slots, fr.env0, null, p.id + '.slots'), Math.max(a.length, b.length, 1))));
      var A = v.area;
      var minSlot = Math.max(16, U('chip') * 1.4);
      var maxFit = vertical ? Math.max(1, Math.floor((A.h + 5) / Math.max(14, U('chip') * 1.3))) : Math.max(1, Math.floor((A.w + 5) / (minSlot + 5)));
      var shown = Math.min(n, maxFit);
      var G = geom(shown);
      if (v.slotCount !== shown) {
        v.slotsG.textContent = '';
        for (var i = 0; i < shown; i++) {
          var q = G(i);
          var sr = s('rect', { x: q.x, y: q.y, width: q.w, height: q.h, rx: 5 }, v.slotsG);
          sr.style.fill = 'none'; sr.style.stroke = 'var(--line-strong)'; sr.style.strokeDasharray = '3 3'; sr.style.vectorEffect = 'non-scaling-stroke';
        }
        v.slotCount = shown;
      }
      var ka = keyed(a);
      var kb = keyed(b);
      var posA = {}; ka.forEach(function (k, i) { posA[k] = i; });
      var posB = {}; kb.forEach(function (k, i) { posB[k] = i; });
      var live = {};
      var tn = evalB(p.tone, fr.env0, null, p.id + '.tone') || 'accent';
      var ease = fr.f * fr.f * (3 - 2 * fr.f);
      ka.forEach(function (k, i) {
        if (i >= shown) return;
        live[k] = 1;
        var qa = G(i);
        var j = posB[k];
        var qb = j == null ? qa : G(Math.min(j, shown - 1));
        drawChip(chip(k), qa, lerp(qa.x, qb.x, ease), lerp(qa.y, qb.y, ease), tn, p.showValues ? fmt(a[i]) : '', j == null ? 1 - ease : 1);
      });
      kb.forEach(function (k, j) {
        if (posA[k] != null || j >= shown) return;
        live[k] = 1;
        var q = G(j);
        drawChip(chip(k), q, q.x, q.y, tn, p.showValues ? fmt(b[j]) : '', ease * 0.9);
      });
      Object.keys(v.chips).forEach(function (k) {
        if (!live[k]) {
          var c = v.chips[k];
          c.g.parentNode.removeChild(c.g);
          dropText(c.t);
          delete v.chips[k];
        }
      });
      setText(v.more, a.length > shown ? '+' + (a.length - shown) + ' more' : '');
      pulseFill(v, f.pulse, tn, fr);
    };
    v.extraTexts = function () { return Object.keys(v.chips).map(function (k) { return v.chips[k].t; }); };
  }

  function chartMaker(v, g, r, p) {
    frameBox(g, r);
    makeLabel(v, g);
    var axisX = s('line', { 'class': 'chart-axis' }, g);
    var axisY = s('line', { 'class': 'chart-axis' }, g);
    v.yHi = T_(g, 'p-small', 'small');
    v.yLo = T_(g, 'p-small', 'small');
    v.x0 = T_(g, 'p-small', 'small');
    v.x1 = T_(g, 'p-small', 'small');
    v.texts.push(v.yHi, v.yLo, v.x0, v.x1);
    setText(v.x0, '0');
    setText(v.x1, fmt(model.duration) + (model.timeUnit ? ' ' + model.timeUnit : ''));
    v.refsG = s('g', null, g);
    v.refTexts = [];
    // Series are ink lines told apart by dash pattern (solid, 6-3 dash, 2-3
    // dot, ...) and named at the line end, not by colour and a legend.
    var DASH = ['', '6 3', '2 3', '10 3 2 3', '1 4'];
    v.series = p.series.map(function (se, i) {
      var dash = DASH[i % DASH.length];
      var area = i === 0 && p.series.length === 1 ? s('path', { 'class': 'chart-area' }, g) : null;
      var ghost = s('path', { 'class': 'chart-ghost', 'stroke-dasharray': dash || null }, g);
      var line = s('path', { 'class': 'chart-line', 'stroke-dasharray': dash || null, 'data-dash': dash || 'solid' }, g);
      var dot = s('circle', { r: 4 }, g);
      dot.style.fill = 'var(--ink)';
      dot.style.stroke = 'var(--surface)';
      dot.style.strokeWidth = '1.5';
      return { se: se, dash: dash, area: area, ghost: ghost, line: line, dot: dot, vals: [] };
    });
    v.legend = [];
    v.ends = [];
    if (p.series.length > 1) {
      v.series.forEach(function (se) {
        var key = s('line', { 'class': 'chart-line', 'stroke-dasharray': se.dash || null }, g);
        key.style.strokeWidth = '1.5';
        var t = T_(g, 'chart-end', 'small');
        setText(t, se.se.label || '');
        v.ends.push({ t: t, key: key, se: se });
        v.texts.push(t);
      });
    }
    v.endW = v.ends.reduce(function (a, E) { return Math.max(a, (E.t.str || '').length * U('small') * 0.62); }, 0);
    v.playhead = s('line', { 'class': 'playhead' }, g);
    var plot = { x: 0, y: 0, w: 1, h: 1 };
    v.plot = plot;
    v.layout = function () {
      layoutLabel(v);
      var rows = v.legendRow2 ? 2 : 1;
      var top = r.y + 6 + (v.labelText || v.legend.length ? U('label') * 1.25 * rows + 8 : 4);
      var yLabW = U('small') * 3.2;
      plot.x = r.x + 10 + yLabW;
      plot.y = top + U('small') * 0.3;
      var endCol = v.ends.length ? Math.min(v.endW, r.w * 0.32) + 26 : 0;
      plot.w = r.x + r.w - 12 - endCol - plot.x;
      plot.h = r.y + r.h - 6 - U('small') * 1.4 - plot.y;
      axisX.setAttribute('x1', plot.x); axisX.setAttribute('x2', plot.x + plot.w);
      axisX.setAttribute('y1', plot.y + plot.h); axisX.setAttribute('y2', plot.y + plot.h);
      axisY.setAttribute('x1', plot.x); axisY.setAttribute('x2', plot.x);
      axisY.setAttribute('y1', plot.y); axisY.setAttribute('y2', plot.y + plot.h);
      v.playhead.setAttribute('y1', plot.y); v.playhead.setAttribute('y2', plot.y + plot.h);
      place(v.yHi, plot.x - 6, plot.y + U('small') * 0.3, yLabW - 4, 'end');
      place(v.yLo, plot.x - 6, plot.y + plot.h - U('small') * 0.3, yLabW - 4, 'end');
      place(v.x0, plot.x, r.y + r.h - 6 - U('small') * 0.6, plot.w / 3, 'start');
      place(v.x1, plot.x + plot.w, r.y + r.h - 6 - U('small') * 0.6, plot.w / 3, 'end');
      v.ends.forEach(function (E) { place(E.t, plot.x + plot.w + 24, plot.y + plot.h / 2, Math.min(v.endW, r.w * 0.32) + 2, 'start'); });
      if (trace) v.redrawStatic();
    };
    // End labels sit at the height where each line ends, pushed apart so they never overlap.
    function placeEnds() {
      if (!v.ends.length || !trace) return;
      var gap = U('small') * 1.3;
      var lo = plot.y + U('small') * 0.55;
      var hi = plot.y + plot.h - U('small') * 0.55;
      var items = v.ends.map(function (E) {
        var vals = E.se.vals;
        var last = NaN;
        for (var k = vals.length - 1; k >= 0 && !isFinite(last); k--) last = vals[k];
        return { E: E, y: isFinite(last) ? clamp(yOf(last), lo, hi) : hi };
      });
      items.sort(function (a, b) { return a.y - b.y; });
      for (var i = 1; i < items.length; i++) items[i].y = Math.max(items[i].y, items[i - 1].y + gap);
      if (items.length && items[items.length - 1].y > hi) {
        items[items.length - 1].y = hi;
        for (var j = items.length - 2; j >= 0; j--) items[j].y = Math.min(items[j].y, items[j + 1].y - gap);
      }
      items.forEach(function (it) {
        var x0 = plot.x + plot.w + 6;
        it.E.t.el.setAttribute('x', (x0 + 18).toFixed(1));
        it.E.t.el.setAttribute('y', it.y.toFixed(1));
        setAttr(it.E.key, 'x1', x0.toFixed(1)); setAttr(it.E.key, 'x2', (x0 + 13).toFixed(1));
        setAttr(it.E.key, 'y1', it.y.toFixed(1)); setAttr(it.E.key, 'y2', it.y.toFixed(1));
      });
    }
    v.afterFit = function () {
      // size the end-label column to the longest label, then lay out once more
      if (!v.ends.length) return;
      var w = v.ends.reduce(function (a, E) { return Math.max(a, safeLen(E.t)); }, 0);
      if (w && Math.abs(w - v.endW) > 1) {
        v.endW = w;
        v.layout();
        v.texts.forEach(fit);
      }
      placeEnds();
    };
    function safeLen(t) { try { return t.el.getComputedTextLength(); } catch (e) { return 0; } }
    function niceCeil(x) {
      if (x <= 0) return x;
      var mag = Math.pow(10, Math.floor(Math.log10(x)));
      var steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
      for (var i = 0; i < steps.length; i++) if (steps[i] * mag >= x - 1e-9) return steps[i] * mag;
      return 10 * mag;
    }
    function niceRound(x) { var a = Math.abs(x); if (a >= 100) return Math.round(x); if (a >= 10) return Math.round(x * 10) / 10; return Math.round(x * 100) / 100; }
    function xOf(k) { return plot.x + (k / Math.max(1, trace.K)) * plot.w; }
    function yOf(val) { return plot.y + plot.h - ((val - v.lo) / (v.hi - v.lo)) * plot.h; }
    function pathFor(vals, upto, step) {
      var d = '';
      var pen = false;
      var stride = v.stride || 1;
      var prevY = null;
      for (var k = 0; k <= upto; k += stride) {
        if (k + stride > upto && k !== upto) { /* make sure the last point is drawn */ }
        var val = vals[k];
        if (!isFinite(val)) { pen = false; continue; }
        var x = xOf(k).toFixed(1);
        var y = clamp(yOf(val), plot.y - 2, plot.y + plot.h + 2).toFixed(1);
        if (!pen) { d += 'M' + x + ',' + y; pen = true; } else if (step && prevY != null) d += ' L' + x + ',' + prevY + ' L' + x + ',' + y; else d += ' L' + x + ',' + y;
        prevY = y;
      }
      if (upto % stride !== 0 && isFinite(vals[upto]) && pen) {
        var xe = xOf(upto).toFixed(1);
        var ye = clamp(yOf(vals[upto]), plot.y - 2, plot.y + plot.h + 2).toFixed(1);
        d += step ? ' L' + xe + ',' + prevY + ' L' + xe + ',' + ye : ' L' + xe + ',' + ye;
      }
      return d;
    }
    v.redrawStatic = function () {
      v.refsG.textContent = '';
      v.refTexts.forEach(dropText);
      v.refTexts = [];
      (p.refs || []).forEach(function (rf, i) {
        var yv = v.refVals[i];
        if (!isFinite(yv)) return;
        var y = yOf(yv);
        if (y < plot.y - 1 || y > plot.y + plot.h + 1) return;
        var ln = s('line', { x1: plot.x, x2: plot.x + plot.w, y1: y, y2: y, 'class': 'chart-ref' }, v.refsG);
        ln.style.stroke = tone(rf.tone, 'muted');
        if (rf.label) {
          var t = T_(v.refsG, 'p-small', 'small');
          var below = y - plot.y < U('small') * 1.4;
          place(t, plot.x + plot.w - 6, below ? y + U('small') * 0.85 : y - U('small') * 0.75, plot.w / 2, 'end');
          t.el.style.fill = tone(rf.tone, 'muted');
          t.el.style.paintOrder = 'stroke'; t.el.style.stroke = 'var(--surface)'; t.el.style.strokeWidth = '4px';
          setText(t, rf.label);
          v.refTexts.push(t);
        }
      });
      v.series.forEach(function (se) { setAttr(se.ghost, 'd', pathFor(se.vals, trace.K, p.step)); });
      placeEnds();
    };
    v.recompute = function () {
      var K = trace.K;
      v.stride = Math.max(1, Math.floor(K / 600));
      var lo = Infinity;
      var hi = -Infinity;
      v.series.forEach(function (se) {
        se.vals = [];
        for (var k = 0; k <= K; k++) {
          var val = num(evalB(se.se.fn, WM.snapshotEnv(trace, k), NaN, p.id + '.series'), NaN);
          se.vals.push(val);
          if (val < lo) lo = val;
          if (val > hi) hi = val;
        }
      });
      var env0 = WM.snapshotEnv(trace, 0);
      v.refVals = (p.refs || []).map(function (rf) { return num(evalB(rf.fn, env0, NaN, p.id + '.refs'), NaN); });
      if (p.y) {
        var y0 = num(evalB(p.y[0], env0, lo, p.id + '.y'), lo);
        var y1 = num(evalB(p.y[1], env0, hi, p.id + '.y'), hi);
        lo = y0;
        hi = y1 > y0 ? y1 : y0 + 1;
      } else {
        v.refVals.forEach(function (x) { if (isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; } });
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        if (lo > 0 && lo < hi * 0.35) lo = 0;
        var pad = (hi - lo) * 0.06 || 1;
        hi = niceCeil(hi + pad);
        if (lo !== 0) lo -= pad;
      }
      v.lo = lo; v.hi = hi;
      setText(v.yHi, fmt(niceRound(hi)));
      setText(v.yLo, fmt(niceRound(lo)));
      v.redrawStatic();
    };
    v.update = function (fr) {
      if (!trace) return;
      var k = fr.k;
      var px = plot.x + (fr.t / model.duration) * plot.w;
      setAttr(v.playhead, 'x1', px.toFixed(1)); setAttr(v.playhead, 'x2', px.toFixed(1));
      v.series.forEach(function (se) {
        var d = pathFor(se.vals, k, p.step);
        var a = se.vals[k];
        var b = se.vals[Math.min(k + 1, trace.K)];
        var cur = isFinite(a) && isFinite(b) ? (p.step ? a : lerp(a, b, fr.f)) : a;
        if (isFinite(cur) && d) {
          var cy = clamp(yOf(cur), plot.y - 2, plot.y + plot.h + 2);
          d += ' L' + px.toFixed(1) + ',' + cy.toFixed(1);
          setAttr(se.dot, 'cx', px.toFixed(1)); setAttr(se.dot, 'cy', cy.toFixed(1)); setAttr(se.dot, 'opacity', 1);
        } else setAttr(se.dot, 'opacity', 0);
        setAttr(se.line, 'd', d);
        if (se.area) setAttr(se.area, 'd', d ? d + ' L' + px.toFixed(1) + ',' + (plot.y + plot.h).toFixed(1) + ' L' + plot.x.toFixed(1) + ',' + (plot.y + plot.h).toFixed(1) + ' Z' : '');
      });
    };
    v.extraTexts = function () { return v.refTexts.slice(); };
  }

  // build views: groups behind, then links, then parts
  model.parts.forEach(function (part) {
    var v = makeView(part);
    views.push(v);
    viewById[part.id] = v;
    (part.type === 'group' ? layerGroups : part.type === 'link' ? layerLinks : layerParts).appendChild(v.g);
  });

  // ------------------------------------------------------------ particles --
  var particlePool = [];
  var particleUsed = 0;
  function particle() {
    if (particleUsed < particlePool.length) return particlePool[particleUsed++];
    var g = s('g', null, layerParticles);
    var core = s('circle', { r: 5.2 }, g);
    core.style.vectorEffect = 'non-scaling-stroke';
    var pt = { g: g, core: core, kind: null };
    particlePool.push(pt);
    particleUsed++;
    return pt;
  }
  function linkTravel(v) { return v.part.travel || 0.7 * baseSpeed; }
  function linkDelay(v, depth) {
    var a = v.part.spec.after;
    if (!a || depth > 5 || !viewById[a]) return 0;
    var u = viewById[a];
    return linkTravel(u) + linkDelay(u, depth + 1);
  }
  function recomputeParticles() {
    views.forEach(function (v) {
      if (v.part.type !== 'link' || !v.part.on.length) return;
      var names = Object.create(null);
      v.part.on.forEach(function (n) { names[n] = 1; });
      var travel = linkTravel(v);
      var delay = linkDelay(v, 0);
      var list = [];
      for (var k = 0; k <= trace.K; k++) {
        var ems = trace.emits[k];
        var fired = trace.fired[k];
        var hits = [];
        for (var i = 0; i < ems.length; i++) if (names[ems[i].name]) hits.push(ems[i].name);
        for (var j = 0; j < fired.length; j++) if (names[fired[j].name]) for (var c = 0; c < Math.min(fired[j].count, 60); c++) hits.push(fired[j].name);
        var n = hits.length;
        var spread = n > 1 ? Math.min(travel * 0.9, model.dt * 0.95 + travel * 0.6) : 0;
        for (var q = 0; q < n; q++) list.push({ t0: k * model.dt + delay + (n > 1 ? spread * q / (n - 1) : 0), name: hits[q] });
      }
      list.sort(function (a, b) { return a.t0 - b.t0; });
      v.particles = list;
      v.travel = travel;
    });
  }
  function drawParticles(t) {
    particleUsed = 0;
    views.forEach(function (v) {
      if (!v.particles || !v.len) return;
      var list = v.particles;
      var lo = 0;
      var hi = list.length;
      var tmin = t - v.travel;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (list[mid].t0 <= tmin) lo = mid + 1; else hi = mid; }
      var drawn = 0;
      for (var i = lo; i < list.length && drawn < 48; i++) {
        var pp = list[i];
        if (pp.t0 > t) break;
        var u = (t - pp.t0) / v.travel;
        if (u < 0 || u > 1) continue;
        var e = u * u * (3 - 2 * u);
        var pt = particle();
        var tm = v.part.toneMap;
        var tn = tm && own(tm, pp.name) ? tm[pp.name] : (typeof v.part.spec.tone === 'string' ? v.part.spec.tone : 'accent');
        var kind = tn === 'bad' ? 'rejected' : 'accepted';
        var pos = reduceMotion ? v.pointAt(0.5) : v.pointAt(e);
        pt.g.style.display = '';
        if (pt.kind !== kind) {
          pt.kind = kind;
          pt.g.setAttribute('data-kind', kind);
          if (kind === 'rejected') { pt.core.style.fill = 'var(--surface)'; pt.core.style.stroke = 'var(--ink)'; pt.core.style.strokeWidth = '1.75'; setAttr(pt.core, 'r', 4.6); }
          else { pt.core.style.fill = 'var(--ink)'; pt.core.style.stroke = 'var(--surface)'; pt.core.style.strokeWidth = '1.5'; setAttr(pt.core, 'r', 5.2); }
        }
        setAttr(pt.core, 'cx', pos[0].toFixed(1)); setAttr(pt.core, 'cy', pos[1].toFixed(1));
        var fade = u > 0.85 ? (1 - u) / 0.15 : 1;
        setAttr(pt.g, 'opacity', fade.toFixed(2));
        drawn++;
      }
    });
    for (var j = particleUsed; j < particlePool.length; j++) particlePool[j].g.style.display = 'none';
  }

  // pulses: times when a part's pulse signals happened
  function recomputePulses() {
    views.forEach(function (v) {
      var names = v.part.pulse;
      if (!names || !names.length) { v.pulseTimes = null; return; }
      var set = Object.create(null);
      names.forEach(function (n) { set[n] = 1; });
      var times = [];
      for (var k = 0; k <= trace.K; k++) {
        var hit = false;
        var ems = trace.emits[k];
        for (var i = 0; i < ems.length && !hit; i++) if (set[ems[i].name]) hit = true;
        var fired = trace.fired[k];
        for (var j = 0; j < fired.length && !hit; j++) if (set[fired[j].name]) hit = true;
        if (hit) times.push(k * model.dt);
      }
      v.pulseTimes = times;
    });
  }

  function recomputeMarks() {
    marks.textContent = '';
    var K = Math.max(1, trace.K);
    var runs = [];
    for (var k = 0; k <= trace.K; k++) {
      if (!trace.fired[k].length) continue;
      var x = k / K;
      var last = runs[runs.length - 1];
      if (last && x - last[1] <= 0.031) last[1] = x; else runs.push([x, x]);
    }
    runs.slice(0, 120).forEach(function (rn) {
      var i = h('i', rn[1] - rn[0] > 0.004 ? 'band' : null, null, marks);
      i.style.left = (rn[0] * 100) + '%';
      if (rn[1] - rn[0] > 0.004) i.style.width = ((rn[1] - rn[0]) * 100) + '%';
    });
    model.narration.forEach(function (n) {
      if (n.from <= 0) return;
      var i = h('i', 'cap', null, marks);
      i.style.left = (n.from / model.duration * 100) + '%';
    });
  }

  // --------------------------------------------------------------- engine --
  var recomputePending = false;
  function scheduleRecompute() {
    if (recomputePending) return;
    recomputePending = true;
    requestAnimationFrame(function () { recomputePending = false; recompute(); render(); });
  }
  function recompute() {
    check = WM.checkClaims(model, params);
    trace = check.trace;
    if (trace.error) {
      bindingErrors.push('simulation: ' + trace.error.code + ' ' + trace.error.message);
    }
    summaryEl.textContent = model.summary ? safeText(model.summary, paramEnv()) : '';
    views.forEach(function (v) { if (v.recompute) v.recompute(); });
    recomputeParticles();
    recomputePulses();
    recomputeMarks();
    updateClaims();
    recomputedSinceCaption = true;
  }
  var recomputedSinceCaption = true;
  function paramEnv() { return WM.snapshotEnv({ model: model, params: check ? check.params : params, snaps: [Object.create(null)] }, 0); }
  function safeText(fn, env) { try { return fn(env); } catch (e) { return ''; } }

  // -------------------------------------------------------------- render --
  var lastCaption = null;
  function render() {
    if (!trace) return;
    var K = trace.K;
    var t = clamp(T, 0, model.duration);
    var x = t / model.dt;
    var k = Math.min(K, Math.floor(x + 1e-9));
    var f = k >= K ? 0 : clamp(x - k, 0, 1);
    var fr = { t: t, k: k, f: f, env0: WM.snapshotEnv(trace, k), env1: WM.snapshotEnv(trace, Math.min(K, k + 1)) };
    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      var vis = v.part.visible ? evalB(v.part.visible, fr.env0, true, v.part.id + '.visible') !== false : true;
      v.g.style.display = vis ? '' : 'none';
      if (!vis) continue;
      if (v.update) v.update(fr);
      if (v.hl) v.hl.classList.toggle('on', v.part.highlight ? evalB(v.part.highlight, fr.env0, false, v.part.id + '.highlight') === true : false);
    }
    drawParticles(t);
    // caption
    var cap = null;
    for (var j = 0; j < model.narration.length; j++) {
      var n = model.narration[j];
      if (t >= n.from - 1e-9 && (t < n.to - 1e-9 || (j === model.narration.length - 1 && t <= n.to + 1e-9))) cap = n;
    }
    if (cap) {
      capText.textContent = safeText(cap.text, fr.env0);
      capTime.textContent = fmtSpan(cap.from, cap.to);
      if (cap !== lastCaption || recomputedSinceCaption) {
        capCites.textContent = '';
        var failing = false;
        cap.cites.forEach(function (id) {
          var r = resultOf(id);
          var idx = model.claims.findIndex(function (c) { return c.id === id; });
          var b = press(h('button', 'wm-cite', null, capCites), 0.94);
          b.type = 'button';
          b.setAttribute('data-status', r && r.pass ? 'pass' : 'fail');
          b.appendChild(icon(r && r.pass ? 'check' : 'cross'));
          b.appendChild(document.createTextNode('C' + (idx + 1)));
          b.title = r ? r.text : id;
          b.setAttribute('aria-label', 'Claim ' + (idx + 1) + (r && r.pass ? ' passes' : ' fails') + ': ' + (r ? r.text : id));
          b.addEventListener('click', function () { focusClaim(id); });
          if (r && !r.pass) failing = true;
        });
        caption.classList.toggle('failing', failing);
        capNote.hidden = !failing;
        capNote.textContent = failing ? 'This caption relies on a claim that fails at these settings.' : '';
        lastCaption = cap;
        recomputedSinceCaption = false;
      }
    } else {
      capText.textContent = '';
      capTime.textContent = '';
      capCites.textContent = '';
    }
    scrub.value = String(t);
    drawThumb();
    // the clock names the tick whose values are on screen; rounding t itself
    // showed "t = 5 s" beside the values of t = 4 when dt is 1
    clock.textContent = fmtTime(k * model.dt);
    bPlay.innerHTML = '';
    bPlay.appendChild(icon(playing ? 'pause' : 'play'));
    bPlay.appendChild(document.createTextNode(playing ? 'Pause' : (t >= model.duration - 1e-9 ? 'Replay' : 'Play')));
    bPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function focusClaim(id) {
    var cv = claimViews.find(function (c) { return c.c.id === id; });
    if (!cv) return;
    cv.li.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    cv.li.classList.add('focus');
    setTimeout(function () { cv.li.classList.remove('focus'); }, 1200);
  }

  // ------------------------------------------------------------- control --
  function setTime(t) { T = clamp(t, 0, model.duration); render(); }
  function play() {
    if (T >= model.duration - 1e-9) T = 0;
    playing = true;
    lastNow = 0;
    requestAnimationFrame(loop);
    render();
  }
  function pause() { playing = false; render(); }
  function loop(now) {
    if (!playing) return;
    if (lastNow) {
      var dtr = Math.min(0.1, (now - lastNow) / 1000);
      T += dtr * baseSpeed * speedMul;
      if (T >= model.duration) { T = model.duration; playing = false; }
    }
    lastNow = now;
    render();
    if (playing) requestAnimationFrame(loop);
  }
  function step(n) { pause(); setTime(Math.round(T / model.dt + n) * model.dt); }
  function resetParams() {
    params = Object.assign({}, defaults);
    paramViews.forEach(updateParamView);
    recompute();
    render();
  }
  function setParam(id, value) {
    var pv = paramViews.find(function (q) { return q.p.id === id; });
    if (!pv) throw new Error('unknown param ' + id);
    params[id] = Number(value);
    updateParamView(pv);
    recompute();
    render();
  }

  bPlay.addEventListener('click', function () { if (playing) pause(); else play(); });
  bBack.addEventListener('click', function () { step(-1); });
  bFwd.addEventListener('click', function () { step(1); });
  // keyboard and assistive tech drive the native input; the pointer drives the drawn thumb
  scrub.addEventListener('input', function () { playing = false; T = Number(scrub.value); render(); });

  // ------------------------------------------------------------ scrubber --
  // Pointer capture, the grab offset kept, 1:1 tracking. Past either end the
  // thumb rubber-bands (Fluid.rubber); on release it springs back inside the
  // track (damping 1, response 0.4) carrying the release velocity. No momentum
  // projection: a timeline needs precision.
  var scrubOver = 0;
  var thumbScale = 1;
  var overSp = Fluid.spring({ value: 0, response: 0.4, damping: 1, onUpdate: function (x) { scrubOver = x; drawThumb(); } });
  var thumbSp = Fluid.spring({ value: 1, response: 0.18, damping: 1, onUpdate: function (x) { thumbScale = x; drawThumb(); } });
  var scrubVel = Fluid.velocityTracker();
  var drag = null;
  function drawThumb() {
    var w = track.clientWidth || 0;
    var f = clamp(T / model.duration, 0, 1);
    trackFill.style.transform = 'scaleX(' + f.toFixed(4) + ')';
    thumb.style.transform = 'translateX(' + (f * w + scrubOver).toFixed(2) + 'px)' + (thumbScale !== 1 ? ' scale(' + thumbScale.toFixed(4) + ')' : '');
  }
  function dragTo(x) {
    var r = track.getBoundingClientRect();
    var w = Math.max(1, r.width);
    var raw = x - drag.grab - r.left;
    var over = raw < 0 ? Fluid.rubber(raw, w) : raw > w ? Fluid.rubber(raw - w, w) : 0;
    scrubVel.add(over);
    overSp.set(over);
    setTime(clamp(raw / w, 0, 1) * model.duration);
  }
  function endDrag() {
    if (!drag) return;
    drag = null;
    scrubWrap.removeAttribute('data-pressed');
    thumbSp.to(1, { response: 0.3, damping: 0.8 });
    overSp.to(0, { velocity: scrubVel.get() });
  }
  scrubWrap.addEventListener('pointerdown', function (e) {
    if (e.button > 0) return;
    e.preventDefault();
    var r = track.getBoundingClientRect();
    var thumbX = r.left + clamp(T / model.duration, 0, 1) * r.width;
    // grabbing the thumb keeps the finger's offset from its centre; pressing the bare track brings the thumb under the pointer
    drag = { id: e.pointerId, grab: Math.abs(e.clientX - thumbX) <= 14 ? e.clientX - thumbX : 0 };
    try { scrubWrap.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic event has no capture */ }
    scrubWrap.setAttribute('data-pressed', '');
    if (playing) pause();
    scrubVel.reset();
    overSp.stop();
    if (!Fluid.reduce()) thumbSp.to(1.18, { response: 0.18, damping: 1 });
    dragTo(e.clientX);
  });
  scrubWrap.addEventListener('pointermove', function (e) { if (drag && e.pointerId === drag.id) dragTo(e.clientX); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (n) { scrubWrap.addEventListener(n, function (e) { if (drag && e.pointerId === drag.id) endDrag(); }); });
  document.addEventListener('keydown', function (e) {
    var tg = e.target;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // sliders and text fields keep their own keys; buttons keep Space and Enter
    if (tg && tg.closest && tg.closest('input, select, textarea, [contenteditable="true"]')) return;
    var onButton = tg && tg.closest && tg.closest('button, a');
    if (e.key === ' ' || e.code === 'Space') { if (onButton) return; e.preventDefault(); if (playing) pause(); else play(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
    else if (e.key === 'Home') { e.preventDefault(); pause(); setTime(0); }
    else if (e.key === 'End') { e.preventDefault(); pause(); setTime(model.duration); }
  });
  if (window.ResizeObserver) new ResizeObserver(function () { applyScale(); render(); }).observe(svg);
  window.addEventListener('resize', function () { applyScale(); render(); });

  // ------------------------------------------------------- layout report --
  function rectIn(a, b, tol) { return a.left >= b.left - tol && a.right <= b.right + tol && a.top >= b.top - tol && a.bottom <= b.bottom + tol; }
  function layoutReport() {
    applyScale();
    var issues = [];
    var add = function (code, msg, part) { issues.push({ code: code, message: msg, part: part || null }); };
    var sv = svg.getBoundingClientRect();
    var solid = [];
    views.forEach(function (v) {
      if (v.g.style.display === 'none') return;
      if (v.part.type === 'link') {
        var lb = v.path.getBoundingClientRect();
        if (lb.width + lb.height > 0 && !rectIn(lb, sv, 2)) add('E_OUT_OF_VIEW', 'link "' + v.part.id + '" leaves the diagram', v.part.id);
        // an arrow drawn across another part hides it and reads as a wrong connection
        if (v.len) {
          var crossed = null;
          views.forEach(function (o) {
            if (crossed || o === v || o.part.type === 'link' || o.part.type === 'group' || !o.anchor) return;
            if (o.part.id === v.part.from || o.part.id === v.part.to || o.g.style.display === 'none') return;
            var a = o.anchor;
            for (var u = 0.1; u <= 0.9001; u += 0.05) {
              var q = v.pointAt(u);
              if (q[0] > a.x + 3 && q[0] < a.x + a.w - 3 && q[1] > a.y + 3 && q[1] < a.y + a.h - 3) { crossed = o.part.id; return; }
            }
          });
          if (crossed) add('W_LINK_CROSSES', 'link "' + v.part.id + '" is drawn across part "' + crossed + '"; move a part or add "via" points', v.part.id);
        }
        return;
      }
      var b = v.bounds.getBoundingClientRect();
      if (!rectIn(b, sv, 1.5)) add('E_OUT_OF_VIEW', 'part "' + v.part.id + '" is outside the diagram', v.part.id);
      if (v.part.type !== 'group') solid.push({ id: v.part.id, b: b });
      var all = v.texts.slice();
      if (v.pills) v.pills.forEach(function (pl) {
        if (pl.rect.parentNode.style.display === 'none') return;
        var pb = pl.rect.getBoundingClientRect();
        var tb = pl.t.el.getBoundingClientRect();
        if (tb.width && !rectIn(tb, pb, 2)) add('E_TEXT_OVERFLOW', 'state "' + pl.t.str + '" spills out of its pill in part "' + v.part.id + '"', v.part.id);
      });
      if (v.extraTexts) all = all.concat(v.extraTexts());
      var boxes = [];
      all.forEach(function (t) {
        if (!t.str) return;
        var tb = t.el.getBoundingClientRect();
        if (tb.width === 0 && tb.height === 0) return;
        if (t.el.closest('g') && t.el.closest('g').style.display === 'none') return;
        var box = b;
        if (v.part.type === 'group') box = { left: b.left - 12, right: b.right + 12, top: b.top - 16, bottom: b.bottom + 12 };
        if (!rectIn(tb, box, 1.5)) add('E_TEXT_OVERFLOW', 'text "' + t.str + '" spills out of part "' + v.part.id + '"', v.part.id);
        var px = t.fs * scale;
        if (px < 7.5) add('W_TEXT_SMALL', 'text "' + t.str + '" in part "' + v.part.id + '" renders at ' + px.toFixed(1) + 'px', v.part.id);
        boxes.push({ t: t, b: tb });
      });
      for (var bi = 0; bi < boxes.length; bi++) {
        for (var bj = bi + 1; bj < boxes.length; bj++) {
          var A = boxes[bi].b;
          var B = boxes[bj].b;
          var ix = Math.min(A.right, B.right) - Math.max(A.left, B.left);
          var iy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
          if (ix > 1.5 && iy > 1.5) add('E_TEXT_COLLISION', 'texts "' + boxes[bi].t.str + '" and "' + boxes[bj].t.str + '" overlap in part "' + v.part.id + '"', v.part.id);
        }
      }
    });
    for (var i = 0; i < solid.length; i++) {
      for (var j = i + 1; j < solid.length; j++) {
        var a = solid[i].b;
        var c = solid[j].b;
        var ox = Math.min(a.right, c.right) - Math.max(a.left, c.left);
        var oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
        if (ox > 1 && oy > 1) add('E_LAYOUT_OVERLAP', 'parts "' + solid[i].id + '" and "' + solid[j].id + '" overlap', solid[j].id);
      }
    }
    var vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) add('E_PAGE_OVERFLOW', 'the page scrolls sideways (' + document.documentElement.scrollWidth + 'px content in a ' + vw + 'px window)');
    var htmlText = root.querySelectorAll('.wm-title, .wm-summary, .wm-caption-text, .wm-claim .text, .wm-claim .why, .wm-param label, .wm-btn, .wm-clock, .wm-counter');
    Array.prototype.forEach.call(htmlText, function (e) {
      if (e.offsetParent === null) return;
      var rb = e.getBoundingClientRect();
      if (rb.right > vw + 1 || rb.left < -1) add('E_OUT_OF_VIEW', 'element "' + (e.className || e.tagName) + '" is outside the window');
      if (e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX !== 'visible') add('E_TEXT_CLIPPED', 'text in "' + e.className + '" is clipped');
    });
    if (bindingErrors.length) bindingErrors.forEach(function (m) { add('E_BINDING', m); });
    var seen = {};
    return issues.filter(function (x) { var key = x.code + x.message; if (seen[key]) return false; seen[key] = 1; return true; });
  }

  // ---------------------------------------------------------------- boot --
  recompute();
  applyScale(true);
  render();
  window.workingModel = {
    ready: true,
    model: model,
    get time() { return T; },
    setTime: setTime,
    play: play,
    pause: pause,
    setParam: setParam,
    resetParams: resetParams,
    getParams: function () { return Object.assign({}, params); },
    getSummary: function () {
      return {
        passed: check.passed, total: check.total,
        mutation: mutation,
        results: check.results.map(function (r) { return { id: r.id, pass: r.pass, status: r.status, line: r.line }; }),
      };
    },
    layoutReport: layoutReport,
    bindingErrors: function () { return bindingErrors.slice(); },
    render: function () { applyScale(true); render(); },
  };
  if (!reduceMotion && !(model.playback && model.playback.autoplay === false) && !/[?#&]still\b/.test(location.href)) {
    setTimeout(function () { if (!playing && T === 0) play(); }, 600);
  }
})();
