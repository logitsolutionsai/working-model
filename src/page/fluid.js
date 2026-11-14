/* fluid.js: interruptible springs and pointer helpers for offline pages. No dependencies, about 2 KB minified.
 * Inline a copy into each generated page. Springs use Apple's response/damping model:
 *   response = period of the undamped spring in seconds; damping = damping ratio (1 = no bounce, 0.8 = slight bounce).
 *   Move or reposition: damping 1, response 0.4. Drawer or sheet: damping 0.8, response 0.3. Press: damping 1, response 0.18.
 * Every spring keeps its live value and velocity, so a new target retargets from where it is now (interruptible).
 * Under prefers-reduced-motion every spring jumps straight to its target.
 */
var Fluid = (function () {
  'use strict';
  var mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduce() { return !!(mq && mq.matches); }

  function spring(opts) {
    opts = opts || {};
    var x = opts.value || 0, v = 0, target = x, raf = 0, last = 0, k = 0, c = 0;
    var onUpdate = opts.onUpdate, onRest = opts.onRest, eps = opts.epsilon || 0.001;
    var response = opts.response || 0.4, damping = opts.damping == null ? 1 : opts.damping;
    function params(r, d) { k = Math.pow((2 * Math.PI) / r, 2); c = (4 * Math.PI * d) / r; }
    params(response, damping);
    function emit() { if (onUpdate) onUpdate(x, v); }
    function settle() { x = target; v = 0; raf = 0; emit(); if (onRest) onRest(x); }
    function step(t) {
      var dt = (t - last) / 1000;
      if (!(dt > 0)) dt = 1 / 60; // the first frame's timestamp can be earlier than the call to to()
      if (dt > 0.064) dt = 0.064;
      last = t;
      var n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
      for (var i = 0; i < n; i++) { var a = -k * (x - target) - c * v; v += a * h; x += v * h; }
      if (Math.abs(x - target) < eps && Math.abs(v) < eps * 10) return settle();
      emit();
      raf = requestAnimationFrame(step);
    }
    var api = {
      get value() { return x; },
      get velocity() { return v; },
      get target() { return target; },
      /** Animate to t. opts.velocity hands off a release velocity (units per second). */
      to: function (t, o) {
        o = o || {};
        target = t;
        if (o.velocity != null) v = o.velocity;
        if (o.response || o.damping != null) params(o.response || response, o.damping == null ? damping : o.damping);
        if (reduce()) { cancelAnimationFrame(raf); settle(); return api; }
        if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); }
        return api;
      },
      /** Jump without animating (direct manipulation: the finger owns the value). */
      set: function (val) { cancelAnimationFrame(raf); raf = 0; x = target = val; v = 0; emit(); return api; },
      stop: function () { cancelAnimationFrame(raf); raf = 0; return api; },
    };
    return api;
  }

  /** Velocity over the last 100 ms of samples, in units per second. */
  function velocityTracker() {
    var s = [];
    return {
      add: function (p, t) { t = t == null ? performance.now() : t; s.push([p, t]); while (s.length > 2 && t - s[0][1] > 100) s.shift(); },
      get: function () { if (s.length < 2) return 0; var a = s[0], b = s[s.length - 1]; return b[1] > a[1] ? (b[0] - a[0]) / ((b[1] - a[1]) / 1000) : 0; },
      reset: function () { s.length = 0; },
    };
  }

  /** Where a flick comes to rest under exponential decay (deceleration rate per millisecond, 0.998 = normal). */
  function project(velocity, rate) { rate = rate || 0.998; return ((velocity / 1000) * rate) / (1 - rate); }

  /** Resistance past an edge: overshoot in px, dimension = track length in px. Returns the drawn overshoot. */
  function rubber(overshoot, dimension, coeff) {
    coeff = coeff || 0.55;
    var sign = overshoot < 0 ? -1 : 1, o = Math.abs(overshoot);
    return sign * (1 - 1 / ((o * coeff) / dimension + 1)) * dimension;
  }

  /** Press feedback on pointer-down. Scales el with a spring; a move of more than 10 px cancels the press. */
  function pressable(el, o) {
    o = o || {};
    var down = o.scale || 0.97, start = null, sp = spring({ value: 1, response: 0.18, damping: 1, onUpdate: function (s) {
      el.style.transform = s === 1 ? '' : 'scale(' + s.toFixed(4) + ')';
    } });
    function release() { start = null; sp.to(1, { response: 0.3, damping: 0.8 }); }
    el.addEventListener('pointerdown', function (e) { if (e.button > 0) return; start = [e.clientX, e.clientY]; sp.to(down, { response: 0.18, damping: 1 }); });
    el.addEventListener('pointermove', function (e) { if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) release(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (n) { el.addEventListener(n, function () { if (start) release(); }); });
    return sp;
  }

  return { spring: spring, velocityTracker: velocityTracker, project: project, rubber: rubber, pressable: pressable, reduce: reduce };
})();
if (typeof module !== 'undefined') module.exports = Fluid;
