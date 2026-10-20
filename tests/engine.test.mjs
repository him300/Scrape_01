import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseHTML, parseDoc, query, queryAll, text, tableGrid, decodeEntities } from '../src/dom.mjs';
import { buildCsv, parseCsv, headerHash, orderRows, verifyCsv, writeCsv } from '../src/csvio.mjs';
import { validateDataset, coerce, toNumber, coerceRow, setDatasetOrder } from '../src/config.mjs';
import { extractPage } from '../src/extract.mjs';
import { runDataset, rebuildDataset } from '../src/pipeline.mjs';
import { datasetPaths, readJsonl, appendLines, atomicWrite, loadState, acquireLock, readJson } from '../src/store.mjs';

const quiet = () => {};

// ------------------------------------------------------------------ dom

test('dom: parses nested tables, entities, and void elements', () => {
  const html = `<html><body>
    <table id="t1"><thead><tr><th>Name</th><th>Price &amp; tax</th></tr></thead>
    <tbody><tr><td>A &lt;x&gt;</td><td>10</td></tr><tr><td>B</td><td>20<br>note</td></tr></tbody></table>
    <table id="nested"><tr><td>outer<table><tr><td>inner</td></tr></table></td></tr></table>
  </body></html>`;
  const doc = parseDoc(html);
  const t1 = doc.query('#t1');
  const grid = tableGrid(t1);
  assert.deepEqual(grid.headers, ['Name', 'Price & tax']);
  assert.deepEqual(grid.rows, [['A <x>', '10'], ['B', '20note']]);

  const nested = tableGrid(doc.query('#nested'));
  assert.equal(nested.rows.length, 1, 'nested table rows must not leak into the outer table');
  assert.equal(decodeEntities('&#65;&#x42;&amp;'), 'AB&');
});

test('dom: selector subset incl. attrs, child, nth-child, not, contains', () => {
  const doc = parseDoc(`<ul id="l"><li class="a x" data-k="1">one</li><li class="b">two</li><li class="a">three</li></ul>`);
  assert.equal(doc.queryAll('li.a').length, 2);
  assert.equal(doc.queryAll('li:first-child').length, 1);
  assert.equal(doc.queryAll('li:nth-child(2)')[0].attrs.class, 'b');
  assert.equal(doc.queryAll('li[data-k="1"]').length, 1);
  assert.equal(doc.queryAll('li:not(.a)').length, 1);
  assert.equal(doc.queryAll('li:contains("three")').length, 1);
  assert.equal(doc.queryAll('#l > li').length, 3);
  assert.equal(text(doc.query('li.b')), 'two');
});

// ------------------------------------------------------------------ csv

test('csv: RFC4180 roundtrip keeps order, quotes, newlines, and types', () => {
  const cols = ['a', 'b', 'c'];
  const rows = [
    { a: 'plain', b: 1, c: true },
    { a: 'has,comma', b: 2.5, c: false },
    { a: 'has"quote', b: '', c: null },
    { a: 'multi\nline', b: 0, c: true },
    { a: ' padded ', b: -3, c: true },
  ];
  const csv = buildCsv(cols, rows, { newline: '\r\n' });
  const back = parseCsv(csv);
  assert.deepEqual(back.header, cols);
  assert.equal(back.rows.length, rows.length);
  assert.deepEqual(back.rows.map((r) => r[0]), rows.map((r) => String(r.a)));
  assert.equal(back.rows[3][0], 'multi\nline');
  assert.equal(back.rows[4][0], ' padded ');
});

test('csv: header hash is order sensitive, orderRows is deterministic', () => {
  assert.notEqual(headerHash(['a', 'b']), headerHash(['b', 'a']));
  const cfg = { sortBy: 'price:desc' };
  const ordered = orderRows([{ price: 1, _ord: 1 }, { price: 5, _ord: 2 }, { price: 5, _ord: 0 }], cfg);
  assert.deepEqual(ordered.map((r) => r._ord), [0, 2, 1], 'desc price, ties break on ascending _ord');
});

// --------------------------------------------------------------- config

test('config: coercion handles money, thousands, bools, urls, dates', () => {
  assert.equal(toNumber('$1,234.50'), 1234.5);
  assert.equal(toNumber('1.234,50'), 1234.5);
  assert.equal(toNumber('(42)'), -42);
  assert.equal(toNumber('1,234'), 1234);
  assert.equal(coerce({ name: 'b', type: 'bool' }, 'In Stock').value, true);
  assert.equal(coerce({ name: 'b', type: 'bool' }, 'out of stock').value, false);
  assert.equal(coerce({ name: 'u', type: 'url' }, '/x?y=1', { baseUrl: 'https://e.com/a/' }).value, 'https://e.com/x?y=1');
  // a date with no time of day stays a DATE: a timestamp would invent one
  assert.equal(coerce({ name: 'd', type: 'datetime' }, '2024-03-01').value, '2024-03-01');
  assert.equal(coerce({ name: 'd', type: 'date' }, '2024-03-01').value, '2024-03-01');
  // a real timestamp keeps its instant
  assert.equal(coerce({ name: 'd', type: 'datetime' }, '2024-03-01T10:30:00Z').value, '2024-03-01T10:30:00.000Z');
  // a human date keeps the calendar day the page states (no timezone shift)
  assert.equal(coerce({ name: 'd', type: 'date' }, 'March 1, 2024').value, '2024-03-01');
  // a month is a month: the day is not invented
  assert.equal(coerce({ name: 'd', type: 'date' }, '2024-03').value, '2024-03');
  // an ambiguous slash date is refused rather than guessed
  assert.equal(coerce({ name: 'd', type: 'date' }, '01/03/2024').ok, false);
  assert.equal(coerce({ name: 'n', type: 'number' }, 'N/A').ok, false);
  assert.equal(coerce({ name: 'r', type: 'string', required: true }, '').ok, false);
  assert.equal(coerce({ name: 'e', type: 'enum', values: ['a', 'b'] }, 'c').ok, false);
});

test('config: an optional column that cannot be coerced loses the cell, not the row', () => {
  const cfg = validateDataset({
    name: 'fx',
    columns: [
      { name: 'date', type: 'datetime' },
      { name: 'close', type: 'number' },
      { name: 'volume', type: 'integer' },
      { name: 'code', required: true },
    ],
    sources: [{ id: 'main', url: 'https://example.com/', extract: { kind: 'table' } }],
  });
  // "-" in an optional numeric column: the row survives with an empty cell
  const soft = coerceRow(cfg, { date: 'Oct 20, 2026', close: '158.2050', volume: '-', code: 'JPY=X' });
  assert.deepEqual(soft.errors, [], 'no hard error');
  assert.equal(soft.soft.length, 1);
  assert.equal(soft.values.close, 158.205, 'the good columns are intact');
  assert.equal(soft.values.volume, '', 'the impossible cell is empty');
  // the source said "Oct 20, 2026" — that is the calendar date, with no
  // invented time of day and no timezone shift
  assert.equal(soft.values.date, '2026-10-20');

  // a REQUIRED column that cannot be coerced still rejects the whole row
  const hard = coerceRow(cfg, { date: 'Oct 20, 2026', close: '158.2050', volume: '12', code: '' });
  assert.equal(hard.errors.length, 1);
  assert.match(hard.errors[0], /code/);
});

test('config: rejects unknown map targets and bad columns', () => {
  const base = {
    name: 'x', columns: [{ name: 'a' }], sources: [{ id: 'main', url: 'https://e.com', map: { a: 'zzz' } }],
  };
  assert.throws(() => validateDataset(base), /unknown column/);
  assert.throws(() => validateDataset({ ...base, columns: [] }), /non-empty/);
  assert.throws(() => validateDataset({ ...base, columns: [{ name: 'a' }, { name: 'a' }] }), /duplicate/);
});

// ----------------------------------------------------------------- fixture site

function makeSite() {
  const page = (rows, next) => `<html><head><title>Books</title></head><body>
    <table class="grid"><thead><tr><th>Title</th><th>Price</th><th>Stock</th><th>Link</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${r.t}</td><td>${r.p}</td><td>${r.s}</td><td><a href="/book/${r.id}">details</a></td></tr>`).join('\n')}
    </tbody></table>${next ? `<a class="next" rel="next" href="${next}">next</a>` : ''}</body></html>`;
  return (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /private\n'); }
    if (req.url === '/page1') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page([{ id: '1', t: 'Alpha', p: '£10.00', s: 'In stock' }, { id: '2', t: 'Beta', p: '£12,50', s: 'Out of stock' }], '/page2')); }
    if (req.url === '/page2') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page([{ id: '2', t: 'Beta', p: '£12,50', s: 'Out of stock' }, { id: '3', t: 'Gamma', p: '£7', s: 'In stock' }], null)); }
    if (req.url === '/empty') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body><p>nothing here</p></body></html>'); }
    if (req.url === '/private/thing') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body>secret</body></html>'); }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('nope');
  };
}

async function withSite(fn) {
  const server = http.createServer(makeSite());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

function datasetCfg(base) {
  return validateDataset({
    name: 'books',
    columns: [
      { name: 'title', required: true },
      { name: 'price', type: 'number' },
      { name: 'in_stock', type: 'bool' },
      { name: 'url', type: 'url' },
      { name: 'source' },
      { name: 'scraped_at', type: 'datetime' },
    ],
    key: ['title'],
    sources: [{
      id: 'main',
      url: `${base}/page1`,
      extract: { kind: "table", table: "table.grid", headerMap: { title: "title", price: "price", stock: "in_stock", link: "url" }, cellFields: { url: "a@href" } },
      paginate: { mode: 'next', selector: 'a.next' },
    }],
  });
}

// --------------------------------------------------------------- pipeline

test('pipeline: ordered csv, pagination, dedupe, resume, idempotency', async () => {
  await withSite(async (base) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
    try {
      const cfg = datasetCfg(base);
      const summary = await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0 });
      assert.equal(summary.pages, 2, 'both pages crawled');
      assert.equal(summary.newRows, 3, 'three unique titles');
      assert.equal(summary.duplicates, 1, 'Beta appeared on both pages');

      const csv = await readFile(datasetPaths(root, 'books').csv, 'utf8');
      const parsed = parseCsv(csv);
      assert.deepEqual(parsed.header, ['title', 'price', 'in_stock', 'url', 'source', 'scraped_at']);
      assert.deepEqual(parsed.rows.map((r) => r[0]), ['Alpha', 'Beta', 'Gamma'], 'ingest order preserved');
      assert.equal(parsed.rows[0][1], '10', 'money coerced');
      assert.equal(parsed.rows[1][1], '12.5', 'comma decimal coerced');
      assert.equal(parsed.rows[1][2], 'false', 'bool coerced');
      assert.match(parsed.rows[0][3], /\/book\/1$/);

      // idempotent: completed source is skipped
      const again = await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0 });
      assert.deepEqual(again.skipped, ['main']);
      assert.equal(again.newRows, 0);

      // forced re-crawl: everything deduped, schema/order untouched
      const forced = await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0, force: true });
      assert.equal(forced.newRows, 0);
      assert.equal(forced.duplicates, 4);
      const after = parseCsv(await readFile(datasetPaths(root, 'books').csv, 'utf8'));
      assert.equal(after.rows.length, 3, 'no duplicate rows in csv');

      // crash simulation: checkpoint lost, raw log intact -> resume without duplicates
      const paths = datasetPaths(root, 'books');
      await rm(paths.state);
      const resumed = await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0 });
      assert.equal(resumed.newRows, 0, 'dedupe prevents re-ingesting after state loss');
      const st = await loadState(paths);
      assert.equal(st.sources.main.done, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test('pipeline: drift is detected (page ok, extractor matches nothing)', async () => {
  await withSite(async (base) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
    try {
      const cfg = validateDataset({
        name: 'drift',
        columns: [{ name: 'title' }],
        sources: [{ id: 'main', url: `${base}/empty`, extract: { kind: 'table', table: 'table.grid' } }],
      });
      const summary = await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0 });
      assert.deepEqual(summary.drift, ['main']);
      const st = await loadState(datasetPaths(root, 'drift'));
      assert.equal(st.sources.main.drift, true);
      assert.match(st.sources.main.error, /0 valid rows/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test('pipeline: robots.txt is obeyed', async () => {
  await withSite(async (base) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
    try {
      const cfg = validateDataset({
        name: 'robots',
        columns: [{ name: 'title' }],
        sources: [{ id: 'main', url: `${base}/private/thing`, extract: { kind: 'table' } }],
      });
      const summary = await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0 });
      assert.equal(summary.fetched, 0, 'disallowed URL was never fetched');
      assert.match(summary.errors[0].error, /robots\.txt disallows/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test('pipeline: rebuild from raw log is deterministic and verifies', async () => {
  await withSite(async (base) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
    try {
      const cfg = datasetCfg(base);
      await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0 });
      const paths = datasetPaths(root, 'books');
      const first = await readFile(paths.csv, 'utf8');
      const { manifest } = await rebuildDataset(cfg, { root, log: quiet });
      const second = await readFile(paths.csv, 'utf8');
      assert.equal(first, second, 'csv is a pure function of the raw log');
      const v = await verifyCsv(paths);
      assert.ok(v.ok, JSON.stringify(v.problems));
      assert.equal(manifest.rows, 3);

      // tamper -> verify fails
      await writeFile(paths.csv, second.replace('Alpha', 'Tampered'));
      const bad = await verifyCsv(paths);
      assert.equal(bad.ok, false);
      assert.ok(bad.problems.some((p) => /hash/.test(p)));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test('store: torn trailing line is repaired, good rows survive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
  try {
    const paths = datasetPaths(root, 'torn');
    await appendLines(paths.raw, [{ a: 1 }, { a: 2 }]);
    await writeFile(paths.raw, (await readFile(paths.raw, 'utf8')) + '{"a":3,"broke');
    const { rows, torn } = await readJsonl(paths.raw, { log: quiet });
    assert.equal(torn, true);
    assert.deepEqual(rows.map((r) => r.a), [1, 2]);
    const reread = await readJsonl(paths.raw, { log: quiet });
    assert.equal(reread.torn, false, 'repair is persistent');
    assert.equal(reread.rows.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('store: lock blocks a second writer and recovers a stale one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
  try {
    const file = path.join(root, 'x.lock');
    const lock = await acquireLock(file, { log: quiet });
    await assert.rejects(() => acquireLock(file, { log: quiet }), /locked by pid/);
    await lock.release();
    const lock2 = await acquireLock(file, { log: quiet });
    await lock2.release();

    // stale: dead pid recorded
    await atomicWrite(file, JSON.stringify({ pid: 999999, host: os.hostname(), startedAt: new Date().toISOString() }));
    const lock3 = await acquireLock(file, { log: quiet });
    assert.ok(lock3);
    await lock3.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('extract: selector, jsonld, and json extractors all produce declared columns', () => {
  const html = `<html><body>
    <div class="card"><h3>One</h3><span class="p" data-cents="100">$1.00</span></div>
    <div class="card"><h3>Two</h3><span class="p" data-cents="200">$2.00</span></div>
    <script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"name":"A","offers":{"price":"1"}},{"name":"B","offers":{"price":"2"}}]}</script>
  </body></html>`;

  const sel = extractPage({
    html,
    columns: ['name', 'cents'],
    source: { extract: { kind: 'selector', row: '.card', fields: { name: 'h3', cents: '.p@data-cents' } } },
  });
  assert.deepEqual(sel.records, [{ name: 'One', cents: '100' }, { name: 'Two', cents: '200' }]);

  const ld = extractPage({
    html,
    columns: ['name', 'price'],
    source: { extract: { kind: 'jsonld', listPath: 'itemListElement', fields: { name: '$.name', price: '$.offers.price' } } },
  });
  assert.deepEqual(ld.records, [{ name: 'A', price: '1' }, { name: 'B', price: '2' }]);

  const tbl = extractPage({
    html: '<table><tr><th>Title</th><th>Price</th></tr><tr><td>X</td><td>9</td></tr></table>',
    columns: ['title', 'price'],
    source: { extract: { kind: 'table', headerMap: { title: 'title', price: 'price' } } },
  });
  assert.deepEqual(tbl.records, [{ title: 'X', price: '9' }]);
});

// ------------------------------------------------- regression: resume budget

test('pipeline: --max-pages is a per-run budget, not an absolute page index', async () => {
  await withSite(async (base) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
    try {
      const cfg = datasetCfg(base);
      const first = await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0, maxPages: 1 });
      assert.equal(first.pages, 1);
      assert.equal(first.newRows, 2, 'page 1 only');
      const st = await loadState(datasetPaths(root, 'books'));
      assert.equal(st.sources.main.page, 1);
      assert.equal(st.sources.main.done, false);

      const second = await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0, maxPages: 1 });
      assert.equal(second.pages, 1, 'resumes and does one more page');
      assert.equal(second.newRows, 1, 'Beta deduped, Gamma new');
      assert.equal(second.duplicates, 1);
      const done = await loadState(datasetPaths(root, 'books'));
      assert.equal(done.sources.main.done, true, 'end of pagination detected');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test('pipeline: provenance columns are auto-filled even when the extractor blanks them', async () => {
  await withSite(async (base) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
    try {
      const cfg = validateDataset({
        name: 'prov',
        columns: [{ name: 'title' }, { name: 'source' }, { name: 'url', type: 'url' }, { name: 'scraped_at', type: 'datetime' }],
        sources: [{
          id: 'main',
          url: `${base}/page1`,
          extract: { kind: 'selector', row: 'table.grid tbody tr', fields: { title: 'td:first-child', source: 'p.missing', url: 'p.missing', scraped_at: 'p.missing' } },
        }],
      });
      const summary = await runDataset(cfg, { root, log: quiet, minDelayMs: 0, cacheTtlSec: 0 });
      // the plan has no pagination, but the page offers a next link: the
      // engine follows the listing instead of stopping at page 1
      assert.equal(summary.pages, 2, 'both pages crawled');
      assert.equal(summary.newRows, 4, 'every row of the listing was ingested');
      assert.equal(summary.paginationFixed.length, 1, 'the missed pagination was reported');
      assert.equal(summary.paginationFixed[0].nextUrl, `${base}/page2`);
      const { header, rows } = parseCsv(await readFile(datasetPaths(root, 'prov').csv, 'utf8'));
      const iSource = header.indexOf('source');
      const iUrl = header.indexOf('url');
      const iAt = header.indexOf('scraped_at');
      assert.equal(rows[0][iSource], 'main');
      assert.match(rows[0][iUrl], /\/page1$/);
      assert.match(rows[0][iAt], /^\d{4}-\d\d-\d\dT/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// --------------------------------------------- regression: agent guard rails

test('config: paginate accepts model vocabulary and rejects incomplete templates', async () => {
  const { normalizePaginate } = await import('../src/config.mjs');
  assert.deepEqual(normalizePaginate({ kind: 'link', selector: 'li.next > a', maxPages: 10 }), { mode: 'next', selector: 'li.next > a', max: 10 });
  assert.equal(normalizePaginate({ mode: 'pageNumbers', urlTemplate: 'https://e.com?p={page}', max: 3 }).mode, 'pageNumbers');
  assert.throws(() => normalizePaginate({ mode: 'pageNumbers' }), /urlTemplate is required/);
  assert.equal(normalizePaginate(null), null);
});

test('agent: proposal sanitiser drops bad maps and empty specs, verifier enforces real columns', async () => {
  const { sanitizeProposal, verifyProposal } = await import('../src/agent.mjs');
  const cfg = validateDataset({ name: 'q', columns: [{ name: 'quote' }, { name: 'author' }, { name: 'source' }], sources: [{ id: 'main', url: 'https://e.com' }] });
  const source = { id: 'main', url: 'https://e.com', extract: { kind: 'selector', row: 'div.old' } };

  const proposal = {
    extract: { kind: 'selector', row: 'div.quote', fields: { quote: 'span.text', author: 'small.author', source: {}, bogus: 'x' } },
    map: { quote: 'span.text', author: 'small.author' },
  };
  const clean = sanitizeProposal(cfg, proposal);
  assert.deepEqual(Object.keys(clean.extract.fields), ['quote', 'author'], 'empty {} and undeclared fields removed');
  assert.deepEqual(clean.map, {}, 'selector-valued map entries discarded');

  const html = '<div class="quote"><span class="text">Q1</span><small class="author">A1</small></div>';
  const ok = verifyProposal(cfg, source, clean, html);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(ok.columns.sort(), ['author', 'quote']);

  const useless = verifyProposal(cfg, source, { extract: { kind: 'selector', row: 'div.nope', fields: { quote: 'span.text' } } }, html);
  assert.equal(useless.ok, false);
  assert.match(useless.reason, /0 non-empty rows|matched only/);
});

test('config: the row order can be declared, changed and reset without touching the rest of the config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
  try {
    const file = path.join(root, 'books.json');
    const cfg = validateDataset({
      name: 'books',
      columns: [{ name: 'title' }, { name: 'price', type: 'number' }],
      key: ['title'],
      sources: [{ id: 'main', url: 'https://example.com/', extract: { kind: 'table' } }],
    });
    await writeFile(file, JSON.stringify({ ...cfg, sources: [{ ...cfg.sources[0], headers: { authorization: 'Bearer x' } }] }, null, 2));

    await setDatasetOrder(file, 'price:desc');
    let raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw.sortBy, 'price:desc');
    assert.deepEqual(raw.sources[0].headers, { authorization: 'Bearer x' }, 'other fields survive the change');

    await setDatasetOrder(file, null);
    raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw.sortBy, null, 'the order can be reset to ingest order');

    await assert.rejects(() => setDatasetOrder(file, 'ghost:asc'), /unknown column/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('csv: sortBy flips the row order, and ties break on ingest order', () => {
  const rows = [
    { _ord: 1, date: '2026-01-03', v: 2 },
    { _ord: 2, date: '2026-01-01', v: 2 },
    { _ord: 3, date: '2026-01-02', v: 1 },
  ];
  const cfg = { sortBy: 'date:asc', columns: ['date', 'v'] };
  const asc = orderRows(rows, cfg).map((r) => r.date);
  assert.deepEqual(asc, ['2026-01-01', '2026-01-02', '2026-01-03']);
  const desc = orderRows(rows, { sortBy: 'date:desc', columns: ['date', 'v'] }).map((r) => r.date);
  assert.deepEqual(desc, ['2026-01-03', '2026-01-02', '2026-01-01']);
  const ingest = orderRows(rows, { sortBy: null }).map((r) => r._ord);
  assert.deepEqual(ingest, [1, 2, 3], 'no sortBy means ingest order');
});

test('pipeline: the streamed CSV is byte-identical to the in-memory one', async () => {
  const { writeCsv, writeCsvStreaming, verifyCsv } = await import('../src/csvio.mjs');
  const { streamJsonl } = await import('../src/store.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-stream-'));
  try {
    const rows = [
      { _ord: 1, _key: 'a', title: 'Alpha, with comma', price: '10' },
      { _ord: 2, _key: 'b', title: 'Beta "quoted"', price: '20' },
      { _ord: 3, _key: 'c', title: '', price: '' },
    ];
    const cfg = validateDataset({
      name: 'stream',
      columns: [{ name: 'title' }, { name: 'price' }],
      key: ['title'],
      sources: [{ id: 'main', url: 'https://example.com/', extract: { kind: 'table' } }],
    });
    const dir = path.join(root, 'data', 'stream');
    await mkdir(dir, { recursive: true });
    const raw = path.join(dir, 'raw.jsonl');
    await writeFile(raw, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const mem = path.join(root, 'mem');
    await mkdir(mem, { recursive: true });
    const st = path.join(root, 'str');
    await mkdir(st, { recursive: true });

    await writeCsv({ csv: path.join(mem, 'stream.csv'), manifest: path.join(mem, 'manifest.json') }, cfg, rows, { log: () => {} });
    await writeCsvStreaming({ csv: path.join(st, 'stream.csv'), manifest: path.join(st, 'manifest.json') }, cfg, streamJsonl(raw), { log: () => {} });

    const a = await readFile(path.join(mem, 'stream.csv'), 'utf8');
    const b = await readFile(path.join(st, 'stream.csv'), 'utf8');
    assert.equal(b, a, 'the streamed CSV is byte-identical');
    const ma = JSON.parse(await readFile(path.join(mem, 'manifest.json'), 'utf8'));
    const mb = JSON.parse(await readFile(path.join(st, 'manifest.json'), 'utf8'));
    assert.equal(mb.rows, ma.rows);
    assert.equal(mb.csvSha256, ma.csvSha256, 'the manifest hash matches');
    const check = await verifyCsv({ csv: path.join(st, 'stream.csv'), manifest: path.join(st, 'manifest.json') });
    assert.ok(check.ok, `the streamed CSV verifies: ${JSON.stringify(check.problems)} reason=${check.reason}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------- honesty: types, dates, repairs

test('config: a date column keeps the precision the source gave', async () => {
  const { coerce } = await import('../src/config.mjs');
  const day = coerce({ name: 'd', type: 'date' }, 'July 1, 2025');
  assert.equal(day.value, '2025-07-01');
  assert.equal(day.precision, 'day');
  const stamp = coerce({ name: 'd', type: 'datetime' }, '2025-07-01T09:30:00Z');
  assert.equal(stamp.value, '2025-07-01T09:30:00.000Z');
  assert.equal(stamp.precision, 'second');
  const month = coerce({ name: 'd', type: 'date' }, '2025-07');
  assert.equal(month.value, '2025-07', 'a month is not a day');
  const ambiguous = coerce({ name: 'd', type: 'date' }, '03/04/2025');
  assert.equal(ambiguous.ok, false, 'an unreadable day/month order is refused');
});

test('timeorder: the precision of a time axis is measured, not assumed', async () => {
  const { detectTimeKind } = await import('../src/timeorder.mjs');
  const days = detectTimeKind(['July 1, 2025', 'February 1, 2015', 'March 28, 2023']);
  assert.equal(days.kind, 'parsed');
  assert.equal(days.precision, 'day');
  const stamps = detectTimeKind(['2025-07-01T09:30:00Z', '2025-07-02T09:30:00Z']);
  assert.equal(stamps.precision, 'second');
  const months = detectTimeKind(['2025-07', '2025-08']);
  assert.equal(months.kind, 'yearMonth');
  assert.equal(months.precision, 'month');
});

test('repair: the stale rows of a repaired source are dropped, so the repair bites', async () => {
  const { dropSourceRows } = await import('../src/store.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
  try {
    const paths = datasetPaths(root, 'stale');
    await mkdir(paths.base, { recursive: true });
    await appendLines(paths.raw, [
      { _ord: 1, _src: 'main', title: 'A' },
      { _ord: 2, _src: 'other', title: 'B' },
      { _ord: 3, _src: 'main', title: 'C' },
    ]);
    const res = await dropSourceRows(paths, 'main');
    assert.equal(res.dropped, 2);
    assert.equal(res.kept, 1);
    const { rows } = await readJsonl(paths.raw);
    assert.deepEqual(rows.map((r) => r.title), ['B'], 'only the other source survives');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('agent: the column type is decided by the data, not by the plan', async () => {
  const { typeColumnsByData } = await import('../src/agent.mjs');
  const cfg = { columns: [{ name: 'when', type: 'datetime' }, { name: 'title', type: 'string' }] };
  const changed = typeColumnsByData(cfg, [{ when: 'July 1, 2025', title: 'x' }], {});
  assert.equal(cfg.columns[0].type, 'date', 'a date-only source is not a timestamp');
  assert.equal(cfg.columns[1].type, 'string');
  assert.equal(changed.length, 1);
});
