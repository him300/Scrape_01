// Monster mode: profile resolution, robots override, JS rendering, and the
// embedded-JSON + auto-fallback extraction paths that make JS sites scrapable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveProfile, getProfile, MIN_DELAY_FLOOR_MS } from '../src/profile.mjs';
import { createClient } from '../src/net.mjs';
import { extractPage, extractPageAuto, parseEmbeddedPayload, detectPagination } from '../src/extract.mjs';
import { validateDataset } from '../src/config.mjs';
import { findBrowser, Renderer } from '../src/render.mjs';
import { makeClient } from '../src/pipeline.mjs';
import { describeError } from '../src/net.mjs';
import { jsonCandidates, recordAnatomy, htmlBrief } from '../src/agent.mjs';
import { parseDoc } from '../src/dom.mjs';

const quiet = () => {};

// ----------------------------------------------------------------- profile

test('profile: polite obeys robots, monster renders and does not', () => {
  const polite = resolveProfile({});
  const monster = resolveProfile({ monster: true });
  assert.equal(polite.robots, true);
  assert.equal(polite.render, false);
  assert.equal(monster.robots, false);
  assert.equal(monster.render, true);
  assert.ok(monster.minDelayMs < polite.minDelayMs, 'monster is faster');
  assert.ok(monster.limits.maxPages > polite.limits.maxPages, 'monster has a bigger budget');
});

test('profile: the delay floor cannot be negotiated away', () => {
  const p = resolveProfile({ monster: true, overrides: { minDelayMs: 0 } });
  assert.equal(p.minDelayMs, MIN_DELAY_FLOOR_MS);
  assert.equal(p.concurrency, 1, 'requests stay sequential');
});

test('profile: a dataset profile beats the run flag, and both beat the default', () => {
  const p = resolveProfile({ datasetProfile: 'monster', monster: false });
  assert.equal(p.mode, 'monster');
  const q = resolveProfile({ datasetProfile: 'polite', monster: true });
  assert.equal(q.mode, 'polite');
});

// --------------------------------------------------------------------- net

function makeSite() {
  return (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /private\n'); }
    if (req.url === '/private/thing') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body><p class="secret">secret</p></body></html>'); }
    if (req.url === '/js') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><head><title>App</title></head><body>
        <div id="root"></div>
        <script>document.getElementById('root').innerHTML = '<div class="row">rendered-row</div>';</script>
      </body></html>`);
    }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('nope');
  };
}

async function withSite(fn) {
  const server = http.createServer(makeSite());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('net: polite refuses a robots-disallowed page, monster fetches it', async () => {
  await withSite(async (base) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-'));
    try {
      const polite = createClient({ cacheDir: path.join(root, 'cache'), cacheTtlSec: 0, minDelayMs: 0, profile: getProfile('polite') });
      await assert.rejects(() => polite.get(`${base}/private/thing`, { cacheTtlSec: 0 }), (err) => err.code === 'ROBOTS_DISALLOWED');

      const monster = createClient({ cacheDir: path.join(root, 'cache'), cacheTtlSec: 0, profile: getProfile('monster') });
      const res = await monster.get(`${base}/private/thing`, { cacheTtlSec: 0 });
      assert.equal(res.status, 200);
      assert.match(res.body, /secret/);
      assert.equal(monster.stats.robotsIgnored, 1);
      await monster.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ----------------------------------------------------------------- extract

test('extract: a JS assignment payload (var X = {...}) is parsed', () => {
  const payload = parseEmbeddedPayload('var ytInitialData = {"contents":{"a":[1,2]}};');
  assert.deepEqual(payload, { contents: { a: [1, 2] } });
  const named = parseEmbeddedPayload('window.__DATA__ = {"x":1};', '__DATA__');
  assert.deepEqual(named, { x: 1 });
  const pure = parseEmbeddedPayload('{"x":2}');
  assert.deepEqual(pure, { x: 2 });
  assert.equal(parseEmbeddedPayload('not json at all'), null);
});

test('extract: embedded JSON is read through a script selector with varName', () => {
  const html = `<html><body><script>var ytInitialData = {"items":[{"name":"Alpha","subs":"1.2K"}]}</script></body></html>`;
  const source = { id: 'main', extract: { kind: 'json', scriptSelector: 'script', varName: 'ytInitialData', path: 'items', fields: { name: '$.name', subs: '$.subs' } } };
  const res = extractPage({ html, source, columns: ['name', 'subs'] });
  assert.equal(res.records.length, 1);
  assert.equal(res.records[0].name, 'Alpha');
  assert.equal(res.records[0].subs, '1.2K');
});

test('extract: auto fallback recovers rows when the declared extractor matches nothing', () => {
  const html = `<html><body><script>var data = {"rows":[{"t":"A"},{"t":"B"}]}</script></body></html>`;
  const source = { id: 'main', extract: { kind: 'selector', row: '.never-matches', fields: { t: 'span' } } };
  const declared = extractPage({ html, source, columns: ['t'] });
  assert.equal(declared.records.length, 0, 'declared extractor is barren');

  const auto = extractPageAuto({ html, source, columns: ['t'] });
  assert.equal(auto.strategy, 'json');
  assert.equal(auto.records.length, 2);
  assert.equal(auto.records[0].t, 'A');
  assert.ok(auto.attempts.length > 1, 'the attempts are reported');
});

// ------------------------------------------------------------------ config

test('config: a dataset may pin a profile and it survives validation', () => {
  const cfg = validateDataset({
    name: 'x',
    profile: 'monster',
    columns: [{ name: 'a' }],
    sources: [{ id: 'main', url: 'https://example.com/', extract: { kind: 'table' } }],
  });
  assert.equal(cfg.profile, 'monster');
  assert.throws(() => validateDataset({
    name: 'x', profile: 'ludicrous',
    columns: [{ name: 'a' }],
    sources: [{ id: 'main', url: 'https://example.com/', extract: { kind: 'table' } }],
  }), /unknown profile/);
});

// ------------------------------------------------------------------ brief

test('brief: the model is shown ids, sample text and the record anatomy', () => {
  const html = `<html><body>
    <div class="card"><a id="title" href="/x">Alpha</a><span id="subs">1.2K subscribers</span></div>
    <div class="card"><a id="title" href="/y">Beta</a><span id="subs">300 subscribers</span></div>
    <script>var payload = {"rows":[{"name":"Alpha","count":"12"}]}</script>
  </body></html>`;
  const brief = htmlBrief(html, { goal: 'subscriber count per channel' });
  assert.match(brief, /ELEMENT IDS/);
  assert.match(brief, /#subs/);
  assert.match(brief, /subscribers/, 'ids carry their sample text');
  assert.match(brief, /RECORD ANATOMY/);
  assert.match(brief, /CANDIDATE RECORD ARRAYS|EMBEDDED JSON VARIABLES/);
});

test('brief: the record array in an embedded payload is found, with values', () => {
  const payload = { contents: { list: { items: [{ title: { simpleText: 'Morphic Lab' }, subs: { simpleText: '1.85K subscribers' } }] } } };
  const cands = jsonCandidates(payload);
  assert.ok(cands.length >= 1);
  assert.equal(cands[0].path, 'contents.list.items');
  assert.ok(cands[0].leaves.some((l) => l.value === '1.85K subscribers'), 'leaf values are shown');
});

test('brief: the anatomy of a repeating card lists its ids and their text', () => {
  const html = `<html><body>
    <ytd-channel-renderer><div id="info"><a id="main-link" href="/@x">Morphic</a><span id="meta">@x•1.85K subscribers</span></div></ytd-channel-renderer>
    <ytd-channel-renderer><div id="info"><a id="main-link" href="/@y">Other</a><span id="meta">@y•12 subscribers</span></div></ytd-channel-renderer>
  </body></html>`;
  const doc = parseDoc(html);
  const anatomy = recordAnatomy(doc, { goal: 'subscriber count' });
  assert.match(anatomy, /RECORD ANATOMY/);
  assert.match(anatomy, /ytd-channel-renderer|#meta|#main-link/);
});

// ------------------------------------------------------------------ errors

test('net: a failed fetch says WHY, not just "fetch failed"', () => {
  const overflow = new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Overflow Error'), { code: 'UND_ERR_HEADERS_OVERFLOW' }) });
  assert.equal(describeError(overflow), 'UND_ERR_HEADERS_OVERFLOW');

  const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' }) });
  assert.equal(describeError(dns), 'ENOTFOUND');

  const agg = new TypeError('fetch failed', { cause: Object.assign(new AggregateError([
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  ], 'all failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  assert.match(describeError(agg), /ECONNREFUSED/);

  assert.equal(describeError(new Error('plain')), 'plain');
});

// ------------------------------------------------------------------ render

test('render: JavaScript is executed before extraction (skipped without a browser)', async (t) => {
  const bin = findBrowser();
  if (!bin) return t.skip('no Chrome/Edge/Chromium installed');
  await withSite(async (base) => {
    const r = await Renderer.create({ bin });
    try {
      const out = await r.render(`${base}/js`, { settleMs: 600 });
      assert.match(out.html, /rendered-row/, 'the DOM mutation is visible in the rendered HTML');
      assert.match(out.html, /App/, 'the title is captured');
    } finally {
      await r.close();
    }
  });
});

// ---------------------------------------------------------- json endpoints

test('extract: a raw JSON endpoint is read, and parallel arrays are zipped by index', () => {
  const payload = {
    chart: { result: [{
      timestamp: [1700000000, 1700003600, 1700007200],
      indicators: { quote: [{ open: [1, 2, 3], high: [2, 3, 4], low: [0.5, 1.5, 2.5], close: [1.5, 2.5, 3.5], volume: [10, 20, 30] }] },
    }] },
  };
  const source = {
    id: 'main',
    extract: {
      kind: 'json',
      path: 'chart.result[0].timestamp',
      fields: {
        datetime: { json: 'chart.result[0].timestamp', indexed: true, as: 'iso' },
        close: { json: 'chart.result[0].indicators.quote[0].close', indexed: true },
        volume: '$#chart.result[0].indicators.quote[0].volume',
      },
    },
  };
  const res = extractPage({ html: JSON.stringify(payload), source, columns: ['datetime', 'close', 'volume'] });
  assert.equal(res.records.length, 3);
  assert.equal(res.records[1].close, '2.5', 'row 1 took element 1 of the close array');
  assert.equal(res.records[2].volume, '30', 'the $# shorthand indexes the same way');
  assert.equal(res.records[0].datetime, new Date(1700000000 * 1000).toISOString(), 'epoch seconds became an ISO datetime');
});

test('config: a dataset may declare placeholder rows (all-zero) and they are dropped', async () => {
  const cfg = validateDataset({
    name: 'fx',
    dropAllZero: ['open', 'close'],
    columns: [{ name: 'datetime' }, { name: 'open', type: 'number' }, { name: 'close', type: 'number' }],
    sources: [{ id: 'main', url: 'https://example.com/', extract: { kind: 'table' } }],
  });
  assert.deepEqual(cfg.dropAllZero, ['open', 'close']);
  assert.throws(() => validateDataset({
    name: 'fx', dropAllZero: ['ghost'],
    columns: [{ name: 'a' }],
    sources: [{ id: 'main', url: 'https://example.com/', extract: { kind: 'table' } }],
  }), /unknown column/);
});

// ------------------------------------------------------------- time order

test('timeorder: a time axis is detected from the VALUES, whatever the type', async () => {
  const { detectTimeKind, detectTimeColumn, compareTime } = await import('../src/timeorder.mjs');

  assert.equal(detectTimeKind(['2026-10-19', '2026-10-20']).kind, 'iso');
  assert.equal(detectTimeKind(['1792454400', '1792540800']).kind, 'epochSeconds');
  assert.equal(detectTimeKind(['1792454400000', '1792540800000']).kind, 'epochMillis');
  assert.equal(detectTimeKind(['Oct 20, 2026', 'Oct 21, 2026']).kind, 'parsed');
  assert.equal(detectTimeKind(['2026-10', '2026-11']).kind, 'yearMonth');

  // day-first vs month-first: only accepted when a value breaks the tie
  assert.equal(detectTimeKind(['01/02/2026', '03/04/2026']).kind, null, 'ambiguous dates are refused');
  assert.equal(detectTimeKind(['25/12/2025', '03/04/2026']).kind, 'dayFirst');
  assert.equal(detectTimeKind(['12/25/2025', '03/04/2026']).kind, 'monthFirst');

  // a column that never changes is not a time series
  const det = detectTimeColumn(['a', 'b'], [{ a: '2026-01-01', b: 'x' }, { a: '2026-01-01', b: 'y' }], { key: [] });
  assert.equal(det.column, null);
  assert.match(det.reason, /no column holds date-like values|never changes/);

  // the key wins when it is time-like
  const keyed = detectTimeColumn(['t', 'v'], [{ t: '2026-01-02', v: 1 }, { t: '2026-01-01', v: 2 }], { key: ['t'] });
  assert.equal(keyed.column, 't');
  assert.equal(keyed.kind, 'iso');

  // real date comparison, not alphabetical
  assert.ok(compareTime('2026-10-02', '2026-10-10', 'iso') < 0);
  assert.ok(compareTime('2/10/2026', '10/10/2026', 'dayFirst') < 0);
});

test('timeorder: a recorded interpretation makes the CSV sort by date, not by string', async () => {
  const { orderRows } = await import('../src/csvio.mjs');
  const rows = [
    { _ord: 1, d: 'Oct 20, 2026' },
    { _ord: 2, d: 'Jan 05, 2026' },
    { _ord: 3, d: 'Feb 09, 2026' },
  ];
  // alphabetical would put "Feb" first and "Oct" first too — a string sort is wrong
  const byString = orderRows(rows, { sortBy: 'd:asc', columns: ['d'] }).map((r) => r.d);
  const byTime = orderRows(rows, { sortBy: 'd:asc', columns: ['d'], timeKinds: { d: 'parsed' } }).map((r) => r.d);
  assert.deepEqual(byTime, ['Jan 05, 2026', 'Feb 09, 2026', 'Oct 20, 2026']);
  assert.notDeepEqual(byString, byTime, 'the plain string sort really is different');
});

test('config: timeKinds must name declared columns and known kinds', () => {
  const cfg = validateDataset({
    name: 'x',
    timeKinds: { when: 'dayFirst' },
    columns: [{ name: 'when' }],
    sources: [{ id: 'main', url: 'https://example.com/', extract: { kind: 'table' } }],
  });
  assert.deepEqual(cfg.timeKinds, { when: 'dayFirst' });
  assert.throws(() => validateDataset({
    name: 'x', timeKinds: { ghost: 'iso' },
    columns: [{ name: 'a' }],
    sources: [{ id: 'main', url: 'https://example.com/', extract: { kind: 'table' } }],
  }), /unknown column/);
  assert.throws(() => validateDataset({
    name: 'x', timeKinds: { a: 'nonsense' },
    columns: [{ name: 'a' }],
    sources: [{ id: 'main', url: 'https://example.com/', extract: { kind: 'table' } }],
  }), /must be one of/);
});

test('timeorder: a price column is not mistaken for a time axis', async () => {
  const { detectTimeKind, detectTimeColumn } = await import('../src/timeorder.mjs');
  // Date.parse is lenient: "3.10" is a time today, "0" is a date in 2000
  assert.equal(detectTimeKind(['0', '0', '0']).kind, null, 'a column of zeros is not a date axis');
  assert.equal(detectTimeKind(['3.10', '9.90', '1.05']).kind, null, 'a price column is not a date axis');
  assert.equal(detectTimeKind(['12:30', '13:45']).kind, null, 'a time without a date is not an axis');
  assert.equal(detectTimeKind(['2026', '2027']).kind, 'year', 'a string year IS an axis');
  assert.equal(detectTimeKind([2026, 2027]).kind, null, 'a NUMBER that looks like a year is probably a price');

  const det = detectTimeColumn(['when', 'amount'], [
    { when: '2026-10-20', amount: '3.10' }, { when: '2026-01-05', amount: '5.50' },
  ], { key: [] });
  assert.equal(det.column, 'when');
  assert.equal(det.candidates.length, 1, 'the price column is not a candidate');
});

test('agent: an error page is classified as an error state, not as records', async () => {
  const { classifyExtraction } = await import('../src/agent.mjs');
  // Yahoo's own error row: one row, one message, no data
  const err = classifyExtraction([{ timestamp: '', open: '', high: '', low: '', close: '', volume: '', error: 'There are no in the selected time period.' }]);
  assert.equal(err.kind, 'error');
  assert.match(err.text, /in the selected time period/);

  // a real table is records
  const ok = classifyExtraction([
    { t: '2026-01-02', p: '1.1' }, { t: '2026-01-03', p: '1.2' }, { t: '2026-01-04', p: '1.3' },
  ]);
  assert.equal(ok.kind, 'records');

  // nothing matched
  assert.equal(classifyExtraction([]).kind, 'empty');
});

// ------------------------------------------------- browser as a fallback

test('monster: the browser is a fallback, not the default', async () => {
  const http = await import('node:http');
  const staticHtml = `<html><body><table class="t"><tbody>
    <tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></tbody></table></body></html>`;
  const jsHtml = `<html><body><div id="root"></div>
    <script>document.getElementById('root').innerHTML='<table class="t"><tbody><tr><td>X</td><td>9</td></tr></tbody></table>';</script>
    </body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/js' ? jsHtml : staticHtml);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'scrape01-fb-'));
  try {
    const cfg = validateDataset({
      name: 'items',
      columns: [{ name: 'a' }, { name: 'b' }],
      sources: [{ id: 'main', url: `${base}/static`, extract: { kind: 'table', table: 'table.t' } }],
    });
    // a page whose HTML already has the rows: no browser should be launched
    const logs = [];
    const client = makeClient(root, { profile: 'monster', minDelayMs: 0 }, (l, m) => logs.push(m.msg));
    const got = await client.get(`${base}/static`, { cacheTtlSec: 0 });
    assert.equal(got.rendered, false, 'the raw body was used');
    assert.ok(!logs.includes('js renderer ready'), 'no browser was started');
    await client.close();

    // a page that only has the rows after JS runs: the browser IS the fallback
    const client2 = makeClient(root, { profile: 'monster', minDelayMs: 0 }, (l, m) => logs.push(m.msg));
    const { looksLikeData } = await import('../src/extract.mjs');
    const rawJs = (await client2.get(`${base}/js`, { cacheTtlSec: 0 })).body;
    assert.equal(looksLikeData(rawJs), false, 'the raw page has no records');
    const rendered = await client2.renderPage(`${base}/js`, { timeoutMs: 30000 });
    assert.ok(rendered?.html, 'the browser produced a page');
    assert.equal(looksLikeData(rendered.html), true, 'the rendered page has records');
    await client2.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test('monster: the pacing is not a metronome', async () => {
  const p = getProfile('monster');
  assert.ok(p.jitter && p.jitter.max > p.jitter.min, 'the delay is jittered');
  assert.ok(p.thinkPause && p.thinkPause.every > 1, 'occasional longer pauses');
  const polite = getProfile('polite');
  assert.equal(polite.jitter, null, 'polite mode keeps an exact, predictable delay');
});

// ------------------------------------------------- pagination and richness

test('extract: the next-page link is detected in the page, not in the plan', () => {
  const rel = parseDoc('<html><body><a class="next" rel="next" href="/p2">Next</a></body></html>');
  const det = detectPagination(rel, 'https://e.com/p1');
  assert.equal(det.hasNext, true);
  assert.equal(det.next.href, 'https://e.com/p2');
  assert.equal(det.next.why, 'rel=next');

  const byText = parseDoc('<html><body><a href="?page=2">Next ›</a></body></html>');
  const det2 = detectPagination(byText, 'https://e.com/p1');
  assert.equal(det2.hasNext, true);
  assert.equal(det2.next.text, 'Next ›');
  assert.ok(det2.next.selector.includes(':contains('), 'a text link gets a usable selector');

  const none = parsePaginationless();
  assert.equal(none.hasNext, false, 'a page with no next link has no pagination');
});

function parsePaginationless() {
  return detectPagination(parseDoc('<html><body><a href="/about">About</a></body></html>'), 'https://e.com/p1');
}

test('extract: a date column takes the machine-readable value, not the display text', () => {
  const html = `<html><body><div class="row">
      <time datetime="2025-07-01T09:30:00-04:00">July 1, 2025</time>
    </div></body></html>`;
  const source = { id: 'main', extract: { kind: 'selector', row: '.row', fields: { when: 'time' } } };
  const asDate = extractPage({ html, source, columns: ['when'], types: { when: 'date' } });
  assert.equal(asDate.records[0].when, '2025-07-01T09:30:00-04:00', 'the attribute carries the time of day');

  const asString = extractPage({ html, source, columns: ['when'], types: { when: 'string' } });
  assert.equal(asString.records[0].when, 'July 1, 2025', 'a plain string column keeps the display text');
});

test('extract: the meta strategy is never a fallback — a page is not a record', () => {
  const html = `<html><head><meta property="og:title" content="A Blog"></head><body><p>no rows here</p></body></html>`;
  const source = { id: 'main', extract: { kind: 'selector', row: '.never', fields: { t: 'span' } } };
  const auto = extractPageAuto({ html, source, columns: ['t'] });
  assert.equal(auto.records.length, 0, 'no row is invented from the page metadata');
  assert.ok(!auto.attempts.some((a) => a.kind === 'meta'), 'meta is not even tried');
});
