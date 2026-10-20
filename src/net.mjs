// Politeness + resilience layer: robots.txt, per-host rate limiting, retries
// with backoff, timeouts, and a conditional-GET disk cache.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getProfile } from './profile.mjs';
import { Renderer, findBrowser } from './render.mjs';

const UA = 'scrape-01/1.0 (+local dataset builder; polite)';
const HONEST_UA = UA;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Node's fetch reports almost everything as "fetch failed". The real reason
// lives in the cause chain: ENOTFOUND, ECONNREFUSED, UND_ERR_HEADERS_OVERFLOW,
// a TLS error, an AggregateError of per-address failures. Say which.
export function describeError(err, depth = 0) {
  if (!err || depth > 4) return 'unknown error';
  if (err.code && err.code !== 'ERR_INVALID_URL') return String(err.code);
  const cause = err.cause;
  if (!cause) return String(err.message || err);
  if (cause.errors?.length) {
    return cause.errors.map((e) => describeError(e, depth + 1)).filter((s, i, a) => a.indexOf(s) === i).join(' / ');
  }
  const inner = describeError(cause, depth + 1);
  return inner && inner !== String(err.message) ? inner : String(cause.message || cause);
}

export function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

// ---------------------------------------------------------------- robots.txt

export function parseRobots(txt) {
  const groups = [];
  let cur = null;
  for (const line of txt.split(/\r?\n/)) {
    const s = line.replace(/#.*/, '').trim();
    if (!s) continue;
    const idx = s.indexOf(':');
    if (idx === -1) continue;
    const field = s.slice(0, idx).trim().toLowerCase();
    const value = s.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
    } else if (!cur) continue;
    else if (field === 'disallow') { if (value) cur.rules.push({ allow: false, path: value }); }
    else if (field === 'allow') { if (value) cur.rules.push({ allow: true, path: value }); }
    else if (field === 'crawl-delay') { const n = Number(value); if (Number.isFinite(n)) cur.delay = n; }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a === '*' || UA.toLowerCase().includes(a)));
  const chosen = mine.length ? mine : [];
  return {
    rules: chosen.flatMap((g) => g.rules),
    delay: chosen.reduce((m, g) => (g.delay != null ? Math.max(m, g.delay) : m), 0),
  };
}

function robotsMatch(pathname, rulePath) {
  // '#' wildcards and '$' end-anchors, per the de-facto standard
  const esc = rulePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const anchored = esc.endsWith('\\$') ? esc : esc + '.*';
  const body = anchored.replace(/\\\$.*$/, '$');
  try { return new RegExp('^' + body).test(pathname); } catch { return false; }
}

export function robotsAllows(robots, url) {
  if (!robots || !robots.rules.length) return true;
  const u = new URL(url);
  const target = u.pathname + (u.search || '');
  let best = null;
  for (const r of robots.rules) {
    if (!robotsMatch(target, r.path)) continue;
    if (!best || r.path.length > best.path.length) best = r;
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------- client

export function createClient({ cacheDir, cacheTtlSec = 86400, minDelayMs = 1000, maxBytes = 8 << 20, log = () => {}, profile: profileInput = null } = {}) {
  // A profile owns the manners (robots, delay, UA) and the budget (retries, timeout).
  const profile = profileInput
    ? { ...profileInput, limits: { ...(profileInput.limits || {}) } }
    : { ...getProfile('polite'), limits: { ...getProfile('polite').limits } };
  const ua = profile.userAgent || UA;
  const delayFloor = Math.max(0, Number(profile.minDelayMs ?? minDelayMs) || 0);

  const hostState = new Map(); // host -> { next: ts, delay, robots, robotsFetched }
  const stats = { requests: 0, fromCache: 0, retries: 0, blocked: 0, bytes: 0, robotsIgnored: 0, rendered: 0, renderFailed: 0, renderFallback: 0, uaFallback: 0 };
  let renderer = null;
  let rendererBroken = false;
  const robotsWarned = new Set();

  function hostOf(url) {
    const h = new URL(url).host;
    if (!hostState.has(h)) hostState.set(h, { next: 0, delay: delayFloor, robots: null, robotsFetched: 0, count: 0 });
    return hostState.get(h);
  }

  // Pacing: a fixed delay is a signature. Jitter plus an occasional "thinking"
  // pause makes the cadence ordinary, and costs the site the same.
  function nextDelay(st) {
    const j = profile.jitter || null;
    let ms = st.delay;
    if (j) ms += Math.round(Math.random() * (j.max - j.min || 0)) + (j.min || 0);
    st.count++;
    if (profile.thinkPause && st.count % (profile.thinkPause.every || 25) === 0) {
      ms += profile.thinkPause.min + Math.round(Math.random() * (profile.thinkPause.max - profile.thinkPause.min || 0));
    }
    return ms;
  }

  async function throttle(url) {
    const st = hostOf(url);
    const now = Date.now();
    const wait = st.next - now;
    if (wait > 0) await sleep(wait);
    st.next = Date.now() + nextDelay(st);
  }

  async function rawFetch(url, { headers = {}, method = 'GET', timeoutMs = 30000 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method,
        redirect: 'follow',
        signal: ac.signal,
        headers: {
          'user-agent': ua,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          ...headers,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // JavaScript rendering: one local browser per client, started on first use.
  async function getRenderer() {
    if (renderer || rendererBroken) return renderer;
    try {
      renderer = await Renderer.create({ userAgent: ua, log });
      log('info', { msg: 'js renderer ready', browser: renderer.bin });
    } catch (err) {
      rendererBroken = true;
      log('warn', { msg: 'js rendering unavailable, falling back to raw html', error: String(err.message || err) });
    }
    return renderer;
  }

  async function ensureRobots(url) {
    const st = hostOf(url);
    const u = new URL(url);
    if (st.robotsFetched && Date.now() - st.robotsFetched < 6 * 3600e3) return st.robots;
    st.robotsFetched = Date.now();
    try {
      const res = await rawFetch(`${u.protocol}//${u.host}/robots.txt`, { timeoutMs: 8000 });
      st.robots = res.ok ? parseRobots(await res.text()) : parseRobots('');
      if (st.robots.delay) st.delay = Math.max(st.delay, st.robots.delay * 1000);
      log('debug', { msg: 'robots.txt', host: u.host, status: res.status, rules: st.robots.rules.length, delaySec: st.robots.delay });
    } catch (err) {
      st.robots = parseRobots('');
      log('debug', { msg: 'robots.txt unavailable', host: u.host, error: String(err.message || err) });
    }
    return st.robots;
  }

  async function cachePath(url) {
    const key = sha1(url);
    return { meta: path.join(cacheDir, key + '.json'), body: path.join(cacheDir, key + '.body') };
  }

  async function readCache(url, ttlSec) {
    if (!cacheDir || ttlSec <= 0) return null;
    const p = await cachePath(url);
    try {
      const meta = JSON.parse(await readFile(p.meta, 'utf8'));
      const body = await readFile(p.body, 'utf8');
      const age = (Date.now() - meta.fetchedAt) / 1000;
      return { ...meta, body, fresh: age < ttlSec, ageSec: Math.round(age) };
    } catch {
      return null;
    }
  }

  async function writeCache(url, meta, body) {
    if (!cacheDir) return;
    const p = await cachePath(url);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(p.body, body, 'utf8');
    await writeFile(p.meta, JSON.stringify(meta, null, 2), 'utf8');
  }

  async function get(url, { retries = profile.retries, timeoutMs = profile.timeoutMs, useCache = true, cacheTtlSec = cacheTtlSec, headers = {} } = {}) {
    if (!/^https?:/i.test(url)) throw new Error(`unsupported url: ${url}`);

    const cached = useCache ? await readCache(url, cacheTtlSec) : null;
    // a raw body cached under a rendering profile is not what the caller asked for
    const cacheUsable = cached && cached.fresh && !(profile.render && cached.rendered === false);
    if (cacheUsable) {
      stats.fromCache++;
      log('debug', { msg: 'cache hit', url, ageSec: cached.ageSec });
      return { url: cached.finalUrl || url, status: cached.status, contentType: cached.contentType, body: cached.body, fromCache: true, fetchedAt: cached.fetchedAt };
    }

    if (profile.robots === false) {
      // monster mode: the site's crawl policy is deliberately overridden
      stats.robotsIgnored++;
      const host = new URL(url).host;
      if (!robotsWarned.has(host)) {
        robotsWarned.add(host);
        log('warn', { msg: 'robots.txt IGNORED (monster profile)', host, note: 'the site asked not to be crawled; you are overriding that on purpose' });
      }
    } else {
      const robots = await ensureRobots(url);
      if (!robotsAllows(robots, url)) {
        stats.blocked++;
        log('warn', { msg: 'robots.txt disallows', url });
        const e = new Error(`robots.txt disallows ${url}`);
        e.code = 'ROBOTS_DISALLOWED';
        throw e;
      }
    }

    let lastErr;
    // A transport-level failure (headers over the limit, TLS, HTTP/2) repeats
    // itself; in monster mode the browser is the better path, so try raw twice
    // at most and then hand over.
    const rawAttempts = profile.render ? Math.min(retries, 1) : retries;
    let attempt = 0;
    let usedHonestUA = false;
    let uaHeader = ua;
    while (attempt <= rawAttempts) {
      if (attempt) { stats.retries++; await sleep(Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.random() * 250); }
      await throttle(url);
      try {
        const conditional = cached ? {
          ...(cached.etag ? { 'if-none-match': cached.etag } : {}),
          ...(cached.lastModified ? { 'if-modified-since': cached.lastModified } : {}),
        } : {};
        const res = await rawFetch(url, { headers: { ...headers, ...conditional, 'user-agent': uaHeader }, timeoutMs });
        stats.requests++;

        if (res.status === 304 && cached) {
          stats.fromCache++;
          await writeCache(url, { ...cached, fetchedAt: Date.now(), body: undefined }, cached.body).catch(() => {});
          return { url: cached.finalUrl || url, status: 304, contentType: cached.contentType, body: cached.body, fromCache: true, fetchedAt: Date.now(), rendered: !!cached.rendered };
        }
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get('retry-after'));
          lastErr = new Error(`HTTP ${res.status} for ${url}`);
          if (Number.isFinite(ra) && ra > 0) await sleep(Math.min(60_000, ra * 1000));
          continue;
        }
        if (!res.ok && res.status !== 404) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });

        const buf = Buffer.from(await res.arrayBuffer());
        stats.bytes += buf.byteLength;
        if (buf.byteLength > maxBytes) throw new Error(`response too large (${buf.byteLength} bytes) for ${url}`);
        const body = buf.toString('utf8');
        const meta = {
          url,
          finalUrl: res.url || url,
          status: res.status,
          contentType: res.headers.get('content-type') || '',
          etag: res.headers.get('etag') || null,
          lastModified: res.headers.get('last-modified') || null,
          fetchedAt: Date.now(),
          rendered: false,
          title: '',
        };
        if (useCache && res.status === 200) await writeCache(url, meta, body).catch(() => {});
        return { ...meta, body, fromCache: false };
      } catch (err) {
        lastErr = err;
        if (err.code === 'ROBOTS_DISALLOWED') throw err;
        const reason = describeError(err);
        // Some edges answer a BROWSER user agent with an oversized header set
        // (a consent/redirect chain) that undici refuses to read. Falling back
        // to the honest UA fixes it, and it never means pretending to be a
        // browser: a polite run keeps its honest identity for ever.
        if (!usedHonestUA && uaHeader !== HONEST_UA && /UND_ERR|HEADERS_OVERFLOW|ECONNRESET|socket/i.test(reason)) {
          usedHonestUA = true;
          uaHeader = HONEST_UA;
          stats.uaFallback++;
          log('info', { msg: 'retrying with the plain user agent', url, reason });
          continue; // same attempt, different identity
        }
        if (attempt >= rawAttempts) log('warn', { msg: 'request failed', url, attempt, error: reason, detail: String(err.message || err) });
        else log('debug', { msg: 'request failed', url, attempt, error: reason });
        attempt++;
      }
    }

    // Plain HTTP could not read the response at all (headers over the parser
    // limit, TLS fingerprinting, odd HTTP/2). In monster mode the browser is
    // the fallback: it negotiates the same page a human would see.
    if (profile.render) {
      const r = await getRenderer();
      if (r) {
        try {
          const out = await r.render(url, { timeoutMs: Math.max(timeoutMs, 45000), settleMs: profile.settleMs || 0 });
          if (out.html) {
            stats.renderFallback++;
            log('info', { msg: 'raw http failed; the renderer served the page', url, reason: describeError(lastErr), bytes: out.html.length, finalUrl: out.finalUrl });
            const meta = { url, finalUrl: out.finalUrl || url, status: 200, contentType: 'text/html; charset=utf-8', fetchedAt: Date.now(), rendered: true, title: out.title || '' };
            if (useCache) await writeCache(url, meta, out.html).catch(() => {});
            return { ...meta, body: out.html, fromCache: false };
          }
        } catch (err) {
          log('warn', { msg: 'render fallback failed', url, error: describeError(err) });
        }
      }
    }

    const reason = describeError(lastErr);
    throw Object.assign(new Error(`fetch failed for ${url}: ${reason}`), { cause: lastErr, url, reason });
  }

  // The browser is a FALLBACK, not the default: raw HTML first, and only
  // render when the raw page carries no records. Cheaper for the site, and it
  // keeps the common case free of a 20-second browser round trip.
  async function renderPage(url, { timeoutMs = 45000 } = {}) {
    const r = await getRenderer();
    if (!r) return null;
    try {
      const out = await r.render(url, { timeoutMs, settleMs: profile.settleMs || 0 });
      if (!out.html) return null;
      stats.rendered++;
      log('info', { msg: 'page rendered', url, bytes: out.html.length, finalUrl: out.finalUrl });
      return { html: out.html, finalUrl: out.finalUrl || url, title: out.title || '' };
    } catch (err) {
      stats.renderFailed++;
      log('warn', { msg: 'render failed', url, error: describeError(err) });
      return null;
    }
  }

  function setHostDelay(url, ms) {
    const st = hostOf(url);
    st.delay = Math.max(st.delay, ms);
  }

  async function close() {
    if (renderer) { try { await renderer.close(); } catch { /* ignore */ } renderer = null; }
  }

  return { get, stats, setHostDelay, close, profile, renderPage };
}

export async function fileAge(file) {
  try { return (Date.now() - (await stat(file)).mtimeMs) / 1000; } catch { return Infinity; }
}
