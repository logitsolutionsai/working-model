// `build --trace`: the comparison page. It is the normal page (renderPage,
// unchanged) plus a "Model Versus Observed Trace" section. The engine
// script is replaced by one bundle of the same engine modules plus the
// trace modules (replay, matching, assertions), so the page re-runs the
// comparison with the very code `check --trace` ran, and shows whether its
// result equals the command line's. Default `build` never comes here.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage, engineBundle, ENGINE_FILES } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..');
export const TRACE_FILES = ['errors', 'mapping', 'match', 'assertions', 'replay', 'conformance'];
const API = ['unitFor', 'analyze', 'compileModel', 'checkClaims', 'simulate', 'snapshotEnv', 'resolveParams', 'formatValue', 'formatNumber', 'explain', 'ENGINE_VERSION',
  'validateMapping', 'evaluateReality', 'REALITY_VERSION'];

let cached = null;

// Same bundling rules as engineBundle(): one-line imports stripped, export
// keywords removed, top-level names unique across every module.
export function realityBundle() {
  if (cached) return cached;
  const seen = new Map();
  const chunks = [];
  const files = [...ENGINE_FILES.map((n) => ['engine', n]), ...TRACE_FILES.map((n) => ['trace', n])];
  for (const [dir, name] of files) {
    let src = fs.readFileSync(path.join(SRC, dir, name + '.mjs'), 'utf8');
    if (/^\s*import\s[^;]*$/m.test(src.replace(/^\s*import\s[^\n]*;\s*$/gm, ''))) throw new Error(`${dir}/${name}.mjs: imports must fit on one line for the bundler`);
    src = src.replace(/^\s*import\s[^\n]*;\s*$/gm, '');
    src = src.replace(/^export\s+\{[^}]*\}(\s+from\s+[^;]+)?;\s*$/gm, '');
    src = src.replace(/^export\s+(?=(async\s+)?function\b|const\b|let\b|class\b)/gm, '');
    if (/^export\b/m.test(src)) throw new Error(`${dir}/${name}.mjs: unsupported export form for the bundler`);
    const decl = /^(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = decl.exec(src))) {
      if (seen.has(m[1])) throw new Error(`bundler: "${m[1]}" is declared in both ${seen.get(m[1])} and ${dir}/${name}.mjs`);
      seen.set(m[1], `${dir}/${name}.mjs`);
    }
    chunks.push(`// ---- ${dir}/${name}.mjs ----\n${src.trim()}\n`);
  }
  cached = `const WM = (function () {\n'use strict';\n${chunks.join('\n')}\nreturn { ${API.join(', ')} };\n})();\n`;
  return cached;
}

function lf(s) { return s.replace(/\r\n?/g, '\n'); }
function escapeScript(s) { return s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--'); }
function hash(js) { return `'sha256-${crypto.createHash('sha256').update(js, 'utf8').digest('base64')}'`; }
function jsonBlock(v) {
  const bs = String.fromCharCode(92); // a backslash, built at run time so no escaping layer can eat it
  return JSON.stringify(v).replace(/</g, bs + 'u003c').replace(/\u2028/g, bs + 'u2028').replace(/\u2029/g, bs + 'u2029');
}

// data: { trace (normalized), mapping (raw), report (from check --trace), params }
export function renderRealityPage(spec, data, opts = {}) {
  const base = renderPage(spec, opts);
  const engineJs = '\n' + lf(escapeScript(engineBundle())) + '\n';
  const bundleJs = '\n' + lf(escapeScript(realityBundle())) + '\n';
  const panelJs = '\n' + lf(escapeScript(fs.readFileSync(path.join(SRC, 'page', 'reality-panel.js'), 'utf8'))) + '\n';
  const css = fs.readFileSync(path.join(SRC, 'page', 'reality.css'), 'utf8');
  const engineTag = `<script>${engineJs}</script>`;
  if (!base.includes(engineTag) || !base.includes(hash(engineJs))) throw new Error('renderPage output changed shape; the comparison page cannot be assembled');
  // the page embeds only what replay and matching read: no private block, no source path
  const trace = { schemaVersion: 1, kind: 'working-model-trace', timeBase: 'relative-ms', completeness: data.trace.completeness, events: data.trace.events };
  const payload = { trace, mapping: data.mapping, report: data.report, params: data.params || {} };
  // function replacers: the bundle holds "$" sequences that a string replacement would expand
  let html = base
    .replace(hash(engineJs), () => `${hash(bundleJs)} ${hash(panelJs)}`)
    .replace(engineTag, () => `<script>${bundleJs}</script>`)
    .replace('</style>\n</head>', () => `${css}\n</style>\n</head>`)
    .replace('<script type="application/json" id="wm-spec">', () => `<section class="wm wmr" id="wmr" aria-labelledby="wmr-title"><noscript>The comparison runs in your browser.</noscript></section>
<script type="application/json" id="wm-reality">${jsonBlock(payload)}</script>
<script type="application/json" id="wm-spec">`)
    .replace('</body>', () => `<script>${panelJs}</script>
</body>`);
  html = html.replace(/<title>([^<]*) - working model<\/title>/, '<title>$1 - model versus observed</title>');
  return html;
}

export function writeRealityPage(spec, data, outFile, opts = {}) {
  const html = renderRealityPage(spec, data, opts);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, html);
  return { file: outFile, bytes: Buffer.byteLength(html) };
}
