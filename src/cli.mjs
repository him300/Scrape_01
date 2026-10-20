#!/usr/bin/env node
// Scrape_01 CLI.  Ordered, restartable, self-repairing CSV datasets.

import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadDatasets, loadDatasetFile, columnNames, writeDatasetFile, validateDataset, setDatasetOrder } from './config.mjs';
import { runDataset, rebuildDataset, makeClient } from './pipeline.mjs';
import { datasetPaths, listDatasets, readJson, loadState, acquireLock, removeDataset } from './store.mjs';
import { verifyCsv, parseCsv } from './csvio.mjs';
import { detectTimeKind } from './timeorder.mjs';
import { createLogger } from './log.mjs';
import { parseDoc } from './dom.mjs';
import { extractPage } from './extract.mjs';
import { piAvailable, planDatasetWithPi, runPi } from './agent.mjs';
import { repairFlowJob } from './repair-job.mjs';
import { createFlowJob } from './create-job.mjs';
import { findBrowser } from './render.mjs';
import { describeProfile, getProfile, MIN_DELAY_FLOOR_MS as MIN_DELAY } from './profile.mjs';

const VERSION = '1.0.0';

// ------------------------------------------------------------------ argv

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) { flags[k] = inline; continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) flags[k] = true;
      else { flags[k] = next; i++; }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const short = { f: 'force', n: 'dry-run', a: 'all', q: 'quiet', d: 'debug', h: 'help' };
      const key = short[a.slice(1)] || a.slice(1);
      flags[key] = true;
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

function parseDuration(s) {
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(String(s).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return Math.round(n * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]));
}

function fmtDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)}${u[i]}`;
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const nowIso = () => new Date().toISOString();

// -------------------------------------------------------------------- ctx

async function makeContext(flags) {
  const root = path.resolve(flags.root || process.env.SCRAPE01_ROOT || process.env.PIDU_ROOT || process.cwd());
  const log = createLogger({
    dir: path.join(root, '.scrape01', 'logs'),
    level: flags.debug ? 'debug' : flags.quiet ? 'warn' : 'info',
    console: !flags['no-console'],
  });
  let datasets = [];
  try { datasets = await loadDatasets(path.join(root, 'datasets')); } catch (err) { if (!/no dataset configs/.test(err.message)) throw err; }
  return { root, log, datasets, flags };
}

function pickDatasets(datasets, names) {
  if (!names.length) return datasets;
  const out = [];
  for (const n of names) {
    const d = datasets.find((x) => x.name === n);
    if (!d) throw new Error(`unknown dataset "${n}" (have: ${datasets.map((x) => x.name).join(', ') || 'none'})`);
    out.push(d);
  }
  return out;
}

const RUN_OPTS = (flags) => ({
  force: !!flags.force,
  fresh: !!flags.fresh,
  dryRun: !!flags['dry-run'],
  cacheTtlSec: flags['cache-ttl'] !== undefined ? Number(flags['cache-ttl']) : 3600,
  minDelayMs: flags.delay !== undefined ? Number(flags.delay) : undefined,
  retries: flags.retries !== undefined ? Number(flags.retries) : undefined,
  timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) : undefined,
  maxPages: flags['max-pages'] !== undefined ? Number(flags['max-pages']) : null,
  monster: !!flags.monster,
  respectRobots: !!flags['respect-robots'],
});

// ---------------------------------------------------------------- commands

async function cmdInit(positionals, flags) {
  const root = path.resolve(flags.root || positionals[0] || process.cwd());
  for (const dir of ['datasets', 'data', '.scrape01/logs', '.scrape01/cache']) await mkdir(path.join(root, dir), { recursive: true });
  const readme = path.join(root, 'README.md');
  if (!existsSync(readme)) {
    await writeFile(readme, `# Scrape_01 workspace

## Layout
- \`datasets/*.json\`  declared column order + extractors (the schema)
- \`data/<name>/raw.jsonl\`  append-only source of truth
- \`data/<name>/<name>.csv\`  derived, ordered CSV
- \`data/<name>/state.json\`  checkpoints (resume point per source)
- \`data/<name>/manifest.json\`  header lock + content hash

## Use
    scrape01 new mydata --url https://example.com/list --goal "product name, price, stock"
    scrape01 run mydata
    scrape01 status
    scrape01 loop --interval 6h        # durable: run forever, one pass at a time
`, 'utf8');
  }
  console.log(`initialised Scrape_01 workspace at ${root}`);
  console.log('next: scrape01 new <name> --url <https://...> [--goal "..."]');
}

async function cmdDoctor(positionals, flags, ctx) {
  const { root, log, datasets } = ctx;
  const checks = [];
  const push = (name, ok, detail) => checks.push([ok === 'warn' ? 'warn' : ok ? 'ok' : 'FAIL', name, detail]);

  push('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, `v${process.versions.node}`);
  const pi = await piAvailable();
  push('pi agent on PATH', pi.available, pi.available ? pi.version : `not found (${process.env.PI_BIN || 'pi'}) — agentic repair disabled`);
  const browser = findBrowser();
  push('js renderer (monster mode)', browser ? true : 'warn', browser || 'no Chrome/Edge/Chromium found — set SCRAPE01_BROWSER (monster mode falls back to raw HTML)');

  const dirs = ['datasets', 'data', '.scrape01'];
  for (const d of dirs) push(`dir ${d}`, existsSync(path.join(root, d)), path.join(root, d));

  push('dataset configs', datasets.length > 0 ? true : 'warn', datasets.length ? datasets.map((d) => d.name).join(', ') : 'none yet — create one with: scrape01 new <name> --url <https://…>');

  for (const cfg of datasets) {
    const paths = datasetPaths(root, cfg.name);
    const manifest = await readJson(paths.manifest, null);
    const st = await loadState(paths);
    const doneSources = cfg.sources.filter((s) => st.sources?.[s.id]?.done).length;
    push(`  ${cfg.name}`, true, `${cfg.columns.length} cols, ${cfg.sources.length} sources (${doneSources} complete), ${manifest ? `${manifest.rows} rows in csv` : 'no csv yet'}`);
    for (const s of cfg.sources) {
      const err = st.sources?.[s.id]?.error;
      if (err) push(`    ${s.id}`, false, err);
    }
  }

  // connectivity probe (robots.txt, one host, cheap)
  try {
    const client = makeClient(root, { minDelayMs: 0, cacheTtlSec: 0 }, () => {});
    const probe = await client.get('https://example.com/', { retries: 1, timeoutMs: 15000, cacheTtlSec: 0 });
    push('network', probe.status === 200, `example.com -> ${probe.status}, ${fmtBytes(probe.body.length)}`);
  } catch (err) {
    push('network', false, String(err.message || err));
  }

  console.log(table(['state', 'check', 'detail'], checks));
  return checks.every((c) => c[0] !== 'FAIL');
}

async function cmdNew(positionals, flags, ctx) {
  const { root, log, datasets } = ctx;
  const name = positionals[0];
  const url = flags.url;
  const monster = !!flags.monster;
  if (!name || !url) throw new Error('usage: scrape01 new <name> --url <https://...> [--goal "fields"] [--model x] [--monster]');

  const out = await createFlowJob({ root, url, goal: flags.goal, name, model: flags.model || null, monster, params: flags, ctx, log });
  const cfg = out.cfg;
  const verification = [{ source: cfg.sources[0]?.id || 'main', rows: out.verification.rows, sample: out.verification.sample?.[0] || null }];
  log.info({ msg: 'dataset created', file: path.relative(root, out.file), columns: cfg.columns.map((c) => c.name) });
  console.log(table(['source', 'rows on page 1'], verification.map((v) => [v.source, v.rows])));
  if (out.goal) console.log(`goal check: ${out.goal}`);
  console.log(`\nsample record:\n${JSON.stringify(verification[0].sample, null, 2)}`);
  console.log(`\nnext: scrape01 run ${name}`);
  return true;
}

async function cmdRun(positionals, flags, ctx) {
  const { root, log, datasets } = ctx;
  const targets = pickDatasets(datasets, flags.all ? [] : positionals);
  if (!targets.length) throw new Error('no datasets to run (create one with `scrape01 new`)');
  const results = [];
  for (const cfg of targets) {
    try {
      const summary = await runDataset(cfg, { root, log, ...RUN_OPTS(flags) });
      results.push({ name: cfg.name, ok: true, summary });
      if (flags['auto-repair'] && summary.drift.length) {
        for (const sid of summary.drift) await repairFlow(cfg, sid, flags, ctx, { auto: true });
      }
    } catch (err) {
      if (err.code === 'LOCKED') { log.warn({ msg: 'skipped (locked)', dataset: cfg.name, error: err.message }); results.push({ name: cfg.name, ok: false, error: err.message }); continue; }
      log.error({ msg: 'dataset failed', dataset: cfg.name, error: String(err.message || err) });
      results.push({ name: cfg.name, ok: false, error: String(err.message || err) });
      if (!flags.continue) break;
    }
  }
  const rows = results.map((r) => [r.name, r.ok ? 'ok' : 'FAIL', r.summary?.newRows ?? '-', r.summary?.totalRows ?? '-', r.summary?.duplicates ?? '-', r.summary?.rejected ?? '-', r.error || (r.summary?.drift?.length ? 'drift: ' + r.summary.drift.join(',') : '')]);
  console.log('\n' + table(['dataset', 'result', 'new', 'total', 'dupes', 'rejected', 'note'], rows));
  return results.every((r) => r.ok);
}

async function cmdRebuild(positionals, flags, ctx) {
  const { root, log, datasets } = ctx;
  const targets = pickDatasets(datasets, flags.all ? [] : positionals);
  for (const cfg of targets) {
    const { manifest } = await rebuildDataset(cfg, { root, log });
    const v = await verifyCsv(datasetPaths(root, cfg.name));
    console.log(`${cfg.name}: ${manifest.rows} rows -> ${path.relative(root, datasetPaths(root, cfg.name).csv)} ${v.ok ? '(verified)' : '(VERIFY FAILED: ' + v.problems.join('; ') + ')'}`);
  }
  return true;
}

async function cmdStatus(positionals, flags, ctx) {
  const { root, datasets } = ctx;
  const names = datasets.length ? datasets.map((d) => d.name) : await listDatasets(root);
  const rows = [];
  for (const name of names) {
    const cfg = datasets.find((d) => d.name === name);
    const paths = datasetPaths(root, name);
    const manifest = await readJson(paths.manifest, null);
    const st = await loadState(paths);
    const sources = cfg ? cfg.sources.map((s) => {
      const sd = st.sources?.[s.id] || {};
      return `${s.id}:${sd.done ? 'done' : sd.page ? `p${sd.page}` : 'new'}${sd.drift ? '!' : ''}`;
    }).join(' ') : '-';
    const lastErr = cfg ? cfg.sources.map((s) => st.sources?.[s.id]?.error).filter(Boolean)[0] : null;
    rows.push([
      name,
      manifest ? manifest.rows : 0,
      cfg ? cfg.columns.length : '?',
      sources,
      st.lastRun ? new Date(st.lastRun).toISOString().slice(0, 16).replace('T', ' ') : 'never',
      manifest ? fmtBytes(manifest.bytes) : '-',
      lastErr ? String(lastErr).slice(0, 40) : '',
    ]);
  }
  if (!rows.length) { console.log('no datasets yet. try: scrape01 new <name> --url <https://...>'); return true; }
  console.log(table(['dataset', 'rows', 'cols', 'sources', 'last run', 'csv size', 'error'], rows));
  return true;
}

async function cmdVerify(positionals, flags, ctx) {
  const { root, datasets } = ctx;
  const targets = pickDatasets(datasets, flags.all ? [] : positionals);
  let allOk = true;
  for (const cfg of targets) {
    const res = await verifyCsv(datasetPaths(root, cfg.name));
    if (!res.ok) allOk = false;
    console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${cfg.name}  ${res.ok ? `${res.rows} rows, header locked (${res.manifest.headerHash})` : res.reason || res.problems.join('; ')}`);
  }
  return allOk;
}

async function cmdCsv(positionals, flags, ctx) {
  const { root, datasets } = ctx;
  const name = positionals[0];
  if (!name) throw new Error('usage: scrape01 csv <dataset> [--limit 10] [--columns a,b]');
  const paths = datasetPaths(root, name);
  const text = await readFile(paths.csv, 'utf8').catch(() => null);
  if (text === null) throw new Error(`no csv for "${name}" — run \`scrape01 run ${name}\` or \`scrape01 rebuild ${name}\``);
  const delimiter = datasets.find((d) => d.name === name)?.csv?.delimiter || ',';
  const { header, rows } = parseCsv(text, { delimiter });
  let cols = header;
  if (flags.columns) cols = String(flags.columns).split(',').map((c) => c.trim());
  const idx = cols.map((c) => { const i = header.indexOf(c); if (i === -1) throw new Error(`no column "${c}" (have ${header.join(', ')})`); return i; });
  const limit = flags.limit !== undefined ? Number(flags.limit) : 10;
  console.log(cols.join('\t'));
  for (const row of rows.slice(0, limit)) console.log(idx.map((i) => row[i] ?? '').join('\t'));
  console.log(`\n${rows.length} rows total, ${header.length} columns, ${delimiter === ',' ? 'comma' : `"${delimiter}"`} delimited`);
  return true;
}

async function repairFlow(cfg, sourceId, flags, ctx, { auto = false } = {}) {
  const { root, log } = ctx;
  try {
    const res = await repairFlowJob({ root, cfg, sourceId, params: { model: flags.model || null, monster: !!flags.monster }, log });
    console.log(`repaired ${cfg.name}/${sourceId}: ${res.rows} rows on the live page, columns [${res.columns.join(', ')}]`);
    if (res.sample) console.log('  sample:', JSON.stringify(res.sample).slice(0, 300));
    if (auto) console.log(`  (config updated; re-run \`scrape01 run ${cfg.name}\`)`);
    return true;
  } catch (err) {
    log.error({ msg: 'repair failed', dataset: cfg.name, source: sourceId, error: String(err.message || err) });
    console.error(`repair failed: ${err.message}`);
    return false;
  }
}

async function cmdServe(positionals, flags, ctx) {
  const { root, log } = ctx;
  const port = Number(flags.port || process.env.SCRAPE01_PORT || process.env.PIDU_PORT || 8787);
  const host = flags.host || '127.0.0.1';
  const { startServer } = await import('./server.mjs');
  const srv = await startServer({ root, port, host, log, verbose: !!flags.debug });
  console.log(`\n  Scrape_01 dashboard  ->  ${srv.url}`);
  console.log(`  workspace             ->  ${root}`);
  console.log(`  one writer at a time  ->  jobs queue, Ctrl-C to stop\n`);
  if (host !== '127.0.0.1' && host !== 'localhost') console.log('  note: bound beyond loopback; this server has no authentication.\n');
  if (flags.open) await openBrowser(srv.url);
  await new Promise((resolve) => {
    const stop = async () => {
      console.log('\nstopping...');
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await srv.close();
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return true;
}

async function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  try {
    const { spawn } = await import('node:child_process');
    spawn(cmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* opening a browser is a convenience, never a requirement */ }
}

async function cmdRepair(positionals, flags, ctx) {
  const { datasets } = ctx;
  const [name, sourceId] = positionals;
  if (!name || !sourceId) throw new Error('usage: scrape01 repair <dataset> <source-id> [--model x]');
  const cfg = datasets.find((d) => d.name === name);
  if (!cfg) throw new Error(`unknown dataset "${name}"`);
  const ok = await repairFlow(cfg, sourceId, flags, ctx);
  return ok;
}

async function cmdSort(positionals, flags, ctx) {
  const { root, log, datasets } = ctx;
  const name = positionals[0];
  const spec = positionals[1];
  if (!name) throw new Error('usage: scrape01 sort <dataset> <column>[:asc|:desc] | scrape01 sort <dataset> --reset');
  const cfg = datasets.find((d) => d.name === name);
  if (!cfg) throw new Error(`unknown dataset "${name}" (have: ${datasets.map((d) => d.name).join(', ') || 'none'})`);

  const file = path.join(root, 'datasets', `${name}.json`);
  const reset = flags.reset || spec === 'reset' || !spec;

  // what kind of time is this column? (iso, epoch seconds, "Oct 20, 2026", …)
  let kinds = null;
  if (!reset) {
    const col = String(spec).split(':')[0];
    try {
      const text = await readFile(datasetPaths(root, name).csv, 'utf8');
      const { header, rows } = parseCsv(text);
      const idx = header.indexOf(col);
      if (idx > -1 && rows.length) {
        const det = detectTimeKind(rows.slice(0, 200).map((r) => r[idx]));
        if (det.kind) kinds = { [col]: det.kind };
        else log.info({ msg: 'no unambiguous time interpretation for that column — sorting as plain values', column: col, reason: det.reason });
      }
    } catch { /* no csv yet: sort as plain values */ }
  }

  const updated = await setDatasetOrder(file, reset ? null : spec, kinds);
  const fresh = validateDataset(updated, file);
  const { manifest } = await rebuildDataset(fresh, { root, log });
  log.info({ msg: 'row order changed', dataset: name, sortBy: fresh.sortBy || 'ingest order', timeKinds: fresh.timeKinds || null, rows: manifest.rows });
  console.log(`${name}: order is now ${fresh.sortBy ? fresh.sortBy : 'ingest order (the order the page gave)'}`);
  if (fresh.timeKinds) console.log(`time interpretation: ${JSON.stringify(fresh.timeKinds)}`);
  console.log(table(['order', 'rows'], [[fresh.sortBy || 'ingest order', manifest.rows]]));
  return true;
}

async function cmdDelete(positionals, flags, ctx) {
  const { root, log, datasets } = ctx;
  const name = positionals[0];
  if (!name) throw new Error('usage: scrape01 delete <dataset> [--yes]');
  const cfg = datasets.find((d) => d.name === name);
  if (!cfg) throw new Error(`unknown dataset "${name}" (have: ${datasets.map((d) => d.name).join(', ') || 'none'})`);

  const paths = datasetPaths(root, name);
  const manifest = await readJson(paths.manifest, null);
  const rows = manifest?.rows ?? 0;
  if (!flags.yes) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Delete "${name}"? This removes the config, the CSV, the raw ingest log and the checkpoints (${rows} rows). No undo. Type the name to confirm: `);
    rl.close();
    if (answer.trim() !== name) {
      console.log('cancelled — nothing was deleted');
      return true;
    }
  }
  const out = await removeDataset(root, name);
  log.info({ msg: 'dataset deleted', dataset: name, removed: out.removed });
  console.log(`deleted ${name}: ${out.removed.join(', ')}`);
  return true;
}

async function cmdProfile(positionals, flags, ctx) {
  const name = positionals[0];
  if (name) {
    const p = getProfile(name);
    console.log(`${p.mode}: ${describeProfile(p)}`);
    console.log(`  user-agent: ${p.userAgent}`);
    return true;
  }
  console.log(table(['profile', 'settings'], [['polite', describeProfile(getProfile('polite'))], ['monster', describeProfile(getProfile('monster'))]]));
  console.log(`\nmonster mode renders JavaScript in a local browser, ignores robots.txt, and uses a ${MIN_DELAY}ms floor per request.`);
  console.log('use it per run: scrape01 run <dataset> --monster   or per dataset: "profile": "monster" in datasets/<name>.json');
  return true;
}

async function cmdPlan(positionals, flags, ctx) {
  const { root, log } = ctx;
  const url = flags.url || positionals[0];
  if (!url) throw new Error('usage: scrape01 plan <url> [--goal "..."] [--model x] [--monster]');
  const monster = !!flags.monster;
  const client = makeClient(root, { profile: monster ? 'monster' : 'polite', minDelayMs: monster ? 0 : 500, cacheTtlSec: 0 }, log);
  const page = await client.get(url, { retries: 2, cacheTtlSec: 0 });
  const planned = await planDatasetWithPi({ url, html: page.body, goal: flags.goal, name: flags.name || null, model: flags.model || null, monster, log, auditDir: path.join(root, '.scrape01', 'agent') });
  if (!planned.ok) { console.error(planned.reason); return false; }
  console.log(JSON.stringify(planned.cfg, null, 2));
  return true;
}

// ------------------------------------------------------------------- loop

async function cmdLoop(positionals, flags, ctx) {
  const { root, log } = ctx;
  const interval = parseDuration(flags.interval || '6h') || 6 * 3600e3;
  const once = !!flags.once;
  const maxRuns = flags['max-runs'] !== undefined ? Number(flags['max-runs']) : Infinity;
  const loopLock = path.join(root, '.scrape01', 'loop.lock');

  let lock;
  try { lock = await acquireLock(loopLock, { log }); }
  catch (err) { console.error(`another loop is running: ${err.message}`); return false; }

  let stopping = false;
  const stop = (sig) => { if (stopping) process.exit(1); stopping = true; log.warn({ msg: `received ${sig}, finishing current pass then exiting` }); };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const history = path.join(root, '.scrape01', 'history.jsonl');
  let run = 0;
  let failures = 0;
  try {
    while (!stopping && run < maxRuns) {
      run++;
      const startedAt = nowIso();
      // reload configs each pass: a repaired dataset takes effect without a restart
      let datasets = [];
      try { datasets = await loadDatasets(path.join(root, 'datasets')); } catch (err) { log.error({ msg: 'config load failed', error: err.message }); }
      const targets = flags.all || !positionals.length ? datasets : pickDatasets(datasets, positionals);
      const passResults = [];

      for (const cfg of targets) {
        if (stopping) break;
        try {
          const summary = await runDataset(cfg, { root, log, ...RUN_OPTS(flags) });
          passResults.push({ dataset: cfg.name, ok: true, newRows: summary.newRows, totalRows: summary.totalRows, drift: summary.drift });
          if (flags['auto-repair'] && summary.drift.length) {
            for (const sid of summary.drift) {
              try { await repairFlow(cfg, sid, flags, ctx, { auto: true }); } catch (err) { log.error({ msg: 'auto-repair failed', error: err.message }); }
            }
          }
        } catch (err) {
          if (err.code === 'LOCKED') { log.warn({ msg: 'dataset locked by another run, skipping', dataset: cfg.name }); passResults.push({ dataset: cfg.name, ok: false, error: 'locked' }); continue; }
          log.error({ msg: 'dataset failed', dataset: cfg.name, error: err.message });
          passResults.push({ dataset: cfg.name, ok: false, error: err.message });
        }
        if (flags['sleep-between'] !== undefined) await sleep(Number(flags['sleep-between']));
      }

      const okCount = passResults.filter((r) => r.ok).length;
      failures = okCount === 0 && passResults.length ? failures + 1 : 0;
      const entry = { at: startedAt, finishedAt: nowIso(), run, interval, results: passResults, failures };
      await appendJsonLine(history, entry);
      log.info({ msg: 'pass complete', run, ok: okCount, failed: passResults.length - okCount, nextIn: once ? 'n/a' : fmtDuration(interval) });

      if (once || run >= maxRuns || stopping) break;
      // exponential backoff if every dataset failed, capped at the interval
      const wait = failures ? Math.min(interval * 2 ** Math.min(failures, 4), 6 * 3600e3) : interval;
      if (failures) log.warn({ msg: 'all datasets failed; backing off', failures, wait: fmtDuration(wait) });
      await sleepInterruptible(wait, () => stopping);
    }
  } finally {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    await lock.release();
    log.info({ msg: 'loop stopped', passes: run });
  }
  return true;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sleepInterruptible(ms, isStopping) {
  return new Promise((resolve) => {
    const step = 500;
    let waited = 0;
    const t = setInterval(() => {
      waited += step;
      if (isStopping() || waited >= ms) { clearInterval(t); resolve(); }
    }, step);
  });
}

async function appendJsonLine(file, obj) {
  const { appendLines } = await import('./store.mjs');
  await appendLines(file, [obj]);
}

// --------------------------------------------------------------- schedule

async function cmdSchedule(positionals, flags, ctx) {
  const { root, log } = ctx;
  const action = positionals[0] || 'show';
  const taskName = flags.name || 'Scrape_01';
  const interval = flags.interval || '30m';
  const entry = path.join(root, 'bin', 'scrape01.mjs');

  if (process.platform !== 'win32') {
    console.log(`# non-Windows: add this to cron (\`crontab -e\`)\n*/30 * * * * cd "${root}" && node "${entry}" loop --once --all >> "${root}/.scrape01/cron.log" 2>&1`);
    return true;
  }

  const cmd = `node "${entry}" loop --once --all`;
  const { spawnSync } = await import('node:child_process');
  if (action === 'install') {
    const minutes = Math.max(1, Math.round((parseDuration(interval) || 1800000) / 60000));
    const args = ['/create', '/tn', taskName, '/tr', cmd, '/sc', 'minute', '/mo', String(minutes), '/rl', 'LIMITED', '/f'];
    const res = spawnSync('schtasks', args, { cwd: root, encoding: 'utf8' });
    console.log(res.stdout.trim() || res.stderr.trim());
    if (res.status !== 0) { console.error(`schtasks failed (${res.status}). Run this shell as Administrator, or use the Startup folder approach in the README.`); return false; }
    console.log(`installed scheduled task "${taskName}" every ${minutes}m -> ${cmd}`);
    return true;
  }
  if (action === 'remove') {
    const res = spawnSync('schtasks', ['/delete', '/tn', taskName, '/f'], { encoding: 'utf8' });
    console.log(res.stdout.trim() || res.stderr.trim());
    return res.status === 0;
  }
  const res = spawnSync('schtasks', ['/query', '/tn', taskName, '/v', '/fo', 'LIST'], { encoding: 'utf8' });
  if (res.status !== 0) { console.log(`no task "${taskName}" installed. install with:\n  scrape01 schedule install --interval 30m`); return true; }
  const keep = res.stdout.split('\n').filter((l) => /TaskName|Status|Next Run|Last Run|Task To Run|Schedule Type|Repeat: Every/i.test(l));
  console.log(keep.join('\n'));
  return true;
}

async function cmdHistory(positionals, flags, ctx) {
  const { root } = ctx;
  const file = path.join(root, '.scrape01', 'history.jsonl');
  const txt = await readFile(file, 'utf8').catch(() => '');
  const lines = txt.split('\n').filter(Boolean).slice(-(Number(flags.limit) || 10));
  if (!lines.length) { console.log('no loop history yet'); return true; }
  for (const l of lines) {
    const e = JSON.parse(l);
    const parts = e.results.map((r) => `${r.dataset}:${r.ok ? '+' + (r.newRows ?? 0) : 'FAIL'}`).join(' ');
    console.log(`${e.at.slice(0, 19).replace('T', ' ')}  run#${e.run}  ${parts}`);
  }
  return true;
}

// ------------------------------------------------------------------- main

const HELP = `Scrape_01 ${VERSION} — ordered, restartable, self-repairing CSV datasets

usage: scrape01 <command> [args] [flags]

commands
  init [dir]                     create a workspace (datasets/, data/, .scrape01/)
  doctor                         check environment, configs, network, pi agent
  new <name> --url <url>         pi designs a dataset from a live page, verified before saving
  plan <url>                     print a proposed dataset config (no files written)
  profile [name]                 show the crawl profiles (polite | monster)
  delete <dataset>               remove a dataset and everything it produced (asks first)
  sort <dataset> <col>[:dir]     set the row order (asc|desc); --reset returns to ingest order
  run [dataset...]               crawl, ingest, write CSV (resumable, idempotent)
  loop                           run forever on an interval (the durable mode)
  serve                          web dashboard: browse CSVs, run, repair, scrape new URLs
  repair <dataset> <source>      pi rewrites a broken extractor, verified before saving
  rebuild [dataset...]           regenerate CSV from the raw log (no network)
  status                         rows, checkpoints, last run per dataset
  verify [dataset...]            check CSV matches its manifest (header lock + hash)
  csv <dataset>                  preview rows
  history                        loop pass history
  schedule [install|remove|show] OS-level scheduler (schtasks on Windows, cron hint elsewhere)

flags
  --all            every dataset            --force       re-crawl completed sources
  --fresh          throw the old log away and fetch every row again
  --dry-run        no writes                --debug       verbose
  --model <id>     model for pi calls       --max-pages N page cap per source
  --interval 6h    loop interval            --once        single pass (for schedulers)
  --port 8787      web ui port             --host 127.0.0.1  web ui bind address
  --open           open the browser in the default browser
  --auto-repair    repair drifted sources   --cache-ttl s HTTP cache TTL (0 = always fetch)
  --root <dir>     workspace root           --continue    keep going after a failure
  --monster        aggressive profile: render JavaScript, ignore robots.txt, bigger budget
  --yes            skip the confirmation prompt (delete)
  --respect-robots obey robots.txt even in monster mode (render + speed, no override)
  --delay ms       per-host delay           --retries N   retry attempts
  --timeout ms     per-request timeout

profiles
  polite   (default) obey robots.txt, 1s between requests, plain HTTP
  monster  render JS in a local browser, ignore robots.txt, 150ms delay, 6 retries
           still sequential, never faster than ${MIN_DELAY}ms per request
`;

async function main() {
  const argv = process.argv.slice(2);
  const { positionals, flags } = parseArgs(argv);
  const command = positionals.shift() || (flags.help ? 'help' : 'status');

  if (command === 'help' || flags.help || command === '--help') { console.log(HELP); return true; }
  if (command === 'version' || flags.version) { console.log(VERSION); return true; }
  if (command === 'init') return cmdInit(positionals, flags);

  const ctx = await makeContext(flags);
  switch (command) {
    case 'doctor': return cmdDoctor(positionals, flags, ctx);
    case 'new': return cmdNew(positionals, flags, ctx);
    case 'plan': return cmdPlan(positionals, flags, ctx);
    case 'profile': return cmdProfile(positionals, flags, ctx);
    case 'delete': return cmdDelete(positionals, flags, ctx);
    case 'sort': return cmdSort(positionals, flags, ctx);
    case 'run': return cmdRun(positionals, flags, ctx);
    case 'loop': return cmdLoop(positionals, flags, ctx);
    case 'serve': return cmdServe(positionals, flags, ctx);
    case 'repair': return cmdRepair(positionals, flags, ctx);
    case 'rebuild': return cmdRebuild(positionals, flags, ctx);
    case 'status': return cmdStatus(positionals, flags, ctx);
    case 'verify': return cmdVerify(positionals, flags, ctx);
    case 'csv': return cmdCsv(positionals, flags, ctx);
    case 'history': return cmdHistory(positionals, flags, ctx);
    case 'schedule': return cmdSchedule(positionals, flags, ctx);
    default:
      console.error(`unknown command "${command}"\n\n${HELP}`);
      return false;
  }
}

main()
  .then((ok) => { process.exitCode = ok === false ? 1 : 0; })
  .catch((err) => {
    console.error(`\n${err.code ? '[' + err.code + '] ' : ''}${err.message}`);
    if (process.env.SCRAPE01_TRACE || process.env.PIDU_TRACE) console.error(err.stack);
    process.exitCode = 1;
  });
