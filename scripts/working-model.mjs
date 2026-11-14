#!/usr/bin/env node
// working-model: check, build and capture explainers whose claims are tests.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile, listSpecFiles, formatReport, formatMutation, mutationLine, reportToJSON, summaryLine, color, EXIT } from '../src/node/check.mjs';
import { writePage } from '../src/node/build.mjs';
import { buildSchema } from '../src/node/schema.mjs';
import { scaffold } from '../src/node/scaffold.mjs';
import { prettyJSON } from '../src/node/pretty-json.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const HELP = `working-model ${VERSION}

Usage:
  working-model check <spec|dir> [--json] [--strict] [--set name=value] [--no-probe]
                     [--mutate[=200]] [--mutate-strict] [--min-score 80] [--mutate-seed s]
  working-model build <spec> [-o page.html] [--force] [--mutate[=200]]
  working-model new <name> [--dir <folder>] [--force]
  working-model gallery [--examples examples] [--out gallery] [--thumbs]
  working-model layout <spec|dir> [--out <folder for screenshots>] [--json]
  working-model snap <spec> [--at <time>] -o file.png [--set name=value] [--width 1280] [--height 800]
                     [--theme light|dark] [--clip viewport|page|diagram|stage]
  working-model gif <spec> -o file.gif [--seconds 8] [--fps 10] [--from 0] [--to <time>]
                     [--drag name=a..b@s0..s1] [--set name=value] [--clip ...] [--max-mb 3]
  working-model schema [-o schema/model.schema.json]

Exit codes: 0 all claims pass, 1 a claim or lint error fails, 2 the spec is invalid, 64 usage.
--mutate breaks the rules on purpose, one small change per mutant, and reports which claims notice.
--mutate-strict also exits 1 when a claim never fails or the score is below --min-score (percent).
Chrome: layout, snap and gif use an installed Chrome, Edge or Chromium (set WORKING_MODEL_CHROME to choose).`;

function parseArgs(argv) {
  const out = { _: [], set: [], drag: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out' || a === '--output') out.out = argv[++i];
    else if (a === '--set') out.set.push(argv[++i]);
    else if (a === '--drag') out.drag.push(argv[++i]);
    else if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      out[a.slice(2, eq).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (['json', 'strict', 'force', 'thumbs', 'noProbe', 'noColor', 'help', 'version', 'full', 'mutate', 'mutateStrict'].includes(key)) out[key] = true;
      else if (next != null && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function parseSetMap(sets) {
  const o = {};
  for (const s of sets) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(-?[\d.]+(?:e-?\d+)?)$/.exec(s || '');
    if (!m) usage(`--set expects name=number, got "${s}"`);
    o[m[1]] = Number(m[2]);
  }
  return o;
}

// --mutate, --mutate=200, --mutate-strict, --min-score 80, --mutate-seed 7
function mutateOptions(args) {
  if (!args.mutate && !args.mutateStrict) return null;
  const o = { strict: !!args.mutateStrict };
  if (args.mutate != null && args.mutate !== true) {
    const n = Number(args.mutate);
    if (!(Number.isInteger(n) && n > 0)) usage(`--mutate expects a whole number of mutants, got "${args.mutate}"`);
    o.cap = n;
  }
  if (args.minScore != null) {
    const n = Number(String(args.minScore).replace(/%$/, ''));
    if (!Number.isFinite(n) || n < 0 || n > 100) usage(`--min-score expects a percentage from 0 to 100, got "${args.minScore}"`);
    o.minScore = n;
  }
  if (args.mutateSeed != null && args.mutateSeed !== true) o.seed = /^\d+$/.test(args.mutateSeed) ? Number(args.mutateSeed) : args.mutateSeed;
  return o;
}

function usage(msg) {
  if (msg) process.stderr.write(msg + '\n\n');
  process.stderr.write(HELP + '\n');
  process.exit(EXIT.USAGE);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.version) { console.log(VERSION); return EXIT.OK; }
  if (!cmd || args.help || cmd === 'help') { console.log(HELP); return cmd ? EXIT.OK : EXIT.USAGE; }
  const c = color(!args.json && !args.noColor && !process.env.NO_COLOR && process.stdout.isTTY);

  switch (cmd) {
    case 'check': {
      const target = args._[1];
      if (!target) usage('check needs a spec file or a folder');
      if (!fs.existsSync(target)) usage(`no such file: ${target}`);
      const files = listSpecFiles(target);
      const params = parseSetMap(args.set);
      const mutate = mutateOptions(args);
      let exit = EXIT.OK;
      const reports = [];
      for (const f of files) {
        const r = checkFile(f, { strict: args.strict, params, probe: !args.noProbe, mutate });
        reports.push(r);
        // a misspelt --set name used to be ignored without a word
        if (r.model) {
          const known = r.model.params.map((p) => p.id);
          for (const k of Object.keys(params)) {
            if (!known.includes(k)) process.stderr.write(`warning: --set ${k}: ${path.basename(f)} has no param "${k}" (params: ${known.join(', ') || 'none'})\n`);
          }
        }
        exit = Math.max(exit, r.exit);
        if (!args.json) console.log(formatReport(r, c) + (r.mutation ? '\n\n' + formatMutation(r, c) : '') + '\n');
      }
      if (args.json) {
        const data = reports.map(reportToJSON);
        console.log(JSON.stringify(files.length === 1 && fs.statSync(target).isFile() ? data[0] : data, null, 2));
      } else if (files.length > 1) {
        const ok = reports.filter((r) => r.exit === EXIT.OK).length;
        console.log(c.bold(`${ok}/${files.length} specs pass`));
      }
      return exit;
    }
    case 'build': {
      const file = args._[1];
      if (!file) usage('build needs a spec file');
      const r = checkFile(file, { probe: false, mutate: mutateOptions(args) });
      if (r.errors.length) {
        console.error(formatReport(r, c));
        return EXIT.INVALID;
      }
      const lintErrors = (r.lint || []).filter((i) => i.severity === 'error');
      const out = args.out || file.replace(/\.model\.json$/, '').replace(/\.json$/, '') + '.html';
      if ((r.passed !== r.total || lintErrors.length) && !args.force) {
        console.error(formatReport(r, c));
        console.error(c.red('\nNot building: fix the failing claims first, or pass --force to build anyway.'));
        return EXIT.CLAIMS;
      }
      const mutation = r.mutation && r.mutation.ok ? r.mutation : null;
      const w = writePage(r.spec, out, { version: VERSION, mutation });
      console.log(`${c.green('built')} ${w.file} (${Math.round(w.bytes / 1024)} KB, offline, ${summaryLine(r)}${mutation ? ', ' + mutationLine(mutation) : ''})`);
      return r.passed === r.total ? EXIT.OK : EXIT.CLAIMS;
    }
    case 'new': {
      const name = args._[1];
      if (!name) usage('new needs a name');
      const spec = scaffold(name);
      const dir = args.dir || '.';
      const file = path.join(dir, spec.id + '.model.json');
      if (fs.existsSync(file) && !args.force) { console.error(`${file} already exists (use --force to overwrite)`); return EXIT.USAGE; }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, prettyJSON(spec));
      console.log(`created ${file}\nnext: working-model check ${/\s/.test(file) ? `"${file}"` : file}`);
      return EXIT.OK;
    }
    case 'schema': {
      const out = args.out || path.join(ROOT, 'schema', 'model.schema.json');
      fs.writeFileSync(out, JSON.stringify(buildSchema(), null, 2) + '\n');
      console.log(`wrote ${out}`);
      return EXIT.OK;
    }
    case 'gallery': {
      const { buildGallery } = await import('../src/node/gallery.mjs');
      const g = await buildGallery({ examples: args.examples || path.join(ROOT, 'examples'), out: args.out || path.join(ROOT, 'gallery'), thumbs: args.thumbs });
      for (const p of g.problems) console.error(c.red(`problem: ${p.file}: ${p.summary}`));
      console.log(`${c.green('gallery')} ${path.join(g.out, 'index.html')} (${g.cards} models)`);
      return g.problems.length ? EXIT.CLAIMS : EXIT.OK;
    }
    case 'layout': {
      const target = args._[1];
      if (!target) usage('layout needs a spec file or a folder');
      const { layoutCheck } = await import('../src/node/capture.mjs');
      const { launch } = await import('../src/node/chrome.mjs');
      const files = listSpecFiles(target);
      const browser = await launch();
      let exit = EXIT.OK;
      const all = [];
      try {
        for (const f of files) {
          const r = await layoutCheck(f, { outDir: args.out, browser });
          all.push(r);
          if (!r.ok) exit = EXIT.CLAIMS;
          if (!args.json) {
            console.log(c.bold(path.basename(f)));
            for (const vp of r.viewports) {
              const errs = vp.issues.filter((i) => i.code.startsWith('E_'));
              const warns = vp.issues.filter((i) => !i.code.startsWith('E_'));
              console.log(`  ${errs.length ? c.red('FAIL') : c.green('PASS')}  ${vp.name} ${vp.width}x${vp.height}${warns.length ? c.yellow(`  (${warns.length} warning${warns.length === 1 ? '' : 's'})`) : ''}`);
              for (const i of vp.issues) console.log(`        ${i.code.startsWith('E_') ? c.red(i.code) : c.yellow(i.code)} ${i.message}${i.t != null ? c.dim(` at t = ${Math.round(i.t * 1000) / 1000}`) : ''}`);
            }
            for (const s of r.screenshots) console.log(c.dim(`  screenshot ${s}`));
          }
        }
      } finally {
        await browser.close();
      }
      if (args.json) console.log(JSON.stringify(files.length === 1 ? all[0] : all, null, 2));
      return exit;
    }
    case 'snap': {
      const file = args._[1];
      if (!file || !args.out) usage('snap needs a spec and -o file.png');
      const { snap } = await import('../src/node/capture.mjs');
      const r = await snap(file, { at: args.at, out: args.out, set: args.set, width: args.width ? Number(args.width) : undefined, height: args.height ? Number(args.height) : undefined, theme: args.theme, clip: args.clip });
      for (const e of r.errors) console.error(c.red('page error: ') + e);
      console.log(`${c.green('snap')} ${r.file} at t = ${Math.round(r.t * 1000) / 1000}`);
      return r.errors.length ? EXIT.CLAIMS : EXIT.OK;
    }
    case 'gif': {
      const file = args._[1];
      if (!file || !args.out) usage('gif needs a spec and -o file.gif');
      const { gif } = await import('../src/node/capture.mjs');
      const r = await gif(file, {
        out: args.out, seconds: args.seconds ? Number(args.seconds) : undefined, fps: args.fps ? Number(args.fps) : undefined,
        from: args.from, to: args.to, drag: args.drag, set: args.set, clip: args.clip, theme: args.theme,
        width: args.width ? Number(args.width) : undefined, height: args.height ? Number(args.height) : undefined,
        maxMb: args.maxMb ? Number(args.maxMb) : undefined, scale: args.scale ? Number(args.scale) : undefined, hold: args.hold,
      });
      console.log(`${c.green('gif')} ${r.file} (${(r.bytes / 1024 / 1024).toFixed(2)} MB, ${r.frames} frames)`);
      return EXIT.OK;
    }
    default:
      usage(`unknown command "${cmd}"`);
  }
  return EXIT.USAGE;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`working-model: ${e && e.message ? e.message : e}\n`);
  if (e && e.report) process.stderr.write(formatReport(e.report, color(false)) + '\n');
  process.exitCode = EXIT.INVALID;
});
