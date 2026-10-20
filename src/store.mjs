// Durable storage. The raw JSONL log is the source of truth; the CSV is a
// deterministic projection of it. Every mutation is: append (fsync) -> then
// advance checkpoint. A crash can therefore only lose un-checkpointed work,
// never corrupt already-committed rows.

import { open, mkdir, readFile, writeFile, rename, readdir, unlink, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

async function fsyncDir(dir) {
  try {
    const dh = await open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* not supported on every platform (Windows) */ }
}

export async function atomicWrite(file, data, { mode = 'utf8' } = {}) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data, mode);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  await fsyncDir(dir);
  return file;
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

export async function writeJson(file, value) {
  return atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

// ------------------------------------------------------------------ paths

export function datasetPaths(root, name) {
  const base = path.join(root, 'data', name);
  return {
    base,
    raw: path.join(base, 'raw.jsonl'),
    rejects: path.join(base, 'rejects.jsonl'),
    state: path.join(base, 'state.json'),
    manifest: path.join(base, 'manifest.json'),
    csv: path.join(base, `${name}.csv`),
    lock: path.join(base, '.lock'),
    runs: path.join(base, 'runs'),
  };
}

// ------------------------------------------------------------- delete

// Removing a dataset takes the config AND everything it produced: the CSV,
// the raw ingest log, checkpoints, rejects. There is no undo — the caller
// must say so before calling this.
export async function removeDataset(root, name) {
  const paths = datasetPaths(root, name);
  const config = path.join(root, 'datasets', `${name}.json`);
  const removed = [];
  try { await unlink(config); removed.push(path.relative(root, config)); } catch { /* already gone */ }
  try {
    await rm(paths.base, { recursive: true, force: true });
    removed.push(path.relative(root, paths.base) + path.sep);
  } catch { /* already gone */ }
  return { dataset: name, removed, config: config, dir: paths.base };
}

// ------------------------------------------------------------- append log

export async function appendLines(file, objects) {
  if (!objects.length) return 0;
  await ensureDir(path.dirname(file));
  const payload = objects.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const fh = await open(file, 'a');
  try {
    await fh.writeFile(payload, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  return objects.length;
}

// Reads a JSONL log, repairing a torn final line left by a hard crash.
//
// STREAMED, not readFile: V8 caps a string at 512 MB, and a big log must not
// die on that (the old readFile path silently returned ZERO rows for a log over
// 512 MB — a dataset that looked empty instead of full).
//
//  keysOnly: return the dedupe keys without holding the rows in memory.
export async function readJsonl(file, { repair = true, log = () => {}, keysOnly = false } = {}) {
  const rows = [];
  const keys = new Set();
  let torn = false;
  let count = 0;

  let handle;
  try { handle = await open(file, 'r'); } catch { return { rows, keys, count, torn: false }; }
  const decoder = null;
  let buf = '';
  let lastGood = '';            // the last complete line, for the repair
  try {
    for await (const chunk of handle.createReadStream({ encoding: 'utf8', highWaterMark: 1 << 20 })) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          count++;
          if (keysOnly) { if (obj._key) keys.add(obj._key); }
          else rows.push(obj);
        } catch {
          log('warn', { msg: 'skipping unparsable line', file, line: count + 1 });
        }
      }
      if (buf.length > 8 * 1024 * 1024) { log('warn', { msg: 'log line is implausibly long; truncating', file, bytes: buf.length }); buf = ''; }
    }
    if (buf.length) {
      // a final line without a newline: a hard crash may have torn it
      try {
        const obj = JSON.parse(buf);
        count++;
        if (keysOnly) { if (obj._key) keys.add(obj._key); } else rows.push(obj);
      } catch {
        torn = true;
        log('warn', { msg: 'torn trailing line in log (crash recovery)', file, bytes: buf.length });
      }
    }
  } catch (err) {
    log('warn', { msg: 'log read failed', file, error: String(err.message || err) });
  }
  if (torn && repair) await repairLog(file, log);
  return { rows, keys, count, torn };
}

// Remove a torn trailing line without loading the file into memory.
async function repairLog(file, log) {
  try {
    const tmp = `${file}.repair`;
    const src = await open(file, 'r');
    const dst = await open(tmp, 'w');
    let buf = '';
    let held = null;
    for await (const chunk of src.createReadStream({ encoding: 'utf8', highWaterMark: 1 << 20 })) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (held !== null) { await dst.write(held + '\n'); }
        held = line;
      }
    }
    // `held` is the last complete line; the leftover `buf` was torn
    if (held !== null) await dst.write(held + '\n');
    await dst.close();
    await src.close();
    await rename(tmp, file);
    log('info', { msg: 'torn trailing line removed from log', file });
  } catch (err) {
    log('warn', { msg: 'could not repair the log', file, error: String(err.message || err) });
  }
}

// Stream a JSONL log row by row — for datasets too big to hold in memory.
export async function* streamJsonl(file, { log = () => {} } = {}) {
  let handle;
  try { handle = await open(file, 'r'); } catch { return; }
  let buf = '';
  try {
    for await (const chunk of handle.createReadStream({ encoding: 'utf8', highWaterMark: 1 << 20 })) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { yield JSON.parse(line); } catch { log('warn', { msg: 'skipping unparsable line', file }); }
      }
      if (buf.length > 8 * 1024 * 1024) { log('warn', { msg: 'log line is implausibly long; truncating', file, bytes: buf.length }); buf = ''; }
    }
    if (buf.length) { try { yield JSON.parse(buf); } catch { /* torn tail */ } }
  } catch (err) {
    log('warn', { msg: 'log stream failed', file, error: String(err.message || err) });
  }
}

// Drop every row a source produced. A repaired extractor produces DIFFERENT
// rows, so the rows the old extractor wrote are stale: keeping them would
// make the re-crawl dedupe against them and the repair would change nothing.
// The log is rewritten, not appended to, and the count is reported.
export async function dropSourceRows(paths, sourceId, { log = () => {} } = {}) {
  const file = paths.raw;
  let handle;
  try { handle = await open(file, 'r'); } catch { return { dropped: 0 }; }
  const tmp = `${file}.repair-${process.pid}`;
  const out = await open(tmp, 'w');
  let dropped = 0;
  let kept = 0;
  let buf = '';
  try {
    for await (const chunk of handle.createReadStream({ encoding: 'utf8', highWaterMark: 1 << 20 })) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        let obj = null;
        try { obj = JSON.parse(line); } catch { dropped++; continue; }
        if (obj && obj._src === sourceId) { dropped++; continue; }
        kept++;
        await out.write(line + '\n');
      }
    }
    if (buf.length) {
      let obj = null;
      try { obj = JSON.parse(buf); } catch { obj = null; }
      if (obj && obj._src === sourceId) dropped++;
      else { kept++; await out.write(buf + '\n'); }
    }
    await out.sync();
  } finally {
    await out.close();
    await handle.close().catch(() => {});
  }
  await rename(tmp, file);
  log('info', { msg: 'stale rows removed from the log', source: sourceId, dropped, kept, note: 'the repaired extractor produces different rows' });
  return { dropped, kept };
}

// ------------------------------------------------------------------- lock

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export async function acquireLock(lockFile, { staleMs = 6 * 3600e3, log = () => {} } = {}) {
  await ensureDir(path.dirname(lockFile));
  const info = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), cwd: process.cwd() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockFile, 'wx');
      try { await fh.writeFile(JSON.stringify(info, null, 2)); await fh.sync(); } finally { await fh.close(); }
      return { release: async () => { try { await unlink(lockFile); } catch { /* already gone */ } } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = await readJson(lockFile, {});
      const age = Date.now() - new Date(held.startedAt || 0).getTime();
      const sameHost = held.host === os.hostname();
      const alive = sameHost ? pidAlive(Number(held.pid)) : true;
      if (attempt === 0 && (!alive || age > staleMs)) {
        log('warn', { msg: 'removing stale lock', lockFile, held, alive, ageMin: Math.round(age / 60000) });
        await unlink(lockFile).catch(() => {});
        continue;
      }
      const e = new Error(`dataset is locked by pid ${held.pid} on ${held.host} since ${held.startedAt} (${Math.round(age / 1000)}s ago)`);
      e.code = 'LOCKED';
      throw e;
    }
  }
  throw Object.assign(new Error('could not acquire lock'), { code: 'LOCKED' });
}

// ------------------------------------------------------------- state file

export function emptyState(name) {
  return { dataset: name, version: 1, ord: 0, sources: {}, runs: 0, lastRun: null, lastSummary: null };
}

export async function loadState(paths) {
  const st = await readJson(paths.state, null);
  if (!st) return emptyState(path.basename(paths.base));
  st.sources ||= {};
  st.ord ||= 0;
  return st;
}

export async function saveState(paths, state) {
  return writeJson(paths.state, state);
}

export async function listDatasets(root) {
  const dir = path.join(root, 'data');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
}

export async function fileSize(file) {
  try { return (await stat(file)).size; } catch { return 0; }
}
