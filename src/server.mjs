// Local web UI: CSV dashboard + scraping controls. node:http only, no build step.
// Binds to loopback by default and has no authentication — it is a local tool.

import http from 'node:http';
import path from 'node:path';
import { readFile, stat, readdir } from 'node:fs/promises';
import { loadDatasets, loadDatasetFile, listDatasetFiles, validateDataset, writeDatasetFile, columnNames, setDatasetOrder } from './config.mjs';
import { runDataset, rebuildDataset, makeClient } from './pipeline.mjs';
import { datasetPaths, readJson, loadState, listDatasets, removeDataset } from './store.mjs';
import { verifyCsv, parseCsv } from './csvio.mjs';
import { planDatasetWithPi } from './agent.mjs';
import { extractPage, extractPageAuto } from './extract.mjs';
import { createJobRunner } from './jobs.mjs';
import { repairFlowJob } from './repair-job.mjs';
import { createFlowJob } from './create-job.mjs';
import { detectTimeKind } from './timeorder.mjs';

const UI = new URL('./ui.html', import.meta.url);
const MAX_BODY = 512 * 1024;

export async function startServer({ root, port = 8787, host = '127.0.0.1', log, verbose = false }) {
  const jobRunner = createJobRunner({ root, logDir: path.join(root, '.scrape01', 'logs'), verbose, log });
  let uiCache = { html: await readFile(UI, 'utf8'), mtime: 0 };
  async function uiHtml() {
    // re-read when the file changes: editing the dashboard should not need a restart
    try {
      const st = await stat(UI);
      if (st.mtimeMs !== uiCache.mtime) {
        uiCache = { html: await readFile(UI, 'utf8'), mtime: st.mtimeMs };
      }
    } catch { /* keep the last good copy */ }
    return uiCache.html;
  }
  const csvCache = new Map();

  // ------------------------------------------------------------ helpers

  async function allDatasets() {
    // One broken config must not blind the whole dashboard: load each file on
    // its own and keep going.
    const dir = path.join(root, 'datasets');
    const out = [];
    let files = [];
    try { files = await listDatasetFiles(dir); } catch { return []; }
    for (const f of files) {
      try { out.push(await loadDatasetFile(f)); } catch (err) { /* reported per dataset below */ }
    }
    return out;
  }

  async function datasetByName(name) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(String(name || ''))) return null;
    const file = path.join(root, 'datasets', `${name}.json`);
    try { return await loadDatasetFile(file); } catch { return null; }
  }

  async function parsedCsv(name) {
    const paths = datasetPaths(root, name);
    let st;
    try { st = await stat(paths.csv); } catch { return { header: [], rows: [], mtime: 0 }; }
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = csvCache.get(name);
    if (hit && hit.key === key) return hit.value;
    const cfg = await datasetByName(name);
    const delimiter = cfg?.csv?.delimiter || ',';
    const text = await readFile(paths.csv, 'utf8');
    const parsed = parseCsv(text.replace(/^\ufeff/, ''), { delimiter });
    const value = { ...parsed, mtime: st.mtimeMs, bytes: st.size, delimiter };
    csvCache.set(name, { key, value });
    return value;
  }

  async function datasetSummary(cfg, name) {
    const paths = datasetPaths(root, name);
    const manifest = await readJson(paths.manifest, null);
    const state = await loadState(paths);
    const sources = (cfg?.sources || []).map((s) => {
      const sd = state.sources?.[s.id] || {};
      return {
        id: s.id, url: s.url, kind: s.extract?.kind || 'table',
        page: sd.page || 0, done: !!sd.done, drift: !!sd.drift,
        rows: sd.rows || 0, error: sd.error || null, lastRun: sd.lastRun || null,
        stoppedEarly: sd.stoppedEarly || null,
      };
    });
    // which columns hold a time axis, and how they are interpreted
    const timeColumns = [];
    try {
      const raw = await readFile(paths.csv, 'utf8');
      const head = raw.split('\n').filter(Boolean).slice(0, 201).join('\n');
      if (head.includes('\n')) {
        const parsed = parseCsv(head, { delimiter: ',' });
        parsed.header.forEach((col, idx) => {
          const det = detectTimeKind(parsed.rows.map((r) => r[idx]));
          if (det.kind) timeColumns.push({ column: col, kind: det.kind, coverage: det.coverage });
        });
      }
    } catch { /* no csv yet */ }

    return {
      name,
      description: cfg?.description || '',
      columns: cfg ? columnNames(cfg) : [],
      key: cfg?.key || [],
      sortBy: cfg?.sortBy || null,
      profile: cfg?.profile || 'polite',
      timeColumns,
      rows: manifest?.rows ?? 0,
      bytes: manifest?.bytes ?? 0,
      builtAt: manifest?.builtAt ?? null,
      headerHash: manifest?.headerHash ?? null,
      lastRun: state.lastRun || null,
      runs: state.runs || 0,
      sources,
      drift: sources.filter((s) => s.drift).map((s) => s.id),
      complete: sources.length > 0 && sources.every((s) => s.done),
    };
  }

  async function summaryPayload() {
    const cfgs = await allDatasets();
    const names = cfgs.length ? cfgs.map((c) => c.name) : await listDatasets(root);
    const datasets = [];
    for (const name of names) {
      const cfg = cfgs.find((c) => c.name === name) || null;
      datasets.push(await datasetSummary(cfg, name));
    }
    return {
      datasets,
      jobs: jobRunner.list(12),
      active: jobRunner.active,
      queueLength: jobRunner.queueLength,
      workspace: root,
      now: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------ actions

  const runOpts = (params = {}) => ({
    force: !!params.force,
    fresh: !!params.fresh,
    dryRun: !!params.dryRun,
    maxPages: params.maxPages ? Number(params.maxPages) : null,
    cacheTtlSec: params.cacheTtlSec !== undefined ? Number(params.cacheTtlSec) : 3600,
    minDelayMs: params.delayMs !== undefined ? Number(params.delayMs) : undefined,
    monster: !!params.monster,
    respectRobots: !!params.respectRobots,
  });

  function job(name, kind, label, dataset, params, run) {
    const j = jobRunner.create({ kind, label, dataset, params, run });
    log('info', { msg: 'job queued', id: j.id, kind, dataset, label });
    return { status: 202, body: { job: { id: j.id, kind, label, status: j.status } } };
  }

  async function startRun(cfg, params) {
    return job(params.datasetName || cfg.name, 'run', `run ${cfg.name}`, cfg.name, params, async (ctx) => {
      // reload from disk each time so a repaired config takes effect immediately
      const fresh = (await datasetByName(cfg.name)) || cfg;
      const summary = await runDataset(fresh, { root, log: ctx.log, ...runOpts(params), shouldStop: ctx.shouldStop });
      return { dataset: fresh.name, ...summary };
    });
  }

  async function startCreate(params) {
    const url = String(params.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error('url must be absolute http(s)'), { status: 400 });
    const name = String(params.name || '').trim() || deriveName(url);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw Object.assign(new Error('name must be lowercase [a-z0-9_-]'), { status: 400 });

    return job(name, 'create', `create + run ${name}`, name, params, async (ctx) => {
      const out = await createFlowJob({
        root, url, goal: params.goal || '', name,
        model: params.model || null, monster: !!params.monster, params, ctx, log: ctx.log,
      });
      const saved = await datasetByName(name);
      const summary = await runDataset(saved, { root, log: ctx.log, ...runOpts(params), shouldStop: ctx.shouldStop });
      return {
        dataset: name,
        columns: columnNames(out.cfg),
        verification: [{ source: 'main', rows: out.verification.rows, sample: out.verification.sample?.[0] || null }],
        goal: out.goal || '',
        ...summary,
      };
    });
  }

  async function startRepair(cfg, sourceId, params) {
    return job(cfg.name, 'repair', `repair ${cfg.name}/${sourceId}`, cfg.name, { source: sourceId, ...params }, async (ctx) =>
      repairFlowJob({ root, cfg, sourceId, params, ctx, log: ctx.log }));
  }

  function deriveName(url) {
    const u = new URL(url);
    return (u.hostname + '-' + (u.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root'))
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  // ------------------------------------------------------------ routing

  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { status: 413 });
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    const q = url.searchParams;
    const method = req.method || 'GET';

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await uiHtml());
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p === '/api/ping') return json(res, 200, { ok: true, version: '1.0.0' });

    if (!p.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }

    // ---- summary
    if (p === '/api/summary' && method === 'GET') return json(res, 200, await summaryPayload());

    // ---- jobs
    if (p === '/api/jobs' && method === 'GET') return json(res, 200, { jobs: jobRunner.list(40), active: jobRunner.active });
    {
      const m = /^\/api\/jobs\/([\w.-]+)(\/stream|\/cancel)?$/.exec(p);
      if (m) {
        const [, id, sub] = m;
        if (sub === '/stream') return streamJob(res, id);
        if (sub === '/cancel' && method === 'POST') return json(res, 200, jobRunner.cancel(id));
        if (method === 'GET') {
          const j = jobRunner.get(id);
          return j ? json(res, 200, j) : json(res, 404, { error: 'unknown job' });
        }
      }
    }

    // ---- logs tail
    if (p === '/api/logs' && method === 'GET') {
      const day = new Date().toISOString().slice(0, 10);
      const file = path.join(root, '.scrape01', 'logs', `run-${day}.jsonl`);
      const limit = Math.min(Number(q.get('limit') || 200), 1000);
      let text = '';
      try { text = await readFile(file, 'utf8'); } catch { /* no log yet */ }
      const lines = text.split('\n').filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { msg: l }; } });
      return json(res, 200, { file: path.relative(root, file), lines });
    }

    // ---- create dataset
    if (p === '/api/datasets' && method === 'POST') {
      const body = await readBody(req);
      if (jobRunner.active) return json(res, 429, { error: 'a job is already running; one writer at a time' });
      return json(res, 202, (await startCreate(body)).body);
    }

    // ---- dataset-scoped
    const dm = /^\/api\/datasets\/([a-z0-9][a-z0-9_-]*)(\/[a-z]+)?$/.exec(p);
    if (!dm) return json(res, 404, { error: 'not found' });
    const name = dm[1];
    const action = dm[2] || '';
    const cfg = await datasetByName(name);
    if (!cfg && action !== '/rows' && action !== '/download') return json(res, 404, { error: `unknown dataset "${name}"` });

    if (action === '' && method === 'GET') {
      const s = await datasetSummary(cfg, name);
      const { header, rows } = await parsedCsv(name).catch(() => ({ header: [], rows: [] }));
      return json(res, 200, { ...s, header, preview: rows.slice(0, 10) });
    }

    if (action === '/rows' && method === 'GET') {
      const offset = Math.max(0, Number(q.get('offset') || 0));
      const limit = Math.min(Math.max(1, Number(q.get('limit') || 100)), 1000);
      const term = (q.get('q') || '').trim().toLowerCase();
      const sort = q.get('sort') || '';
      const dir = (q.get('dir') || 'asc').toLowerCase() === 'desc' ? -1 : 1;
      let { header, rows } = await parsedCsv(name);
      if (!header.length) return json(res, 200, { header: [], rows: [], total: 0, filtered: 0, offset, limit, columns: [] });

      const onlyCols = (q.get('columns') || '').split(',').map((c) => c.trim()).filter(Boolean);
      const showIdx = onlyCols.length ? onlyCols.map((c) => header.indexOf(c)).filter((i) => i > -1) : header.map((_, i) => i);
      const terms = term ? term.split(/\s+/).filter(Boolean) : [];
      let filtered = rows;
      if (terms.length) {
        filtered = rows.filter((row) => {
          const hay = showIdx.map((i) => row[i] ?? '').join(' ').toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
      }
      const sortIdx = sort ? header.indexOf(sort) : -1;
      if (sortIdx > -1) {
        filtered = [...filtered].sort((a, b) => {
          const x = a[sortIdx] ?? '';
          const y = b[sortIdx] ?? '';
          const nx = Number(x);
          const ny = Number(y);
          const numeric = x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny);
          const c = numeric ? nx - ny : String(x).localeCompare(String(y), 'en', { numeric: true });
          return c * dir;
        });
      }
      const page = filtered.slice(offset, offset + limit).map((row) => showIdx.map((i) => row[i] ?? ''));
      return json(res, 200, {
        header: showIdx.map((i) => header[i]),
        allColumns: header,
        rows: page, total: rows.length, filtered: filtered.length, offset, limit,
      });
    }

    if (action === '/download' && method === 'GET') {
      const paths = datasetPaths(root, name);
      const text = await readFile(paths.csv).catch(() => null);
      if (!text) return json(res, 404, { error: 'no csv yet' });
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'content-length': Buffer.byteLength(text) });
      return res.end(text);
    }

    if (action === '/verify' && method === 'POST') {
      const v = await verifyCsv(datasetPaths(root, name));
      return json(res, 200, { ok: v.ok, problems: v.problems || [], rows: v.rows ?? 0, headerHash: v.manifest?.headerHash || null });
    }

    if (action === '/rebuild' && method === 'POST') {
      if (jobRunner.active) return json(res, 429, { error: 'a job is already running' });
      return json(res, 202, job(name, 'rebuild', `rebuild ${name}`, name, {}, async (ctx) => {
        const fresh = (await datasetByName(name)) || cfg;
        const out = await rebuildDataset(fresh, { root, log: ctx.log });
        return { dataset: name, rows: out.rows, manifest: out.manifest };
      }).body);
    }

    if (action === '/run' && method === 'POST') {
      const body = await readBody(req);
      if (jobRunner.active) return json(res, 429, { error: 'a job is already running; wait for it or cancel it' });
      return json(res, 202, (await startRun(cfg, body)).body);
    }

    if (action === '/repair' && method === 'POST') {
      const body = await readBody(req);
      const sourceId = String(body.source || '');
      if (!cfg.sources.some((s) => s.id === sourceId)) return json(res, 400, { error: `unknown source "${sourceId}"` });
      if (jobRunner.active) return json(res, 429, { error: 'a job is already running' });
      return json(res, 202, (await startRepair(cfg, sourceId, body)).body);
    }

    if (action === '/order' && method === 'POST') {
      if (!cfg) return json(res, 404, { error: `unknown dataset "${name}"` });
      if (jobRunner.active) return json(res, 429, { error: 'a job is already running' });
      const body = await readBody(req);
      const spec = body.sortBy === null || body.sortBy === 'reset' ? null : String(body.sortBy || '');
      try {
        await setDatasetOrder(path.join(root, 'datasets', `${name}.json`), spec);
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
      return json(res, 202, job(name, 'rebuild', `reorder ${name}`, name, {}, async (ctx) => {
        const fresh = (await datasetByName(name)) || cfg;
        const out = await rebuildDataset(fresh, { root, log: ctx.log });
        ctx.log('info', { msg: 'row order changed', dataset: name, sortBy: fresh.sortBy || 'ingest order' });
        return { dataset: name, sortBy: fresh.sortBy || null, rows: out.manifest.rows };
      }).body);
    }

    if (action === '/delete' && method === 'POST') {
      if (!cfg) return json(res, 404, { error: `unknown dataset "${name}"` });
      if (jobRunner.active) return json(res, 429, { error: 'a job is already running; wait for it to finish' });
      // synchronous: deleting is a fast filesystem operation, and the caller
      // expects the dataset to be gone when the response arrives
      const out = await removeDataset(root, name);
      log('info', { msg: 'dataset deleted', dataset: name, removed: out.removed });
      return json(res, 200, { ok: true, dataset: name, deleted: true, removed: out.removed });
    }

    if (action === '/sources' && method === 'GET') {
      const s = await datasetSummary(cfg, name);
      return json(res, 200, { name, sources: s.sources });
    }

    return json(res, 404, { error: `unsupported ${method} ${p}` });
  }

  function streamJob(res, id) {
    const snapshot = jobRunner.get(id);
    if (!snapshot) return json(res, 404, { error: 'unknown job' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    const unsubscribe = jobRunner.subscribe(id, (frame) => res.write(frame));
    const beat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, 15000);
    const done = () => { clearInterval(beat); unsubscribe && unsubscribe(); try { res.end(); } catch { /* closed */ } };
    res.on('close', done);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500;
      log('warn', { msg: 'request failed', path: req.url, status, error: String(err.message || err) });
      if (!res.headersSent) json(res, status, { error: String(err.message || err) });
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const urlString = `http://${shownHost}:${actualPort}/`;
  log('info', { msg: 'web ui listening', url: urlString, workspace: root });
  return {
    server,
    port: actualPort,
    url: urlString,
    jobs: jobRunner,
    close: async () => {
      if (jobRunner.active?.id) jobRunner.cancel(jobRunner.active.id);
      try { server.closeAllConnections?.(); } catch { /* older node */ }
      await new Promise((r) => server.close(r));
    },
  };
}
