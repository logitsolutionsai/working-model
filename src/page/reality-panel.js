// Model versus observed trace: the comparison section of a `build --trace`
// page. It re-runs the replay, matching and assertions in the browser with
// the same modules `check --trace` ran (WM.evaluateReality), then checks that
// its result equals the command line's report embedded in the page.
// Every trace string is inserted with textContent, never as markup.
// Status is weight and shape: observed marks are solid, simulated marks are
// hollow, matched pairs are joined by a dashed line, and the first mismatch
// is an ink chip with a cross. The accent marks only the cursor and controls.
(function () {
  'use strict';
  var root = document.getElementById('wmr');
  if (!root) return;
  var SVG = 'http://www.w3.org/2000/svg';
  var api = { ready: false, parity: null, error: null };
  window.workingModelReality = api;

  function h(tag, cls, text, parent) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    if (parent) parent.appendChild(el);
    return el;
  }
  function s(tag, attrs, parent) {
    var el = document.createElementNS(SVG, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(el);
    return el;
  }
  function fmtMs(ms) { return (Math.round(ms * 1000) / 1000) + ' ms'; }
  function fmtVal(v) {
    if (v == null) return 'null';
    if (Array.isArray(v)) return v.length > 6 ? '[' + v.length + ' items]' : '[' + v.map(fmtVal).join(', ') + ']';
    if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
    return String(v);
  }
  function chip(status, parent) {
    var lvl = status === 'fail' ? 'l3' : status === 'pass' ? 'l1' : 'l0';
    var glyph = status === 'fail' ? '✕ ' : status === 'pass' ? '✓ ' : '';
    var c = h('span', 'wm-chip ' + lvl + ' wmr-status', glyph + status, parent);
    c.setAttribute('data-status', status);
    return c;
  }

  var data, spec, model, mapping, res;
  try {
    data = JSON.parse(document.getElementById('wm-reality').textContent);
    spec = JSON.parse(document.getElementById('wm-spec').textContent);
    var compiled = WM.compileModel(spec);
    if (compiled.errors.length) throw new Error('the model does not compile: ' + compiled.errors[0].message);
    model = compiled.model;
    mapping = WM.validateMapping(data.mapping, model);
    res = WM.evaluateReality(model, data.trace, mapping, { params: data.params });
  } catch (e) {
    h('div', 'wm-error', 'The comparison could not run in the browser: ' + (e && e.message ? e.message : e), root);
    api.error = String(e && e.message ? e.message : e);
    api.ready = true;
    return;
  }
  var node = data.report;
  var rep = res.report;

  // ---- parity with the command line --------------------------------------
  function summary(r) {
    return JSON.stringify({
      status: r.status,
      counts: [r.observedAssertions.passed, r.observedAssertions.failed, r.observedAssertions.inconclusive],
      results: r.observedAssertions.results.map(function (a) {
        return [a.id, a.status, a.firstFailure ? [a.firstFailure.type, a.firstFailure.atMs, a.firstFailure.relatedEventIds] : null, a.inconclusiveReason || null];
      }),
      outputs: r.outputs.map(function (o) { return [o.modelEmit, o.expected, o.observed, o.matched, o.uncorrelated]; }),
      first: r.firstMismatch ? [r.firstMismatch.assertionId, r.firstMismatch.type, r.firstMismatch.atMs, r.firstMismatch.relatedEventIds] : null,
      coverage: [r.coverage.inputMapped, r.coverage.outputMapped, r.coverage.observedUnmapped, r.coverage.modelOutputs],
      ticks: r.replay.ticks,
    });
  }
  var parity = summary(rep) === summary(node);
  api.parity = parity;
  api.browser = JSON.parse(summary(rep));
  api.node = JSON.parse(summary(node));

  // ---- header -------------------------------------------------------------
  root.innerHTML = '';
  h('div', 'wm-kicker', 'Model versus observed', root);
  h('h2', 'wmr-title', 'Model Versus Observed Trace', root).id = 'wmr-title';
  var oa = rep.observedAssertions;
  var line = h('p', 'wmr-line', null, root);
  line.id = 'wmr-line';
  h('span', null, 'Model: ' + node.modelClaims.passed + '/' + node.modelClaims.total + ' claims pass', line);
  h('span', 'wmr-sep', ' | ', line);
  h('span', null, 'Observed: ' + oa.passed + ' pass, ' + oa.failed + ' fail, ' + oa.inconclusive + ' inconclusive', line);
  h('span', 'wmr-sep', ' | ', line);
  chip(rep.status === 'error' ? 'fail' : rep.status, line);
  h('p', 'wmr-note', 'These are separate results. The claims are about the simulation above; the observed assertions are about this trace only, read through the mapping. Completeness: ' + rep.completeness + '.', root);

  // ---- timeline -------------------------------------------------------------
  var panel = h('div', 'wm-panel wmr-timeline', null, root);
  var controls = h('div', 'wmr-controls', null, panel);
  function button(label, fn) {
    var b = h('button', 'wmr-btn', label, controls);
    b.type = 'button';
    b.addEventListener('click', fn);
    if (window.Fluid) Fluid.pressable(b);
    return b;
  }
  var dtMs = mapping.dtMs;
  var marks = []; // { lane: 'observed'|'simulated'|'input', ms, kind, subject, id, matched }
  var pairs = [];
  res.outputs.forEach(function (o) {
    o.observed.forEach(function (x) { marks.push({ lane: 'observed', ms: x.timeMs, kind: x.kind, subject: x.subject, id: x.id }); });
    o.expected.forEach(function (x) { marks.push({ lane: 'simulated', ms: x.timeMs, kind: o.output.observedKind, subject: x.subject, id: 'model ' + o.output.modelEmit + ' #' + x.key, emit: o.output.modelEmit }); });
    o.match.pairs.forEach(function (p) { pairs.push({ a: p.observed.timeMs, b: p.expected.timeMs }); });
  });
  var matchedIds = {};
  res.outputs.forEach(function (o) { o.match.pairs.forEach(function (p) { matchedIds[p.observed.id] = true; matchedIds['model ' + o.output.modelEmit + ' #' + p.expected.key] = true; }); });
  var inputs = res.run ? res.run.inputs : [];
  var lastMs = 0;
  data.trace.events.forEach(function (e) { if (e.timeMs > lastMs) lastMs = e.timeMs; });
  marks.forEach(function (m) { if (m.ms > lastMs) lastMs = m.ms; });
  var spanMs = Math.max(lastMs, dtMs) * 1.02;
  var first = rep.firstMismatch;
  var cursorMs = 0;
  var playing = false;

  var playBtn = button('Play', function () { setPlaying(!playing); });
  button('Step back', function () { setPlaying(false); moveTo(cursorMs - dtMs, false); });
  button('Step forward', function () { setPlaying(false); moveTo(cursorMs + dtMs, false); });
  var jump = button('Jump to first mismatch', function () { setPlaying(false); if (first) moveTo(first.atMs, true); });
  if (!first) jump.disabled = true;
  button('Reset', function () { setPlaying(false); moveTo(0, true); });
  var scrubWrap = h('label', 'wmr-scrub', null, panel);
  h('span', 'wmr-scrub-label', 'Time', scrubWrap);
  var scrub = h('input', null, null, scrubWrap);
  scrub.type = 'range';
  scrub.min = '0';
  scrub.max = String(spanMs);
  scrub.step = String(dtMs);
  scrub.value = '0';
  scrub.setAttribute('aria-label', 'Trace time in milliseconds');
  var readout = h('output', 'wmr-readout', 't = 0 ms', scrubWrap);
  scrub.addEventListener('input', function () { setPlaying(false); moveTo(Number(scrub.value), false); });

  var svgWrap = h('div', 'wmr-svg', null, panel);
  var svg = s('svg', { role: 'img', 'aria-label': 'Observed events (solid) and simulated outputs (hollow) on one time axis; dashed lines join matched pairs' }, svgWrap);
  var legend = h('p', 'wmr-legend', 'Solid: observed. Hollow: simulated by the model. Dashed line: a matched pair. Small ticks: observed inputs replayed. ✕: the first mismatch.', panel);
  legend.id = 'wmr-legend';
  var cursorLine = null;
  var W = 600;
  var H = 206;
  var padL = 12;
  var padR = 12;
  var yObs = 66; // first-mismatch chips sit above the observed lane, below the simulated lane
  var ySim = 132;
  function x(ms) { return padL + (ms / spanMs) * (W - padL - padR); }

  function draw() {
    W = Math.max(280, Math.round(svgWrap.clientWidth || 600));
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    var lab = s('text', { x: padL + 8, y: 14, class: 'wmr-lane' }, svg); lab.textContent = 'Observed trace';
    var lab2 = s('text', { x: padL + 8, y: ySim - 16, class: 'wmr-lane' }, svg); lab2.textContent = 'Simulated by the model (replay)';
    var counts = { observed: 0, simulated: 0 };
    marks.forEach(function (m) { counts[m.lane]++; });
    if (!counts.simulated) { var e1 = s('text', { x: padL + 8, y: ySim + 20, class: 'wmr-empty' }, svg); e1.textContent = 'no mapped output predicted'; }
    if (!counts.observed) { var e2 = s('text', { x: padL + 8, y: yObs - 12, class: 'wmr-empty' }, svg); e2.textContent = 'no mapped output observed'; }
    s('line', { x1: padL, x2: W - padR, y1: yObs, y2: yObs, class: 'wmr-axis' }, svg);
    s('line', { x1: padL, x2: W - padR, y1: ySim, y2: ySim, class: 'wmr-axis' }, svg);
    var cap = 2000;
    inputs.slice(0, cap).forEach(function (p) { s('line', { x1: x(p.timeMs), x2: x(p.timeMs), y1: yObs + 9, y2: yObs + 15, class: 'wmr-input' }, svg); });
    pairs.slice(0, cap).forEach(function (p) { s('line', { x1: x(p.a), x2: x(p.b), y1: yObs + 5, y2: ySim - 5, class: 'wmr-pair' }, svg); });
    marks.slice(0, cap * 2).forEach(function (m) {
      var cy = m.lane === 'observed' ? yObs : ySim;
      var c = s('circle', { cx: x(m.ms), cy: cy, r: 5, class: m.lane === 'observed' ? 'wmr-obs' : 'wmr-sim' }, svg);
      var t = s('title', {}, c);
      t.textContent = (m.lane === 'observed' ? 'observed ' : 'simulated ') + m.kind + ' at ' + fmtMs(m.ms) + (m.subject != null ? ', subject ' + m.subject : '') + ' (' + m.id + ')' + (matchedIds[m.id] ? ', matched' : ', unmatched');
    });
    if (first) {
      var onObs = first.type !== 'missing_observed_output' && first.type !== 'missing_response';
      var fx = x(first.atMs);
      var fy = onObs ? yObs : ySim;
      var g = s('g', { class: 'wmr-first', 'data-first-mismatch': first.type }, svg);
      var dir = onObs ? -1 : 1; // the chip goes above the observed lane and below the simulated one
      s('line', { x1: fx, x2: fx, y1: fy + dir * 8, y2: fy + dir * 18, class: 'wmr-first-stem' }, g);
      var label = '✕ first mismatch';
      var wChip = 112;
      var cx0 = Math.min(Math.max(fx - wChip / 2, 2), W - wChip - 2);
      var cy0 = onObs ? fy - 36 : fy + 18;
      s('rect', { x: cx0, y: cy0, width: wChip, height: 18, rx: 9, class: 'wmr-chip-l3' }, g);
      var ft = s('text', { x: cx0 + wChip / 2, y: cy0 + 13, 'text-anchor': 'middle', class: 'wmr-chip-text' }, g);
      ft.textContent = label;
      s('circle', { cx: fx, cy: fy, r: 8, class: 'wmr-first-ring' }, g);
    }
    var t0 = s('text', { x: padL, y: H - 6, class: 'wmr-tick' }, svg); t0.textContent = '0 ms';
    var t1 = s('text', { x: W - padR, y: H - 6, 'text-anchor': 'end', class: 'wmr-tick' }, svg); t1.textContent = fmtMs(Math.round(spanMs));
    cursorLine = s('line', { x1: x(cursorMs), x2: x(cursorMs), y1: 22, y2: H - 18, class: 'wmr-cursor' }, svg);
  }

  // ---- panels ----------------------------------------------------------------
  var grid = h('div', 'wmr-grid', null, root);
  function card(title) {
    var c = h('section', 'wm-panel wmr-card', null, grid);
    h('h3', 'wmr-h3', title, c);
    return c;
  }
  var fm = card('First Mismatch');
  if (first) {
    var dl = h('dl', 'wmr-dl', null, fm);
    [['Assertion', first.assertionId], ['Type', first.type], ['Time', fmtMs(first.atMs)], ['Subject', first.subject == null ? 'none' : first.subject],
      ['Expected', first.expectedKind == null ? 'nothing' : first.expectedKind], ['Observed', first.observedKind == null ? 'nothing' : first.observedKind],
      ['Cause', first.cause], ['Events', (first.relatedEventIds || []).join(', ') || 'none'], ['Test', first.test || '']].forEach(function (r) {
      h('dt', null, r[0], dl); h('dd', null, r[1], dl);
    });
  } else {
    h('p', 'wmr-muted', rep.status === 'pass' ? 'No required observed assertion failed.' : 'No observed assertion failed. Inconclusive results are listed below with their reasons.', fm);
  }

  var at = card('At The Cursor');
  var atBody = h('div', null, null, at);
  function renderAt() {
    atBody.innerHTML = '';
    h('p', 'wmr-muted', 't = ' + fmtMs(cursorMs) + ' (tick ' + tickAt(cursorMs) + ')', atBody);
    var tbl = h('table', 'wmr-table wmr-at', null, atBody);
    var hr = h('tr', null, null, h('thead', null, null, tbl));
    h('th', null, 'State', hr); h('th', null, 'Simulated', hr); h('th', null, 'Observed', hr);
    var tb = h('tbody', null, null, tbl);
    var snap = res.run && res.run.snaps[tickAt(cursorMs)];
    model.stateNames.forEach(function (n) {
      var tr = h('tr', null, null, tb);
      h('td', 'wmr-mono', n, tr);
      h('td', 'wmr-mono', snap ? fmtVal(snap[n]) : 'not simulated', tr);
      h('td', 'wmr-muted', 'not observed', tr);
    });
    var near = data.trace.events.filter(function (e) { return Math.abs(e.timeMs - cursorMs) <= dtMs / 2; });
    h('p', 'wmr-muted', near.length ? 'Observed at this moment: ' + near.slice(0, 8).map(function (e) { return e.kind + ' (' + e.id + ')'; }).join(', ') + (near.length > 8 ? ', ...' : '') : 'No observed event at this moment.', atBody);
  }
  function tickAt(ms) {
    var K = res.run ? res.run.K : 0;
    return Math.max(0, Math.min(K, Math.round((ms - rep.replay.originMs) / dtMs)));
  }

  var as = card('Observed Assertions');
  var ul = h('ul', 'wmr-list', null, as);
  oa.results.forEach(function (a) {
    var li = h('li', 'wmr-item', null, ul);
    li.setAttribute('data-assertion', a.id);
    var top = h('div', 'wmr-item-top', null, li);
    chip(a.status, top);
    h('span', 'wmr-mono', a.id, top);
    var def = mapping.assertions.filter(function (x) { return x.id === a.id; })[0];
    if (def && def.text) h('p', 'wmr-item-text', def.text, li);
    if (a.test) h('p', 'wmr-mono wmr-small', 'test: ' + a.test, li);
    if (a.failedTest) h('p', 'wmr-mono wmr-small', 'failed: ' + a.failedTest, li);
    if (a.inconclusiveReason) h('p', 'wmr-small', 'inconclusive: ' + a.inconclusiveReason, li);
    if (a.firstFailure) h('p', 'wmr-mono wmr-small', 'events: ' + a.firstFailure.relatedEventIds.join(', '), li);
  });

  var cov = card('Coverage');
  var c = rep.coverage;
  var dl2 = h('dl', 'wmr-dl', null, cov);
  [['Observed events', c.observedEvents], ['Mapped to model inputs', c.inputMapped], ['Mapped to model outputs', c.outputMapped], ['Not mapped', c.observedUnmapped],
    ['Model outputs', c.modelOutputs], ['Uncorrelated', c.uncorrelated], ['Inputs replayed', rep.replay.inputsReplayed], ['Tick', fmtMs(dtMs)],
    ['Largest time shift', fmtMs(rep.replay.maxQuantizationErrorMs)]].forEach(function (r) { h('dt', null, r[0], dl2); h('dd', null, r[1], dl2); });
  var kinds = Object.keys(c.unmappedKinds || {}).sort();
  if (kinds.length) h('p', 'wmr-small', 'Not mapped: ' + kinds.map(function (k) { return k + ' (' + c.unmappedKinds[k] + ')'; }).join(', '), cov);

  var asm = card('What The Model Assumed');
  if ((node.assumptions || []).length) {
    var ul2 = h('ul', 'wmr-list', null, asm);
    node.assumptions.forEach(function (x) { var li = h('li', null, null, ul2); h('span', 'wmr-mono wmr-small', (x.scope || 'model') + ' ', li); h('span', null, x.text, li); });
  } else h('p', 'wmr-muted', 'The spec lists no assumptions in reality.assumptions.', asm);
  (node.sourceRefs || []).forEach(function (r) {
    var p = h('p', 'wmr-small', null, asm);
    h('span', null, r.title + ' (' + (r.kind || 'background') + ')', p);
    if (r.url) { h('br', null, null, p); h('span', 'wmr-mono', r.url, p); }
  });

  var rp = card('Reproduce');
  (node.reproduce || []).forEach(function (cmd) { h('code', 'wmr-code', cmd, rp); });
  h('p', 'wmr-small', parity ? 'Browser re-check: the same result as the command line, assertion for assertion and pair for pair.' : 'Browser re-check: the result differs from the command line. Do not rely on this page; run the command above.', rp).id = 'wmr-parity';
  h('p', 'wmr-small', 'Privacy: this page holds the normalized trace (event kinds, times, subjects and allowlisted attributes). Do not publish it. For a public page, use bundle --public, which keeps only a projection without subjects or attributes.', rp);
  h('p', 'wmr-small', 'These are executable explanations with trace evidence, not formal verification: a pass covers only the events this trace recorded.', rp);

  // ---- data table --------------------------------------------------------------
  var det = h('details', 'wm-panel wmr-details', null, root);
  h('summary', null, 'Data table of the timeline', det);
  var wrap = h('div', 'wmr-table-wrap', null, det);
  var table = h('table', 'wmr-table', null, wrap);
  var hr2 = h('tr', null, null, h('thead', null, null, table));
  ['Time', 'Lane', 'Kind', 'Subject', 'Event', 'Matched'].forEach(function (t) { h('th', null, t, hr2); });
  var tb2 = h('tbody', null, null, table);
  var rows = marks.slice().sort(function (a, b) { return a.ms - b.ms || (a.lane < b.lane ? -1 : 1); });
  rows.slice(0, 500).forEach(function (m) {
    var tr = h('tr', null, null, tb2);
    h('td', 'wmr-mono', fmtMs(m.ms), tr); h('td', null, m.lane, tr); h('td', 'wmr-mono', m.kind, tr);
    h('td', 'wmr-mono', m.subject == null ? '' : m.subject, tr); h('td', 'wmr-mono', m.id, tr); h('td', null, matchedIds[m.id] ? 'yes' : 'no', tr);
  });
  if (rows.length > 500) h('p', 'wmr-small', 'Showing the first 500 of ' + rows.length + ' rows.', det);

  // ---- cursor motion -------------------------------------------------------------
  var spring = window.Fluid ? Fluid.spring({ value: 0, response: 0.4, damping: 1, onUpdate: function (v) { paintCursor(v); } }) : null;
  function paintCursor(ms) {
    cursorMs = ms;
    if (cursorLine) { var px = x(ms); cursorLine.setAttribute('x1', px); cursorLine.setAttribute('x2', px); }
    readout.textContent = 't = ' + fmtMs(Math.round(ms));
  }
  var lastAtTick = -1;
  function moveTo(ms, animate) {
    ms = Math.max(0, Math.min(spanMs, ms));
    scrub.value = String(ms);
    if (spring && animate) { spring.to(ms); } else if (spring) spring.set(ms); else paintCursor(ms);
    cursorMs = ms;
    var k = tickAt(ms);
    if (k !== lastAtTick) { lastAtTick = k; renderAt(); }
  }
  var raf = 0;
  var lastT = 0;
  function frame(t) {
    var dts = lastT ? (t - lastT) / 1000 : 0;
    lastT = t;
    var next = cursorMs + dts * (spanMs / 12);
    if (next >= spanMs) { moveTo(spanMs, false); setPlaying(false); return; }
    moveTo(next, false);
    raf = requestAnimationFrame(frame);
  }
  function setPlaying(on) {
    playing = on;
    playBtn.textContent = on ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastT = 0;
    if (on) raf = requestAnimationFrame(frame);
  }
  svgWrap.tabIndex = 0;
  svgWrap.setAttribute('aria-describedby', 'wmr-legend');
  svgWrap.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveTo(cursorMs - dtMs, false); }
    if (e.key === 'ArrowRight') { e.preventDefault(); moveTo(cursorMs + dtMs, false); }
  });
  draw();
  renderAt();
  var resizeRaf = 0;
  window.addEventListener('resize', function () {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () { resizeRaf = 0; draw(); paintCursor(cursorMs); });
  });

  api.firstMismatchMs = first ? first.atMs : null;
  api.moveTo = function (ms) { moveTo(ms, false); return tickAt(ms); };
  api.cursor = function () { return cursorMs; };
  api.status = rep.status;
  api.ready = true;
})();
