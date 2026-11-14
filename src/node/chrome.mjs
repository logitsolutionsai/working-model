// Find and drive a locally installed Chrome, Edge or Chromium over the
// DevTools protocol, using Node's built-in WebSocket. No browser download,
// no npm package. Chrome listens on 127.0.0.1 with a random port and uses a
// throwaway profile that is deleted on close.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function findChrome() {
  const env = process.env.WORKING_MODEL_CHROME;
  if (env) {
    if (fs.existsSync(env) && fs.statSync(env).isFile()) return env;
    throw new Error(`WORKING_MODEL_CHROME points at ${env}, which ${fs.existsSync(env) ? 'is a folder, not a program' : 'does not exist'}. Set it to the Chrome, Edge or Chromium executable, or unset it to search the usual places.`);
  }
  const cands = [];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA, 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean);
    for (const r of roots) {
      cands.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      cands.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      cands.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      cands.push(path.join(base, 'Google Chrome.app/Contents/MacOS/Google Chrome'));
      cands.push(path.join(base, 'Chromium.app/Contents/MacOS/Chromium'));
      cands.push(path.join(base, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
      cands.push(path.join(base, 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'));
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']) {
      try {
        const p = execFileSync('which', [name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (p) cands.push(p);
      } catch { /* not on PATH */ }
    }
    cands.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  throw new Error('No Chrome, Edge or Chromium found. Install one, or set WORKING_MODEL_CHROME to its executable.');
}

export async function launch(opts = {}) {
  if (typeof WebSocket === 'undefined') throw new Error('this needs Node 22 or newer (built-in WebSocket)');
  const exe = opts.executablePath || findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'working-model-chrome-'));
  const args = [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', '--metrics-recording-only',
    '--mute-audio', '--hide-scrollbars', '--disable-gpu', '--force-color-profile=srgb', 'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const hint = process.env.WORKING_MODEL_CHROME ? ' Is WORKING_MODEL_CHROME set to Chrome, Edge or Chromium?' : '';
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${exe} did not start a DevTools session within 20 s.${hint}`)), 20000);
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${exe} exited early (code ${code}): ${buf.slice(0, 400)}${hint}`)); });
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`cannot start ${exe}: ${e.code || e.message}.${hint}`)); });
  }).catch((e) => {
    // do not leave the process or its throwaway profile behind
    try { proc.kill(); } catch { /* already gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    throw e;
  });
  const browser = new Browser(proc, profile, wsUrl);
  await browser.connect();
  return browser;
}

class Browser {
  constructor(proc, profile, wsUrl) {
    this.proc = proc;
    this.profile = profile;
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error('DevTools connection failed: ' + (e.message || 'error')));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: ok, reject: no } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) no(new Error(msg.error.message)); else ok(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners) l(msg);
        }
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  async newPage(opts = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.init(opts);
    return page;
  }
  async close() {
    try { await Promise.race([this.send('Browser.close'), new Promise((r) => setTimeout(r, 3000))]); } catch { /* already closing */ }
    try { this.ws.close(); } catch { /* ignore */ }
    await new Promise((r) => {
      if (this.proc.exitCode != null) return r();
      const t = setTimeout(() => { try { this.proc.kill(); } catch { /* ignore */ } r(); }, 4000);
      this.proc.once('exit', () => { clearTimeout(t); r(); });
    });
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(this.profile, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  }
}

class Page {
  constructor(browser, sessionId, targetId) {
    this.b = browser;
    this.sid = sessionId;
    this.targetId = targetId;
    this.errors = [];
    this.requests = [];
    this.waiters = [];
    browser.listeners.add((msg) => {
      if (msg.sessionId !== this.sid) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push((d.exception && d.exception.description) || d.text);
      } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
        this.errors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(msg.params.entry.text);
      } else if (msg.method === 'Network.requestWillBeSent') {
        const u = msg.params.request.url;
        if (!/^(file|data|about):/.test(u)) this.requests.push(u);
      }
      for (const w of this.waiters.slice()) if (w.method === msg.method) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg.params); }
    });
  }
  send(method, params) { return this.b.send(method, params, this.sid); }
  waitFor(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const w = { method, resolve };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('timed out waiting for ' + method)); } }, timeout);
    });
  }
  async init(opts) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    await this.setViewport(opts.width || 1280, opts.height || 800);
    await this.setColorScheme(opts.colorScheme || 'light', opts.reducedMotion);
  }
  async setViewport(width, height) {
    this.width = width;
    this.height = height;
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  }
  async setColorScheme(scheme, reducedMotion) {
    const features = [{ name: 'prefers-color-scheme', value: scheme }];
    if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
    await this.send('Emulation.setEmulatedMedia', { features });
  }
  async open(file) {
    const url = pathToFileURL(path.resolve(file)).href + '#still';
    const loaded = this.waitFor('Page.loadEventFired', 20000);
    await this.send('Page.navigate', { url });
    await loaded;
    await this.waitForFunction('window.workingModel && window.workingModel.ready');
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page error: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitForFunction(expression, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.evaluate(`!!(${expression})`)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out waiting for ' + expression);
  }
  async nextFrame() {
    await this.evaluate('new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); })');
  }
  async screenshot(file, opts = {}) {
    const params = { format: 'png', captureBeyondViewport: !!opts.fullPage };
    if (opts.clip) params.clip = { ...opts.clip, scale: 1 };
    else if (opts.fullPage) {
      const h = await this.evaluate('Math.ceil(document.documentElement.scrollHeight)');
      params.clip = { x: 0, y: 0, width: this.width, height: h, scale: 1 };
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    const buf = Buffer.from(data, 'base64');
    if (file) {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, buf);
    }
    return buf;
  }
  async rect(selector) {
    return this.evaluate(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height};})()`);
  }
}
