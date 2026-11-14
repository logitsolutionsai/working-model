// End-to-end: build every example, load it in the installed Chrome with all
// network traffic aborted, and check that the page agrees with Node.
// Run with: npm run test:e2e   (needs playwright-core and a local Chrome or Edge)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../../src/node/chrome.mjs';
import { checkFile, listSpecFiles } from '../../src/node/check.mjs';
import { renderPage, pageMutation } from '../../src/node/build.mjs';
import { sampleTimes, VIEWPORTS } from '../../src/node/capture.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'tests', 'output', 'e2e');
const EXAMPLES = listSpecFiles(path.join(ROOT, 'examples'));

// Sliders that move a claim from passing to failing (keyboard End or Home on the slider).
const FLIPS = [
  { example: 'token-bucket', param: 'burst', key: 'Home', claim: 'burst-passes' },
  { example: 'sir-epidemic', param: 'vaccinated', key: 'Home', claim: 'under-the-line' },
  { example: 'backoff-jitter', param: 'jitter', key: 'Home', claim: 'recovers-fast' },
  { example: 'circuit-breaker', param: 'cooldown', key: 'Home', claim: 'spares-service' },
  { example: 'raft-election', param: 'spread', key: 'Home', claim: 'first-leader' },
  { example: 'reorder-point', param: 'lead', key: 'End', claim: 'no-stockout' },
];

let browser;
const requests = [];

async function openPage(spec, viewport = { width: 1280, height: 800 }, html = null) {
  const context = await browser.newContext({ viewport, colorScheme: 'light' });
  await context.route('**/*', (route) => { requests.push(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent(html || renderPage(spec), { waitUntil: 'load' });
  await page.waitForFunction(() => window.workingModel && window.workingModel.ready);
  await page.evaluate(() => window.workingModel.pause());
  return { page, context, errors };
}

before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--disable-gpu', '--disable-background-networking', '--disable-component-update'] });
});

after(async () => {
  if (browser) await browser.close();
});

describe('every example in the browser', () => {
  for (const file of EXAMPLES) {
    const name = path.basename(file, '.model.json');
    test(name, async () => {
      const node = checkFile(file, { probe: false });
      assert.equal(node.passed, node.total, 'Node: all claims pass');
      const before = requests.length;
      const { page, context, errors } = await openPage(node.spec);
      try {
        // the claims panel shows N/N, computed in the page, and agrees claim by claim with Node
        const summary = await page.textContent('[data-testid="claims-summary"]');
        assert.equal(summary.trim(), `${node.total}/${node.total} claims pass`);
        const statuses = await page.$$eval('[data-claim-id]', (els) => els.map((e) => [e.getAttribute('data-claim-id'), e.getAttribute('data-status')]));
        assert.deepEqual(statuses, node.results.map((r) => [r.id, r.status]));
        const fromPage = await page.evaluate(() => window.workingModel.getSummary());
        assert.deepEqual(fromPage.results.map((r) => r.id + ':' + r.status), node.results.map((r) => r.id + ':' + r.status));

        // playback advances the scrubber
        const t0 = Number(await page.inputValue('.wm-scrub'));
        await page.click('.wm-transport .wm-btn.primary');
        await page.waitForTimeout(700);
        await page.evaluate(() => window.workingModel.pause());
        const t1 = Number(await page.inputValue('.wm-scrub'));
        assert.ok(t1 > t0, `scrubber moved from ${t0} to ${t1}`);

        // keyboard: arrow steps one tick, space toggles playback
        await page.evaluate(() => window.workingModel.setTime(0));
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        await page.keyboard.press('ArrowRight');
        const t2 = await page.evaluate(() => window.workingModel.time);
        assert.ok(Math.abs(t2 - node.spec.dt) < 1e-9, `one step is dt (${t2})`);
        await page.keyboard.press('Space');
        assert.equal(await page.evaluate(() => document.querySelector('.wm-transport .wm-btn.primary').getAttribute('aria-label')), 'Pause');
        await page.keyboard.press('Space');
        assert.equal(await page.evaluate(() => document.querySelector('.wm-transport .wm-btn.primary').getAttribute('aria-label')), 'Play');

        // layout holds at every sampled moment, desktop size
        for (const t of sampleTimes(node.spec)) {
          await page.evaluate((x) => { window.workingModel.setTime(x); window.workingModel.render(); }, t);
          const issues = (await page.evaluate(() => window.workingModel.layoutReport())).filter((i) => i.code.startsWith('E_'));
          assert.deepEqual(issues, [], `layout at t = ${t}`);
        }
        await page.screenshot({ path: path.join(OUT, `${name}-desktop.png`), fullPage: true });
        assert.deepEqual(errors, [], 'no console errors');
        assert.equal(requests.length, before, 'no network requests');
      } finally {
        await context.close();
      }
    });
  }
});

describe('the layout check passes at phone size', () => {
  for (const file of EXAMPLES) {
    const name = path.basename(file, '.model.json');
    test(name, async () => {
      const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
      const vp = VIEWPORTS.find((v) => v.name === 'mobile');
      const { page, context, errors } = await openPage(spec, { width: vp.width, height: vp.height });
      try {
        for (const t of sampleTimes(spec)) {
          await page.evaluate((x) => { window.workingModel.setTime(x); window.workingModel.render(); }, t);
          const issues = (await page.evaluate(() => window.workingModel.layoutReport())).filter((i) => i.code.startsWith('E_'));
          assert.deepEqual(issues, [], `layout at t = ${t}`);
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 1, `no sideways scroll (${overflow}px)`);
        await page.screenshot({ path: path.join(OUT, `${name}-mobile.png`), fullPage: true });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }
});

describe('dragging a slider flips a claim, and reset restores it', () => {
  for (const f of FLIPS) {
    test(`${f.example}: ${f.param} -> ${f.claim}`, async () => {
      const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', f.example + '.model.json'), 'utf8'));
      const { page, context, errors } = await openPage(spec);
      try {
        const claim = page.locator(`[data-claim-id="${f.claim}"]`);
        assert.equal(await claim.getAttribute('data-status'), 'pass');
        const slider = page.locator(`input[type="range"][data-param="${f.param}"]`);
        await slider.focus();
        await page.keyboard.press(f.key);
        await page.waitForFunction((id) => document.querySelector(`[data-claim-id="${id}"]`).getAttribute('data-status') === 'fail', f.claim);
        const why = await claim.locator('.why').textContent();
        assert.ok(why.length > 10, 'a one-line counterexample is shown');
        const summary = await page.textContent('[data-testid="claims-summary"]');
        assert.match(summary, /^\d+\/\d+ claims pass$/);
        assert.notEqual(summary.trim(), `${spec.claims.length}/${spec.claims.length} claims pass`);
        await page.screenshot({ path: path.join(OUT, `${f.example}-flipped.png`) });
        // what the page computed equals what Node computes at the same params
        const params = await page.evaluate(() => window.workingModel.getParams());
        const { analyze } = await import('../../src/engine/index.mjs');
        const node = analyze(spec, { params, probe: false });
        const pageSummary = await page.evaluate(() => window.workingModel.getSummary());
        assert.equal(pageSummary.passed, node.passed);
        // reset brings it back
        await page.click('[data-action="reset"]');
        await page.waitForFunction((id) => document.querySelector(`[data-claim-id="${id}"]`).getAttribute('data-status') === 'pass', f.claim);
        assert.equal((await page.textContent('[data-testid="claims-summary"]')).trim(), `${spec.claims.length}/${spec.claims.length} claims pass`);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }
  test('choice buttons work like sliders (load balancing policy)', async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'load-balancing.model.json'), 'utf8'));
    const { page, context } = await openPage(spec);
    try {
      await page.click('[data-param="policy"] button[data-value="0"]');
      await page.waitForFunction(() => document.querySelector('[data-claim-id="short-queues"]').getAttribute('data-status') === 'fail');
      await page.click('[data-param="policy"] button[data-value="1"]');
      await page.waitForFunction(() => document.querySelector('[data-claim-id="short-queues"]').getAttribute('data-status') === 'pass');
    } finally {
      await context.close();
    }
  });
});

describe('layout report and clock', () => {
  const crossing = {
    title: 'Crossing link', dt: 1, duration: 10, state: { n: 0 }, rules: { tick: "n += 1\nemit('go')" },
    parts: [
      { id: 'a', type: 'box', at: [0, 0, 3, 2], label: 'A', text: '{n}' },
      { id: 'b', type: 'box', at: [4, 0, 3, 2], label: 'B', text: 'b' },
      { id: 'c', type: 'box', at: [8, 0, 3, 2], label: 'C', text: 'c' },
      { id: 'l', type: 'link', from: 'a', to: 'c', on: 'go' },
    ],
    narration: [{ from: 0, text: 'n is {n}', cites: ['up'] }],
    claims: [{ id: 'up', kind: 'always', expr: 'n >= 0', text: 'never negative' }],
  };
  // regression: an arrow drawn straight through another part passed the layout check
  test('a link drawn across another part is reported', async () => {
    const { page, context } = await openPage(crossing);
    try {
      const issues = await page.evaluate(() => window.workingModel.layoutReport());
      assert.ok(issues.some((i) => i.code === 'W_LINK_CROSSES' && /across part "b"/.test(i.message)), JSON.stringify(issues));
      const fixed = JSON.parse(JSON.stringify(crossing));
      fixed.parts[3].via = [[5.5, 2.5]];
      const { page: p2, context: c2 } = await openPage(fixed);
      try {
        const again = await p2.evaluate(() => window.workingModel.layoutReport());
        assert.ok(!again.some((i) => i.code === 'W_LINK_CROSSES'), JSON.stringify(again));
      } finally {
        await c2.close();
      }
    } finally {
      await context.close();
    }
  });
  // regression: with dt = 1 the clock rounded t = 4.5 to "t = 5 s" while showing the values of t = 4
  test('the clock names the tick whose values are shown', async () => {
    const { page, context } = await openPage(crossing);
    try {
      await page.evaluate(() => { window.workingModel.setTime(4.5); window.workingModel.render(); });
      assert.equal((await page.textContent('.wm-clock')).trim(), 't = 4 s');
      assert.equal((await page.textContent('.wm-caption-text')).trim(), 'n is 4');
    } finally {
      await context.close();
    }
  });
});

// Specs may come from strangers. Every piece of spec text must reach the page
// as text, and the CSP must refuse any script that is not one of the page's own.
describe('hostile spec text stays text', () => {
  test('markup in titles, labels, captions, claims and values is shown, never run', async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'token-bucket.model.json'), 'utf8'));
    const evil = (n) => `<img src=x onerror="window.__pwned=${n}"></script><script>window.__pwned=${n}</script>`;
    spec.title = evil(1);
    spec.summary = evil(2);
    spec.sources = [{ title: evil(3), url: 'javascript:window.__pwned=4', note: evil(5) }];
    Object.assign(spec.params[0], { label: evil(6), unit: evil(7), help: evil(8) });
    spec.state.msg = `'${evil(9)}'`;
    for (const p of spec.parts) if (p.type !== 'link') p.label = evil(10);
    spec.parts.find((p) => p.id === 'server').text = '{msg}';
    spec.parts.find((p) => p.id === 'pass').label = evil(11);
    spec.parts.find((p) => p.id === 'chart').series[0].label = evil(12);
    spec.parts.find((p) => p.id === 'chart').refs[0].label = evil(13);
    spec.narration.forEach((n) => { n.text = evil(14) + ' {msg}'; });
    spec.claims.forEach((c) => { c.text = evil(15); });
    const { page, context, errors } = await openPage(spec);
    try {
      assert.equal(await page.evaluate(() => window.__pwned), undefined);
      assert.equal(await page.evaluate(() => document.querySelectorAll('img, iframe, object, embed').length), 0);
      assert.equal(await page.evaluate(() => document.scripts.length), 3);
      assert.equal(await page.evaluate(() => document.querySelectorAll('a[href^="javascript:"]').length), 0);
      const text = await page.evaluate(() => document.body.textContent);
      assert.ok(text.includes('<img src=x onerror="window.__pwned=9">'), 'state text is shown as text');
      assert.ok(text.includes('window.__pwned=15'), 'claim text is shown as text');
      assert.equal(await page.evaluate(() => document.title.startsWith('<img')), true);
      // the policy refuses an inline script the page did not ship with
      await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.appendChild(s); });
      assert.equal(await page.evaluate(() => window.__inline), undefined);
      assert.equal(await page.evaluate(() => window.workingModel.getSummary().passed), spec.claims.length, 'the page still works');
      assert.ok(errors.every((e) => /Content Security Policy/.test(e)), errors.join('\n'));
    } finally {
      await context.close();
    }
  });
});

describe('the mutation score in the page', () => {
  test('a gallery page shows the score the CLI computes, and fits a phone', async () => {
    const file = path.join(ROOT, 'examples', 'lru-cache.model.json');
    const cli = checkFile(file, { probe: false, mutate: {} }).mutation;
    const html = fs.readFileSync(path.join(ROOT, 'gallery', 'lru-cache.html'), 'utf8');
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const vp = VIEWPORTS.find((v) => v.name === 'mobile');
    const { page, context, errors } = await openPage(spec, { width: vp.width, height: vp.height }, html);
    try {
      const shown = await page.evaluate(() => ({ text: document.querySelector('.wm-mutation').textContent, stored: window.workingModel.getSummary().mutation }));
      assert.deepEqual(shown.stored, pageMutation(cli));
      const want = pageMutation(cli);
      assert.ok(shown.text.startsWith(`Mutation score ${want.scorePercent}%`), shown.text);
      assert.match(shown.text, new RegExp(`in ${want.scored} observable ways; ${want.killed} of them made a claim fail`));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `no sideways scroll (${overflow}px)`);
      await page.screenshot({ path: path.join(OUT, 'lru-cache-mutation-mobile.png'), fullPage: true });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test('a page built without --mutate shows no score', async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'lru-cache.model.json'), 'utf8'));
    const { page, context } = await openPage(spec);
    try {
      assert.equal(await page.evaluate(() => document.querySelector('.wm-mutation')), null);
      assert.equal(await page.evaluate(() => window.workingModel.getSummary().mutation), null);
    } finally {
      await context.close();
    }
  });
});

describe('dark theme and reduced motion', () => {
  test('dark theme renders with no errors and no autoplay under reduced motion', async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'sir-epidemic.model.json'), 'utf8'));
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    try {
      await page.setContent(renderPage(spec), { waitUntil: 'load' });
      await page.waitForFunction(() => window.workingModel && window.workingModel.ready);
      await page.waitForTimeout(900);
      assert.equal(await page.evaluate(() => window.workingModel.time), 0, 'no autoplay with reduced motion');
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(bg, 'rgb(14, 19, 29)');
      await page.evaluate(() => { window.workingModel.setTime(80); window.workingModel.render(); });
      await page.screenshot({ path: path.join(OUT, 'sir-epidemic-dark.png'), fullPage: true });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
