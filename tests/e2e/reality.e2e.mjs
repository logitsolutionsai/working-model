// End-to-end: the build --trace comparison page in the installed Chrome with
// every request aborted. The browser re-runs replay, matching and the
// assertions with the bundled modules and must agree with Node; the page is
// responsive, keyboard reachable, themed, offline, and inert to markup in
// trace, mapping and spec text.
// Run with: npm run test:e2e   (needs playwright-core and a local Chrome or Edge)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../../src/node/chrome.mjs';
import { checkWithTrace, readJSONFile } from '../../src/node/reality.mjs';
import { renderRealityPage } from '../../src/node/build-reality.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RB = path.join(ROOT, 'examples', 'reality-bridge');
const OUT = path.join(ROOT, 'tests', 'output', 'e2e');

let browser;

function pageFor(specFile, traceFile, mapFile, mutate) {
  const { report, check, trace } = checkWithTrace(specFile, { trace: traceFile, mapping: mapFile, probe: false });
  const mapping = readJSONFile(mapFile, 'mapping');
  const spec = check.spec;
  if (mutate) mutate({ spec, trace, mapping, report });
  return { html: renderRealityPage(spec, { trace, mapping, report }), report };
}

async function open(html, opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, colorScheme: opts.colorScheme || 'light', reducedMotion: opts.reducedMotion || 'no-preference' });
  const requests = [];
  await context.route('**/*', (route) => { requests.push(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForFunction(() => window.workingModel && window.workingModel.ready && window.workingModelReality && window.workingModelReality.ready);
  return { page, context, errors, requests };
}

before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--disable-gpu', '--disable-background-networking', '--disable-component-update'] });
});
after(async () => { if (browser) await browser.close(); });

describe('the comparison page', () => {
  const cases = [
    ['circuit-breaker.model.json', 'observed.normalized.json', 'fail'],
    ['circuit-breaker.model.json', 'observed-unknown.normalized.json', 'inconclusive'],
    ['circuit-breaker-window.model.json', 'observed.normalized.json', 'pass'],
  ];
  for (const [specName, traceName, status] of cases) {
    test(`${specName} with ${traceName}: the browser agrees with Node event for event`, async () => {
      const { html, report } = pageFor(path.join(RB, specName), path.join(RB, traceName), path.join(RB, 'trace-map.json'));
      assert.equal(report.status, status);
      const { page, context, errors, requests } = await open(html);
      try {
        const r = await page.evaluate(() => ({ parity: window.workingModelReality.parity, browser: window.workingModelReality.browser, node: window.workingModelReality.node, status: window.workingModelReality.status, line: document.getElementById('wmr-line').textContent, parityText: document.getElementById('wmr-parity').textContent, claims: window.workingModel.summary ? window.workingModel.summary() : null }));
        assert.equal(r.parity, true, 'browser and Node differ');
        assert.deepEqual(r.browser, r.node);
        assert.equal(r.status, status);
        assert.match(r.line, new RegExp(`Model: ${report.modelClaims.passed}/${report.modelClaims.total} claims pass \\| Observed: ${report.observedAssertions.passed} pass, ${report.observedAssertions.failed} fail, ${report.observedAssertions.inconclusive} inconclusive`));
        assert.match(r.parityText, /same result as the command line/);
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
        const firstChip = await page.$('[data-first-mismatch]');
        assert.equal(!!firstChip, status === 'fail');
        // nothing uses red: every status chip is an ink level
        const reds = await page.evaluate(() => [...document.querySelectorAll('#wmr *')].filter((el) => {
          const cs = getComputedStyle(el);
          return [cs.color, cs.backgroundColor, cs.fill, cs.stroke].some((v) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(v || ''); return m && Number(m[1]) > 150 && Number(m[2]) < 90 && Number(m[3]) < 90; });
        }).length);
        assert.equal(reds, 0, 'a red colour is used in the comparison section');
      } finally { await context.close(); }
    });
  }

  test('keyboard: Jump to first mismatch moves the cursor there; arrows step one tick', async () => {
    const { html } = pageFor(path.join(RB, 'circuit-breaker.model.json'), path.join(RB, 'observed.normalized.json'), path.join(RB, 'trace-map.json'));
    const { page, context, errors } = await open(html, { reducedMotion: 'reduce' });
    try {
      const btn = page.getByRole('button', { name: 'Jump to first mismatch' });
      await btn.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => window.workingModelReality.cursor()), 1800);
      await page.locator('.wmr-svg').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => window.workingModelReality.cursor()), 1850);
      const at = await page.evaluate(() => [...document.querySelectorAll('.wmr-at td')].map((td) => td.textContent));
      assert.ok(at.includes('not observed'));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  test('390, 768 and 1440 px wide: no sideways scroll; dark theme follows the system', async () => {
    const { html } = pageFor(path.join(RB, 'circuit-breaker.model.json'), path.join(RB, 'observed.normalized.json'), path.join(RB, 'trace-map.json'));
    for (const width of [390, 768, 1440]) {
      const { page, context } = await open(html, { viewport: { width, height: 900 }, colorScheme: width === 390 ? 'dark' : 'light' });
      try {
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, fill: getComputedStyle(document.querySelector('.wmr-obs')).fill }));
        assert.ok(m.sw <= m.cw + 1, `${width}px: the page scrolls sideways (${m.sw} > ${m.cw})`);
        if (width === 390) {
          assert.match(m.fill, /rgb\(244, 244, 242\)/, 'dark ink for observed marks');
          await page.screenshot({ path: path.join(OUT, 'reality-mobile-dark.png'), fullPage: true });
        } else if (width === 1440) await page.screenshot({ path: path.join(OUT, 'reality-desktop.png'), fullPage: true });
      } finally { await context.close(); }
    }
  });

  test('markup in spec, mapping and trace text is shown as text and runs nothing', async () => {
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    const { html } = pageFor(path.join(RB, 'circuit-breaker.model.json'), path.join(RB, 'observed.normalized.json'), path.join(RB, 'trace-map.json'), ({ spec, trace, mapping, report }) => {
      spec.title = 'Breaker ' + evil;
      spec.reality.assumptions[0].text = evil;
      spec.reality.sourceRefs[0].url = 'https://example.com/"><img src=x onerror="window.__xss=3">';
      mapping.assertions[0].text = evil;
      trace.events[0].subject = evil.slice(0, 200);
      trace.events.push({ id: 'ev-99999', timeMs: 25000, kind: evil.slice(0, 60), attrs: {} });
      report.assumptions = spec.reality.assumptions;
      report.sourceRefs = spec.reality.sourceRefs;
    });
    const { page, context, requests } = await open(html);
    try {
      const r = await page.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll('img').length, text: document.getElementById('wmr').textContent.includes('<img src=x') }));
      assert.equal(r.xss, undefined);
      assert.equal(r.imgs, 0);
      assert.equal(r.text, true, 'the markup is visible as text');
      assert.deepEqual(requests, []);
    } finally { await context.close(); }
  });
});
