// `working-model build`: one standalone, offline HTML page per spec.
// The engine modules are inlined as-is (imports and export keywords
// stripped, wrapped in one function), so the page runs the very code that
// `check` ran in Node.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.join(HERE, '..', 'engine');
const PAGE_DIR = path.join(HERE, '..', 'page');

// Dependency order: each module only uses names from modules above it.
export const ENGINE_FILES = ['errors', 'rng', 'lexer', 'parser', 'compile', 'format', 'model', 'simulate', 'claims', 'lint', 'index'];
const API = ['unitFor', 'analyze', 'compileModel', 'checkClaims', 'simulate', 'snapshotEnv', 'resolveParams', 'formatValue', 'formatNumber', 'explain', 'ENGINE_VERSION'];

let cachedBundle = null;

export function engineBundle() {
  if (cachedBundle) return cachedBundle;
  const seen = new Map();
  const chunks = [];
  for (const name of ENGINE_FILES) {
    const file = path.join(ENGINE_DIR, name + '.mjs');
    let src = fs.readFileSync(file, 'utf8');
    if (/^\s*import\s[^;]*$/m.test(src.replace(/^\s*import\s[^\n]*;\s*$/gm, ''))) {
      throw new Error(`${name}.mjs: imports must fit on one line for the bundler`);
    }
    src = src.replace(/^\s*import\s[^\n]*;\s*$/gm, '');
    src = src.replace(/^export\s+\{[^}]*\}(\s+from\s+[^;]+)?;\s*$/gm, '');
    src = src.replace(/^export\s+(?=(async\s+)?function\b|const\b|let\b|class\b)/gm, '');
    if (/^export\b/m.test(src)) throw new Error(`${name}.mjs: unsupported export form for the bundler`);
    // top-level names must be unique across modules
    const decl = /^(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = decl.exec(src))) {
      if (seen.has(m[1])) throw new Error(`bundler: "${m[1]}" is declared in both ${seen.get(m[1])}.mjs and ${name}.mjs`);
      seen.set(m[1], name);
    }
    chunks.push(`// ---- ${name}.mjs ----\n${src.trim()}\n`);
  }
  cachedBundle = `const WM = (function () {\n'use strict';\n${chunks.join('\n')}\nreturn { ${API.join(', ')} };\n})();\n`;
  return cachedBundle;
}

function escapeScript(s) {
  return s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

function lf(s) {
  return s.replace(/\r\n?/g, '\n');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Build the HTML text for a spec. `report` is the check report (for the
// static summary shown before the script runs).
export function renderPage(spec, opts = {}) {
  const css = fs.readFileSync(path.join(PAGE_DIR, 'page.css'), 'utf8');
  const runtime = fs.readFileSync(path.join(PAGE_DIR, 'runtime.js'), 'utf8');
  const json = JSON.stringify(spec).replace(/</g, String.fromCharCode(92) + "u003c"); // no "</script>" can end the block early
  const title = escapeHtml(spec.title || 'Working model');
  // The CSP allows exactly these two scripts by hash, not 'unsafe-inline', so
  // even if spec text ever reached the page as HTML it could not run script.
  // Line endings are normalised first: the HTML parser turns CRLF into LF
  // before the browser hashes a script, so a CRLF checkout would not match.
  const engineJs = '\n' + lf(escapeScript(engineBundle())) + '\n';
  const runtimeJs = '\n' + lf(escapeScript(runtime)) + '\n';
  const scriptSrc = [engineJs, runtimeJs].map((js) => `'sha256-${crypto.createHash('sha256').update(js, 'utf8').digest('base64')}'`).join(' ');
  const theme = opts.theme ? ` data-theme="${opts.theme === 'dark' ? 'dark' : 'light'}"` : '';
  // The mutation score is shown only when it was computed at build time
  // (build --mutate, gallery); the page never computes or invents one.
  const mutation = opts.mutation ? `<script type="application/json" id="wm-mutation">${JSON.stringify(pageMutation(opts.mutation)).replace(/</g, String.fromCharCode(92) + 'u003c')}</script>
` : '';
  return `<!doctype html>
<html lang="en"${theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${scriptSrc}; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="generator" content="working-model ${opts.version || ''}">
<title>${title} - working model</title>
<style>
${css}
</style>
</head>
<body>
<div class="wm" id="wm">
<noscript><div class="wm-error">This working model runs in your browser. Turn on JavaScript to see the animation and re-check the claims.</div></noscript>
<header class="wm-head"><div class="wm-kicker">Working model</div><h1 class="wm-title">${title}</h1></header>
</div>
<script type="application/json" id="wm-spec">${json}</script>
${mutation}<script>${engineJs}</script>
<script>${runtimeJs}</script>
</body>
</html>
`;
}

// What the page stores of a mutation report: the counts and each claim's kills.
export function pageMutation(m) {
  return {
    scorePercent: Math.floor(m.score * 100 + 1e-9), killed: m.killed + m.engine, scored: m.scored,
    tested: m.tested, total: m.total, survived: m.survived, equivalent: m.equivalent, visual: m.visual, ignored: m.ignored,
    claims: Object.fromEntries(m.claims.map((c) => [c.id, c.kills])),
  };
}

export function writePage(spec, outFile, opts = {}) {
  const html = renderPage(spec, opts);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, html);
  return { file: outFile, bytes: Buffer.byteLength(html) };
}
