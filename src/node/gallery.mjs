// `working-model gallery`: build every example and an index page of cards.

import fs from 'node:fs';
import path from 'node:path';
import { checkFile, listSpecFiles } from './check.mjs';
import { writePage } from './build.mjs';
import { launch } from './chrome.mjs';
import { snap, showcaseTime } from './capture.mjs';

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export async function buildGallery(opts = {}) {
  const examples = opts.examples || 'examples';
  const out = opts.out || 'gallery';
  fs.mkdirSync(out, { recursive: true });
  const files = listSpecFiles(examples);
  const cards = [];
  const problems = [];
  for (const file of files) {
    const r = checkFile(file, { probe: false, mutate: opts.mutate === false ? null : {} });
    const name = path.basename(file).replace(/\.model\.json$/, '');
    if (r.errors.length) { problems.push({ file, summary: `${r.errors[0].code} ${r.errors[0].message}` }); continue; }
    const mutation = r.mutation && r.mutation.ok ? r.mutation : null;
    writePage(r.spec, path.join(out, name + '.html'), { mutation });
    const m = r.model;
    let summary = '';
    try { summary = m.summary ? m.summary({ P: r.trace.params, S: Object.create(null), L: [], t: 0 }) : ''; } catch { summary = ''; }
    cards.push({
      name, title: m.title, summary, passed: r.passed, total: r.total,
      mutationScore: mutation ? Math.floor(mutation.score * 100 + 1e-9) : null,
      kinds: [...new Set(m.claims.map((c) => c.kind))],
      parts: [...new Set(m.parts.map((p) => p.type))],
      params: m.params.map((p) => p.label),
      spec: r.spec,
    });
    if (r.passed !== r.total) problems.push({ file, summary: `${r.passed}/${r.total} claims pass` });
  }
  if (opts.thumbs) {
    fs.mkdirSync(path.join(out, 'thumbs'), { recursive: true });
    const browser = await launch();
    try {
      for (const c of cards) {
        await snap(path.join(examples, c.name + '.model.json'), {
          browser, out: path.join(out, 'thumbs', c.name + '.png'), clip: 'diagram', width: 1280, height: 800,
          // Render into a temporary folder: writing into `out` would replace the gallery page above with one
          // built without its stored mutation score.
          at: showcaseTime(c.spec),
        });
      }
    } finally {
      await browser.close();
    }
  }
  // optional examples/gallery.json: { "order": ["first-name", ...] }
  const orderFile = path.join(examples, 'gallery.json');
  if (fs.existsSync(orderFile)) {
    const order = JSON.parse(fs.readFileSync(orderFile, 'utf8')).order || [];
    const rank = (n) => { const i = order.indexOf(n); return i < 0 ? order.length : i; };
    cards.sort((x, y) => rank(x.name) - rank(y.name) || x.name.localeCompare(y.name));
  }
  const hasThumbs = (c) => fs.existsSync(path.join(out, 'thumbs', c.name + '.png'));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: file:;">
<title>working-model gallery</title>
<style>
:root { color-scheme: light; --bg: #f7f7f5; --surface: #ffffff; --surface-2: #f0f0ed; --line: #e3e3df; --line-strong: #c9c9c3; --ink: #111110; --ink-2: #3a3a37; --muted: #6f6f69; --accent: #0065FD;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --bg: #0e0e0d; --surface: #171716; --surface-2: #1f1f1d; --line: #2b2b29; --line-strong: #3d3d3a; --ink: #f4f4f2; --ink-2: #d6d6d2; --muted: #9a9a94; --accent: #5b9cff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 var(--sans); }
main { max-width: 1240px; margin: 0 auto; padding: 40px 32px 48px; }
.kicker { font: 600 11px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
h1 { margin: 8px 0 6px; font: 600 clamp(30px, 4vw, 46px)/1.05 var(--serif); }
.lede { margin: 0 0 32px; max-width: 68ch; color: var(--ink-2); font-size: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 24px; }
.card { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; color: inherit; text-decoration: none; overflow: hidden; transition: border-color .15s; }
.card:hover { border-color: var(--line-strong); }
.card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.thumb { aspect-ratio: 16 / 9.6; border-bottom: 1px solid var(--line); background: var(--bg); overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
.body { padding: 16px; display: grid; gap: 8px; }
.card h2 { margin: 0; font: 600 21px/1.2 var(--serif); }
.card p { margin: 0; color: var(--ink-2); font-size: 13.5px; }
.chip { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px; font: 600 11.5px/1 var(--mono); letter-spacing: .02em; font-variant-numeric: tabular-nums; background: var(--surface-2); color: var(--muted); }
.chip.fail { background: var(--ink); color: var(--bg); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.tags { display: flex; flex-wrap: wrap; gap: 5px; }
.tags span { font: 600 10.5px/1.6 var(--mono); letter-spacing: .04em; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; }
footer { margin-top: 32px; font-size: 12.5px; color: var(--muted); }
@media (max-width: 520px) { main { padding: 24px 16px 36px; } .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
<div class="kicker">working-model</div>
<h1>Gallery</h1>
<p class="lede">Each page is a working model: an animation you can scrub and steer, with claims that are re-checked by simulation as you move the sliders. Open one, drag a slider until a claim fails, and see where the explanation stops holding.</p>
<div class="grid">
${cards.map((c) => `<a class="card" href="${esc(c.name)}.html">
${hasThumbs(c) ? `<div class="thumb"><img src="thumbs/${esc(c.name)}.png" alt="Diagram of ${esc(c.title)}" loading="lazy"></div>` : ''}
<div class="body">
<h2>${esc(c.title)}</h2>
<p>${esc(c.summary)}</p>
<div class="chips"><span class="chip${c.passed === c.total ? '' : ' fail'}" data-passed="${c.passed}" data-total="${c.total}">${c.passed} of ${c.total} claims hold</span>${c.mutationScore != null ? `<span class="chip mut" data-mutation-score="${c.mutationScore}" title="Share of deliberate bugs in the rules that some claim catches">mutation score ${c.mutationScore}%</span>` : ''}</div>
<div class="tags">${c.kinds.map((k) => `<span>${esc(k)}</span>`).join('')}${c.parts.filter((p) => p !== 'link' && p !== 'label').map((p) => `<span>${esc(p)}</span>`).join('')}</div>
</div>
</a>`).join('\n')}
</div>
<footer>Built with working-model. Every page works offline and makes no network requests.</footer>
</main>
</body>
</html>
`;
  fs.writeFileSync(path.join(out, 'index.html'), html);
  return { out, cards: cards.length, problems, scores: Object.fromEntries(cards.map((c) => [c.name, c.mutationScore])) };
}
