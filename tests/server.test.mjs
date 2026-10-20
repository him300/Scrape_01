import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../src/server.mjs';
import { validateDataset } from '../src/config.mjs';
import { runDataset } from '../src/pipeline.mjs';

const quiet = () => {};

function fixtureSite() {
  const page = (rows, next) => `<html><head><title>Fixture</title></head><body>
    <table class="grid"><thead><tr><th>Title</th><th>Price</th><th>Link</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${r.t}</td><td>${r.p}</td><td><a href="/i/${r.id}">x</a></td></tr>`).join('')}
    </tbody></table>${next ? `<a class="next" rel="next" href="${next}">next</a>` : ''}</body></html>`;
  return (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    if (req.url === '/p1') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page([{ id: 1, t: 'Alpha', p: '£10' }, { id: 2, t: 'Beta', p: '£20' }], '/p2')); }
    if (req.url === '/p2') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page([{ id: 3, t: 'Gamma', p: '£30' }], null)); }
    res.writeHead(404); res.end('nope');
  };
}

async function withServer(fn) {
  const site = http.createServer(fixtureSite());
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const siteBase = `http://127.0.0.1:${site.address().port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-web-'));
  let srv;
  try {
    await mkdir(path.join(root, 'datasets'), { recursive: true });
    const cfg = validateDataset({
      name: 'items',
      columns: [
        { name: 'title', required: true },
        { name: 'price', type: 'number' },
        { name: 'url', type: 'url' },
        { name: 'source' },
        { name: 'scraped_at', type: 'datetime' },
      ],
      key: ['url'],
      sources: [{
        id: 'main',
        url: `${siteBase}/p1`,
        extract: { kind: 'selector', row: 'table.grid tbody tr', fields: { title: 'td:first-child', price: 'td:nth-child(2)', url: { selector: 'a', attr: 'href' } } },
        paginate: { mode: 'next', selector: 'a.next' },
      }],
    });
    await writeFile(path.join(root, 'datasets', 'items.json'), JSON.stringify(cfg, null, 2));
    await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0 });
    srv = await startServer({ root, port: 0, host: '127.0.0.1', log: quiet });
    return await fn({ root, srv, base: srv.url, siteBase });
  } finally {
    if (srv) await srv.close();
    await new Promise((r) => site.close(r));
    await rm(root, { recursive: true, force: true });
  }
}

const getJson = async (url, opts) => {
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json() };
};

async function waitForJob(base, id, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await getJson(`${base}api/jobs/${id}`);
    if (['ok', 'failed', 'cancelled', 'locked'].includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('job did not finish');
}

test('web: serves the dashboard shell', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Scrape_01/);
    assert.match(html, /id="dlist"/);
    assert.match(html, /EventSource/);
  });
});

test('web: summary reports datasets, checkpoints, and header lock', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await getJson(`${base}api/summary`);
    assert.equal(status, 200);
    assert.equal(body.datasets.length, 1);
    const d = body.datasets[0];
    assert.equal(d.name, 'items');
    assert.deepEqual(d.columns, ['title', 'price', 'url', 'source', 'scraped_at']);
    assert.equal(d.rows, 3);
    assert.equal(d.complete, true);
    assert.equal(d.drift.length, 0);
    assert.match(d.headerHash, /^[0-9a-f]{16}$/);
  });
});

test('web: rows endpoint paginates, filters, and sorts numerically', async () => {
  await withServer(async ({ base }) => {
    const page1 = await getJson(`${base}api/datasets/items/rows?offset=0&limit=2`);
    assert.deepEqual(page1.body.header, ['title', 'price', 'url', 'source', 'scraped_at']);
    assert.equal(page1.body.rows.length, 2);
    assert.equal(page1.body.total, 3);
    assert.deepEqual(page1.body.rows.map((r) => r[0]), ['Alpha', 'Beta'], 'ingest order by default');

    const sorted = await getJson(`${base}api/datasets/items/rows?sort=price&dir=desc`);
    assert.deepEqual(sorted.body.rows.map((r) => Number(r[1])), [30, 20, 10], 'numeric desc, not lexicographic');

    const filtered = await getJson(`${base}api/datasets/items/rows?q=gam`);
    assert.equal(filtered.body.rows.length, 1);
    assert.equal(filtered.body.rows[0][0], 'Gamma');
    assert.equal(filtered.body.filtered, 1);
    assert.equal(filtered.body.total, 3);

    const cols = await getJson(`${base}api/datasets/items/rows?columns=title,price`);
    assert.deepEqual(cols.body.header, ['title', 'price']);
    assert.equal(cols.body.rows[0].length, 2);
  });
});

test('web: download returns the exact CSV with attachment headers', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}api/datasets/items/download`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="items.csv"/);
    const text = await res.text();
    assert.match(text.split('\r\n')[0], /^title,price,url,source,scraped_at$/);
    assert.match(text, /Alpha/);
  });
});

test('web: verify and rebuild work through the API', async () => {
  await withServer(async ({ base }) => {
    const v = await getJson(`${base}api/datasets/items/verify`, { method: 'POST' });
    assert.equal(v.body.ok, true);
    assert.equal(v.body.rows, 3);

    const start = await getJson(`${base}api/datasets/items/rebuild`, { method: 'POST' });
    assert.equal(start.status, 202);
    const done = await waitForJob(base, start.body.job.id);
    assert.equal(done.status, 'ok');
    assert.equal(done.result.rows, 3);
  });
});

test('web: run job streams log lines and resumes incrementally', async () => {
  await withServer(async ({ base }) => {
    const start = await getJson(`${base}api/datasets/items/run`, { method: 'POST', body: JSON.stringify({ force: true, maxPages: 1, delayMs: 0 }) });
    assert.equal(start.status, 202);
    const id = start.body.job.id;
    const done = await waitForJob(base, id);
    assert.equal(done.status, 'ok', JSON.stringify(done.error));
    assert.ok(done.lines.length > 0, 'job captures log lines');
    assert.ok(done.lines.some((l) => /csv written|dataset done/.test(l.msg || '')), 'structured log captured');

    // second run resumes from the checkpoint (page 2) and everything is already ingested
    const again = await getJson(`${base}api/datasets/items/run`, { method: 'POST', body: JSON.stringify({ maxPages: 1, delayMs: 0 }) });
    const done2 = await waitForJob(base, again.body.job.id);
    assert.equal(done2.status, 'ok');
    assert.equal(done2.result.newRows, 0, 'dedupe: nothing new, even after a forced re-crawl');
    assert.equal(done2.result.duplicates, 1, 'resumed at page 2: one row re-seen, none new');
    assert.equal(done2.result.pages, 1, 'resumed at the next URL, not page 1');

    const after = await getJson(`${base}api/summary`);
    const d = after.body.datasets[0];
    assert.equal(d.rows, 3, 'csv still has exactly 3 rows');
    assert.equal(d.sources[0].done, true, 'pagination end detected');
  });
});

test('web: one writer at a time — a second job is refused while one runs', async () => {
  await withServer(async ({ base }) => {
    const a = await getJson(`${base}api/datasets/items/run`, { method: 'POST', body: JSON.stringify({ force: true, delayMs: 200 }) });
    const b = await fetch(`${base}api/datasets/items/run`, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(b.status, 429);
    await waitForJob(base, a.body.job.id);
  });
});

test('web: SSE stream emits snapshot then status for a job', async () => {
  await withServer(async ({ base }) => {
    const start = await getJson(`${base}api/datasets/items/rebuild`, { method: 'POST' });
    const id = start.body.job.id;
    const ac = new AbortController();
    const res = await fetch(`${base}api/jobs/${id}/stream`, { signal: ac.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !/event: status/.test(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    ac.abort();
    assert.match(buf, /event: snapshot/);
    assert.match(buf, /event: status/);
  });
});

test('web: rejects traversal, bad urls, and unknown datasets', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}api/datasets/..%2F..%2Fetc/rows`)).status, 404);
    assert.equal((await fetch(`${base}api/datasets/nope/run`, { method: 'POST', body: '{}' })).status, 404);
    const bad = await fetch(`${base}api/datasets`, { method: 'POST', body: JSON.stringify({ url: 'ftp://x' }) });
    assert.equal(bad.status, 400);
    const noName = await fetch(`${base}api/datasets`, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/x', name: 'NOT VALID' }) });
    assert.equal(noName.status, 400);
    const badSeries = await fetch(`${base}api/datasets/items/repair`, { method: 'POST', body: JSON.stringify({ source: 'ghost' }) });
    assert.equal(badSeries.status, 400);
  });
});

test('web: deleting a dataset removes the config, the CSV and the raw log', async () => {
  await withServer(async ({ root, base }) => {
    const cfgFile = path.join(root, 'datasets', 'items.json');
    const dataDir = path.join(root, 'data', 'items');
    assert.ok(existsSync(cfgFile));
    assert.ok(existsSync(path.join(dataDir, 'items.csv')));

    const res = await fetch(`${base}api/datasets/items/delete`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 200, 'the delete happens in the request, not in a queue');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.dataset, 'items');

    assert.equal(existsSync(cfgFile), false, 'the config is gone');
    assert.equal(existsSync(dataDir), false, 'the data directory is gone');

    // and the dataset is no longer listed
    const summary = await (await fetch(`${base}api/summary`)).json();
    assert.equal(summary.datasets.find((d) => d.name === 'items'), undefined);

    // deleting again is an honest 404, not a silent success
    const again = await fetch(`${base}api/datasets/items/delete`, { method: 'POST', body: '{}' });
    assert.equal(again.status, 404);
  });
});
