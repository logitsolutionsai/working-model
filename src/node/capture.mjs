// layout, snap and gif: everything that needs a real browser.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launch } from './chrome.mjs';
import { checkFile } from './check.mjs';
import { writePage } from './build.mjs';
import { snapToStep } from '../engine/model.mjs';

export const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

function baseName(file) {
  return path.basename(file).replace(/\.model\.json$/, '').replace(/\.json$/, '');
}

// Times worth checking: start, quarters, end, and each caption start.
export function sampleTimes(spec) {
  const d = spec.duration;
  const set = new Set([0, d * 0.25, d * 0.5, d * 0.75, d]);
  for (const n of spec.narration || []) if (typeof n.from === 'number' && n.from <= d) set.add(Math.min(d, n.from + spec.dt));
  return [...set].map((t) => Math.round(t / spec.dt) * spec.dt).sort((a, b) => a - b);
}

// A moment that shows the model doing something: the middle of the second caption.
export function showcaseTime(spec) {
  const caps = (spec.narration || []).slice().sort((a, b) => a.from - b.from);
  if (caps.length >= 2) {
    const c = caps[1];
    const to = c.to != null ? c.to : (caps[2] ? caps[2].from : spec.duration);
    return Math.min(spec.duration, c.from + (to - c.from) * 0.55);
  }
  return spec.duration * 0.45;
}

function prepare(specFile, outDir) {
  const report = checkFile(specFile, { probe: false });
  if (report.errors.length) {
    const e = new Error(`${specFile} has errors; run check first`);
    e.report = report;
    throw e;
  }
  const dir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'working-model-'));
  const html = path.join(dir, baseName(specFile) + '.html');
  writePage(report.spec, html);
  // a temporary folder is removed by cleanup(); a folder the caller chose is kept
  const cleanup = () => { if (!outDir) fs.rmSync(dir, { recursive: true, force: true }); };
  return { report, html, dir, spec: report.spec, cleanup };
}

export async function layoutCheck(specFile, opts = {}) {
  // screenshots go next to the spec unless --out says otherwise
  const outDir = opts.outDir || path.join(path.dirname(path.resolve(specFile)), 'working-model-shots');
  fs.mkdirSync(outDir, { recursive: true });
  const { html, spec } = prepare(specFile, outDir);
  const name = baseName(specFile);
  const browser = opts.browser || await launch();
  const result = { file: specFile, ok: true, viewports: [], screenshots: [] };
  try {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ width: vp.width, height: vp.height, colorScheme: opts.colorScheme || 'light' });
      await page.open(html);
      const issues = [];
      for (const t of sampleTimes(spec)) {
        await page.evaluate(`workingModel.pause(); workingModel.setTime(${t}); workingModel.render();`);
        await page.nextFrame();
        const found = await page.evaluate('workingModel.layoutReport()');
        for (const f of found) issues.push({ ...f, t });
      }
      await page.evaluate(`workingModel.setTime(${showcaseTime(spec)}); workingModel.render();`);
      await page.nextFrame();
      const shot = path.join(outDir, `${name}-${vp.name}.png`);
      await page.screenshot(shot, { fullPage: true });
      result.screenshots.push(shot);
      for (const e of page.errors) issues.push({ code: 'E_CONSOLE', message: e });
      for (const u of page.requests) issues.push({ code: 'E_NETWORK', message: 'the page tried to load ' + u });
      const seen = new Set();
      const unique = issues.filter((i) => { const k = i.code + i.message; if (seen.has(k)) return false; seen.add(k); return true; });
      const errors = unique.filter((i) => i.code.startsWith('E_'));
      if (errors.length) result.ok = false;
      result.viewports.push({ ...vp, issues: unique });
      await page.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    }
  } finally {
    if (!opts.browser) await browser.close();
  }
  return result;
}

function parseSets(sets) {
  const out = {};
  for (const s of sets || []) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(-?[\d.]+(?:e-?\d+)?)$/.exec(s);
    if (!m) throw new Error(`--set expects name=number, got "${s}"`);
    out[m[1]] = Number(m[2]);
  }
  return out;
}

// Refuse a misspelt --set or --drag name before starting Chrome, with the list of params.
function knownParams(report, ids, flag) {
  const known = report.model.params.map((p) => p.id);
  for (const id of ids) {
    if (!known.includes(id)) throw new Error(`${flag} ${id}: the spec has no param "${id}" (params: ${known.join(', ') || 'none'})`);
  }
}

async function applyParams(page, sets) {
  for (const [k, v] of Object.entries(sets)) await page.evaluate(`workingModel.setParam(${JSON.stringify(k)}, ${v})`);
}

async function clipFor(page, which) {
  if (!which || which === 'viewport') return null;
  if (which === 'page') return 'full';
  const sel = which === 'diagram' ? '.wm-figure' : which === 'stage' ? '.wm-stage' : which;
  const r = await page.rect(sel);
  if (!r) throw new Error(`nothing matches ${sel}`);
  const pad = 8;
  return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 };
}

export async function snap(specFile, opts = {}) {
  const { html, spec, cleanup, report } = prepare(specFile, opts.workDir);
  let browser = opts.browser;
  try {
    const sets = parseSets(opts.set);
    knownParams(report, Object.keys(sets), '--set');
    if (!browser) browser = await launch();
    const page = await browser.newPage({ width: opts.width || 1280, height: opts.height || 800, colorScheme: opts.theme || 'light' });
    await page.open(html);
    await applyParams(page, sets);
    const t = opts.at != null ? Number(opts.at) : showcaseTime(spec);
    await page.evaluate(`workingModel.pause(); workingModel.setTime(${t}); workingModel.render();`);
    await page.nextFrame();
    const clip = await clipFor(page, opts.clip);
    await page.screenshot(opts.out, clip === 'full' ? { fullPage: true } : clip ? { clip } : {});
    const errors = page.errors.slice();
    await page.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    return { file: opts.out, t, errors };
  } finally {
    if (!opts.browser && browser) await browser.close();
    cleanup();
  }
}

// "capacity=10..16@2..4": move capacity from 10 to 16 between gif seconds 2 and 4.
export function parseDrag(s) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(-?[\d.]+)\.\.(-?[\d.]+)@([\d.]+)\.\.([\d.]+)$/.exec(s || '');
  if (!m) throw new Error(`--drag expects name=from..to@start..end, got "${s}"`);
  return { id: m[1], from: Number(m[2]), to: Number(m[3]), start: Number(m[4]), end: Number(m[5]) };
}

export function ffmpegAvailable() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return r.status === 0;
}

export async function gif(specFile, opts = {}) {
  if (!ffmpegAvailable()) throw new Error('gif needs ffmpeg on PATH');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'working-model-gif-'));
  let prepared;
  let sets;
  let drags;
  try {
    prepared = prepare(specFile, work);
    sets = parseSets(opts.set);
    drags = (opts.drag || []).map(parseDrag);
    knownParams(prepared.report, [...Object.keys(sets), ...drags.map((d) => d.id)], opts.drag && opts.drag.length ? '--set or --drag' : '--set');
  } catch (e) {
    fs.rmSync(work, { recursive: true, force: true });
    throw e;
  }
  const { html, spec, report } = prepared;
  const fps = opts.fps || 10;
  const seconds = opts.seconds || 8;
  const from = opts.from != null ? Number(opts.from) : 0;
  const to = opts.to != null ? Number(opts.to) : spec.duration;
  const holdEnd = opts.hold != null ? Number(opts.hold) : 1;
  const frames = Math.max(2, Math.round(seconds * fps));
  const paramDefs = report.model.params;
  let browser = null;
  try {
    browser = await launch();
    const page = await browser.newPage({ width: opts.width || 1280, height: opts.height || 800, colorScheme: opts.theme || 'light' });
    await page.open(html);
    await applyParams(page, sets);
    await page.evaluate('workingModel.pause()');
    const clip = await clipFor(page, opts.clip);
    const last = {};
    const playSeconds = Math.max(0.1, seconds - holdEnd);
    for (let i = 0; i < frames; i++) {
      const g = i / fps;
      const t = from + (to - from) * Math.min(1, g / playSeconds);
      for (const d of drags) {
        const u = g <= d.start ? 0 : g >= d.end ? 1 : (g - d.start) / (d.end - d.start);
        const p = paramDefs.find((q) => q.id === d.id);
        if (!p) throw new Error(`--drag: unknown param ${d.id}`);
        const v = snapToStep(d.from + (d.to - d.from) * u, p);
        if (last[d.id] !== v) { await page.evaluate(`workingModel.setParam(${JSON.stringify(d.id)}, ${v})`); last[d.id] = v; }
      }
      await page.evaluate(`workingModel.setTime(${t})`);
      await page.nextFrame();
      await page.screenshot(path.join(work, `f${String(i).padStart(4, '0')}.png`), clip && clip !== 'full' ? { clip } : {});
    }
  } catch (e) {
    fs.rmSync(work, { recursive: true, force: true });
    throw e;
  } finally {
    if (browser) await browser.close();
  }
  const out = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const maxBytes = (opts.maxMb || 3) * 1024 * 1024;
  const widths = [opts.scale || 960, 840, 720, 640];
  let size = 0;
  for (const w of widths) {
    const filter = `scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(work, 'f%04d.png'), '-vf', filter, '-loop', '0', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) throw new Error('ffmpeg failed: ' + String(r.stderr).slice(0, 500));
    size = fs.statSync(out).size;
    if (size <= maxBytes) break;
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { file: out, bytes: size, frames };
}
