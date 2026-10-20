// CSV as a pure projection of the raw log: declared column order, RFC4180
// quoting, atomic replace, and a manifest that locks the header so a schema
// change can never silently corrupt an existing file.

import { readFile, open, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { columnNames } from './config.mjs';
import { atomicWrite, readJson, writeJson, sha256 } from './store.mjs';
import { compareTime } from './timeorder.mjs';
import path from 'node:path';

function needsQuote(s, delim) {
  return s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r') || s !== s.trim();
}

export function formatField(value, delim = ',') {
  if (value === null || value === undefined) return '';
  let s;
  if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else s = String(value);
  if (s === '') return '';
  return needsQuote(s, delim) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(columns, rows, { delimiter = ',', newline = '\r\n', bom = false } = {}) {
  const out = [];
  if (bom) out.push('\ufeff');
  out.push(columns.map((c) => formatField(c, delimiter)).join(delimiter));
  for (const row of rows) out.push(columns.map((c) => formatField(row[c], delimiter)).join(delimiter));
  return out.join(newline) + newline;
}

// The streaming twin of buildCsv: same bytes, but the rows are written as they
// arrive instead of being collected into one giant string (V8 caps a string at
// 512 MB, so a big dataset cannot be built in memory at once).
export function csvRow(columns, row, { delimiter = ',', newline = '\r\n' } = {}) {
  return columns.map((c) => formatField(row[c], delimiter)).join(delimiter) + newline;
}

export function csvHeader(columns, { delimiter = ',', newline = '\r\n', bom = false } = {}) {
  return (bom ? '\ufeff' : '') + columns.map((c) => formatField(c, delimiter)).join(delimiter) + newline;
}

export function parseCsv(text, { delimiter = ',' } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  const header = clean.shift() || [];
  return { header, rows: clean };
}

export function headerHash(columns) {
  return sha256(columns.join('\u0000')).slice(0, 16);
}

// Deterministic ordering: explicit sortBy, else ingest order (_ord).
export function orderRows(rows, cfg) {
  const out = [...rows];
  const spec = cfg.sortBy;
  if (!spec) {
    out.sort((a, b) => (a._ord ?? 0) - (b._ord ?? 0));
    return out;
  }
  const parts = (Array.isArray(spec) ? spec : [spec]).map((s) => {
    const [name, dir] = String(s).split(':');
    return { name: name.trim(), dir: (dir || 'asc').toLowerCase() === 'desc' ? -1 : 1 };
  });
  // a recorded time interpretation makes the sort a real date sort, not a
  // string sort ("Oct 20, 2026" must not be compared alphabetically)
  const kindOf = (name) => cfg.timeKinds?.[name] || null;
  out.sort((a, b) => {
    for (const { name, dir } of parts) {
      const x = a[name];
      const y = b[name];
      const k = kindOf(name);
      let cmp;
      if (k) {
        cmp = compareTime(x, y, k);
      } else {
        const xn = typeof x === 'number';
        const yn = typeof y === 'number';
        if (xn && yn) cmp = x - y;
        else cmp = String(x ?? '').localeCompare(String(y ?? ''), 'en', { numeric: true });
      }
      if (cmp) return cmp * dir;
    }
    return (a._ord ?? 0) - (b._ord ?? 0); // stable tiebreak
  });
  return out;
}

export async function writeCsv(paths, cfg, rows, { log = () => {} } = {}) {
  const columns = columnNames(cfg);
  const ordered = orderRows(rows, cfg);
  const body = buildCsv(columns, ordered, cfg.csv);
  await atomicWrite(paths.csv, body);
  const manifest = {
    dataset: cfg.name,
    columns,
    headerHash: headerHash(columns),
    rows: ordered.length,
    bytes: Buffer.byteLength(body),
    csvSha256: sha256(body),
    sortedBy: cfg.sortBy || null,
    timeKinds: cfg.timeKinds || null,
    ordRange: ordered.length ? [ordered[0]._ord ?? null, ordered[ordered.length - 1]._ord ?? null] : null,
    builtAt: new Date().toISOString(),
    delimiter: cfg.csv.delimiter,
    newline: cfg.csv.newline === '\r\n' ? 'CRLF' : 'LF',
  };
  await writeJson(paths.manifest, manifest);
  log('info', { msg: 'csv written', file: path.relative(process.cwd(), paths.csv), rows: manifest.rows, bytes: manifest.bytes, headerHash: manifest.headerHash });
  return manifest;
}

// The streaming twin of writeCsv: same bytes on disk, but the rows are written
// as they arrive, so a dataset bigger than RAM (or bigger than V8's 512 MB
// string limit) can still be projected into a CSV.
export async function writeCsvStreaming(paths, cfg, rowsIterable, { log = () => {} } = {}) {
  const columns = columnNames(cfg);
  const tmp = `${paths.csv}.tmp-${process.pid}`;
  const hash = createHash('sha256');
  let bytes = 0;
  let count = 0;
  let firstOrd = null;
  let lastOrd = null;
  const handle = await open(tmp, 'w');
  try {
    const write = async (s) => { hash.update(s); bytes += Buffer.byteLength(s); await handle.write(s); };
    // batch the row writes: one await per row is 70µs of overhead each
    let buf = '';
    const flush = async () => { if (buf) { await write(buf); buf = ''; } };
    await write(csvHeader(columns, cfg.csv));
    for await (const row of rowsIterable) {
      buf += csvRow(columns, row, cfg.csv);
      count++;
      if (firstOrd === null) firstOrd = row._ord ?? null;
      lastOrd = row._ord ?? lastOrd;
      if (buf.length > 1 << 18) await flush();
    }
    await flush();
  } finally {
    await handle.close();
  }
  await rename(tmp, paths.csv);
  const manifest = {
    dataset: cfg.name,
    columns,
    headerHash: headerHash(columns),
    rows: count,
    bytes,
    csvSha256: hash.digest('hex'),
    sortedBy: cfg.sortBy || null,
    timeKinds: cfg.timeKinds || null,
    ordRange: count ? [firstOrd, lastOrd] : null,
    builtAt: new Date().toISOString(),
    delimiter: cfg.csv.delimiter,
    newline: cfg.csv.newline === '\r\n' ? 'CRLF' : 'LF',
  };
  await writeJson(paths.manifest, manifest);
  log('info', { msg: 'csv written (streamed)', file: path.relative(process.cwd(), paths.csv), rows: manifest.rows, bytes: manifest.bytes, headerHash: manifest.headerHash });
  return manifest;
}

export async function verifyCsv(paths) {
  const manifest = await readJson(paths.manifest, null);
  if (!manifest) return { ok: false, reason: 'no manifest (run `scrape01 rebuild` first)' };
  const text = await readFile(paths.csv, 'utf8').catch(() => null);
  if (text === null) return { ok: false, reason: 'csv missing' };
  const problems = [];
  if (sha256(text) !== manifest.csvSha256) problems.push('content hash differs from manifest');
  const parsed = parseCsv(text.replace(/^\ufeff/, ''), { delimiter: manifest.delimiter });
  if (JSON.stringify(parsed.header) !== JSON.stringify(manifest.columns)) problems.push('header differs from declared column order');
  if (parsed.rows.length !== manifest.rows) problems.push(`row count ${parsed.rows.length} != manifest ${manifest.rows}`);
  for (const [i, row] of parsed.rows.entries()) {
    if (row.length !== parsed.header.length) { problems.push(`row ${i + 2} has ${row.length} fields, header has ${parsed.header.length}`); break; }
  }
  return { ok: problems.length === 0, problems, manifest, header: parsed.header, rows: parsed.rows.length };
}
