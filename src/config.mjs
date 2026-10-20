// Dataset configuration: the only place column ORDER is declared.
// Rows are always emitted in `columns` order, so the CSV header is a pure
// function of this file and can be locked by hash.

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PROFILE_NAMES } from './profile.mjs';
import { TIME_KINDS } from './timeorder.mjs';

import { datePrecision } from './timeorder.mjs';

export const TYPES = new Set(['string', 'number', 'integer', 'bool', 'url', 'datetime', 'date', 'enum']);

const DEFAULTS = {
  name: null,
  description: '',
  columns: [],
  key: [],
  sortBy: null,
  sources: [],
  csv: { delimiter: ',', newline: '\r\n', bom: false },
  limits: { maxPages: 200, maxRows: 200000, maxDepth: 1 },
  schedule: { every: null },
};

export function normalizeColumn(col, i) {
  if (typeof col === 'string') return { name: col, type: 'string' };
  if (!col || typeof col !== 'object') throw new Error(`columns[${i}] must be a string or object`);
  const name = String(col.name || '').trim();
  if (!name) throw new Error(`columns[${i}].name is required`);
  if (!/^[A-Za-z_][A-Za-z0-9_ .-]*$/.test(name)) throw new Error(`column name "${name}" must start with a letter and contain no commas/quotes`);
  const type = (col.type || 'string').toLowerCase();
  if (!TYPES.has(type)) throw new Error(`column "${name}" has unknown type "${col.type}"`);
  const out = { name, type, required: !!col.required };
  if (type === 'enum') {
    if (!Array.isArray(col.values) || !col.values.length) throw new Error(`enum column "${name}" needs a non-empty "values" array`);
    out.values = col.values.map(String);
  }
  if (col.maxLength) out.maxLength = Number(col.maxLength);
  if (col.default !== undefined) out.default = col.default;
  return out;
}

export const PAGINATE_MODES = new Set(['next', 'pageNumbers', 'urlTemplate', 'offset', 'cursor']);

// Accept the vocabulary people (and models) actually write: kind/link/maxPages.
export function normalizePaginate(p, where = 'paginate') {
  if (p === null || p === undefined || p === false) return null;
  if (typeof p !== 'object') throw new Error(`${where} must be an object`);
  const rawMode = String(p.mode || p.kind || 'next').toLowerCase();
  const aliases = { link: 'next', nextlink: 'next', href: 'next', pages: 'pageNumbers', pagenumbers: 'pageNumbers', template: 'urlTemplate', urltemplate: 'urlTemplate' };
  const mode = aliases[rawMode] || rawMode;
  if (!PAGINATE_MODES.has(mode)) throw new Error(`${where}.mode "${p.mode || p.kind}" must be one of ${[...PAGINATE_MODES].join('|')}`);
  const out = { mode };
  if (p.selector) out.selector = String(p.selector);
  if (p.urlTemplate) out.urlTemplate = String(p.urlTemplate);
  if (p.attr) out.attr = String(p.attr);
  const max = p.max ?? p.maxPages ?? p.limit;
  if (max !== undefined) out.max = Number(max);
  if (p.start !== undefined) out.start = Number(p.start);
  if (p.step !== undefined) out.step = Number(p.step);
  if (mode === 'next' && !out.selector) out.selector = 'a[rel="next"], li.next a, a.next';
  if (['pageNumbers', 'urlTemplate', 'offset', 'cursor'].includes(mode) && !out.urlTemplate) {
    throw new Error(`${where}.urlTemplate is required for mode "${mode}" (use {page}, {offset}, or {cursor})`);
  }
  return out;
}

export function validateDataset(cfg, file = '<inline>') {
  if (!cfg || typeof cfg !== 'object') throw new Error(`${file}: dataset must be an object`);
  const name = String(cfg.name || path.basename(file, path.extname(file))).trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`${file}: name "${name}" must be lowercase [a-z0-9_-]`);

  if (!Array.isArray(cfg.columns) || !cfg.columns.length) throw new Error(`${file}: "columns" must be a non-empty array (column order comes from here)`);
  const columns = cfg.columns.map(normalizeColumn);
  const seen = new Set();
  for (const c of columns) {
    if (seen.has(c.name)) throw new Error(`${file}: duplicate column "${c.name}"`);
    seen.add(c.name);
  }

  const key = (cfg.key ?? cfg.unique ?? []).map(String);
  for (const k of key) if (!seen.has(k)) throw new Error(`${file}: key column "${k}" is not declared in columns`);

  const sortBy = cfg.sortBy ?? cfg.sort_by ?? null;
  if (sortBy) {
    const parts = Array.isArray(sortBy) ? sortBy : [sortBy];
    for (const p of parts) {
      const [col] = String(p).split(':');
      if (!seen.has(col)) throw new Error(`${file}: sortBy column "${col}" is not declared in columns`);
    }
  }

  if (!Array.isArray(cfg.sources) || !cfg.sources.length) throw new Error(`${file}: "sources" must be a non-empty array`);
  const sources = cfg.sources.map((s, i) => {
    const id = String(s.id || `s${i + 1}`).trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`${file}: sources[${i}].id "${id}" must be lowercase [a-z0-9_-]`);
    const url = String(s.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`${file}: sources[${i}].url must be absolute http(s)`);
    const extract = s.extract || { kind: 'table' };
    if (!extract || typeof extract !== 'object') throw new Error(`${file}: sources[${i}].extract must be an object`);
    const kind = String(extract.kind || 'table').toLowerCase();
    if (!['table', 'selector', 'jsonld', 'json', 'meta', 'regex'].includes(kind)) {
      throw new Error(`${file}: sources[${i}].extract.kind "${kind}" must be table|selector|jsonld|json|meta|regex`);
    }
    const map = s.map || {};
    // map is extracted-field -> declared column, so its VALUES must be declared
    for (const [from, to] of Object.entries(map)) {
      if (typeof to !== 'string') throw new Error(`${file}: sources[${i}].map["${from}"] must be a column name`);
      if (!seen.has(to)) throw new Error(`${file}: sources[${i}].map["${from}"] maps to unknown column "${to}"`);
    }
    const paginate = normalizePaginate(s.paginate, `${file}: sources[${i}].paginate`);
    return { id, url, extract: { ...extract, kind }, map, paginate, notes: s.notes || '', headers: s.headers || {}, delayMs: s.delayMs ?? null };
  });

  const ids = new Set();
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`${file}: duplicate source id "${s.id}"`);
    ids.add(s.id);
  }

  const respectRobots = cfg.respectRobots === true;

  // A dataset may pin its crawl profile ("polite" | "monster" | override object).
  let profile = cfg.profile ?? null;
  if (profile != null) {
    if (typeof profile === 'string') {
      const p = String(profile).toLowerCase();
      if (!PROFILE_NAMES.includes(p)) throw new Error(`${file}: unknown profile "${profile}" (have: ${PROFILE_NAMES.join('|')})`);
      profile = p;
    } else if (typeof profile === 'object') {
      const named = String(profile.mode || profile.profile || 'polite').toLowerCase();
      if (!PROFILE_NAMES.includes(named)) throw new Error(`${file}: unknown profile "${profile.mode || profile.profile}" (have: ${PROFILE_NAMES.join('|')})`);
    } else {
      throw new Error(`${file}: "profile" must be a profile name or an object`);
    }
  }

  // A dataset may declare "placeholder rows": a row whose listed columns are
  // all zero carries no data (Yahoo's weekly-close bar is the classic case).
  let dropAllZero = null;
  if (cfg.dropAllZero != null) {
    if (!Array.isArray(cfg.dropAllZero) || !cfg.dropAllZero.length) throw new Error(`${file}: "dropAllZero" must be a non-empty array of column names`);
    for (const c of cfg.dropAllZero) if (!seen.has(String(c))) throw new Error(`${file}: dropAllZero names unknown column "${c}"`);
    dropAllZero = cfg.dropAllZero.map(String);
  }

  // How each time-like column is interpreted, so a sort can never silently
  // change meaning between crawls.
  let timeKinds = null;
  if (cfg.timeKinds != null) {
    if (typeof cfg.timeKinds !== 'object' || Array.isArray(cfg.timeKinds)) throw new Error(`${file}: "timeKinds" must be an object of column -> kind`);
    for (const [col, kind] of Object.entries(cfg.timeKinds)) {
      if (!seen.has(String(col))) throw new Error(`${file}: timeKinds names unknown column "${col}"`);
      if (!TIME_KINDS.includes(String(kind))) throw new Error(`${file}: timeKinds["${col}"] must be one of ${TIME_KINDS.join('|')}`);
    }
    timeKinds = Object.fromEntries(Object.entries(cfg.timeKinds).map(([c, k]) => [String(c), String(k)]));
  }

  return {
    ...DEFAULTS,
    ...cfg,
    name,
    columns,
    key,
    sortBy,
    sources,
    profile,
    respectRobots,
    timeKinds,
    dropAllZero,
    csv: { ...DEFAULTS.csv, ...(cfg.csv || {}) },
    limits: { ...DEFAULTS.limits, ...(cfg.limits || {}) },
    schedule: { ...DEFAULTS.schedule, ...(cfg.schedule || {}) },
    file,
  };
}

// The calendar date AS THE SOURCE STATES IT. "July 1, 2025" is July 1 —
// not June 30 in some other timezone, and never with an invented time.
function pad2(n) { return String(n).padStart(2, '0'); }
function calendarDate(raw, t) {
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${pad2(iso[2])}-${pad2(iso[3])}`;
  const ym = s.match(/^(\d{4})-(\d{1,2})$/);
  if (ym) return `${ym[1]}-${pad2(ym[2])}`;
  const y = s.match(/^(\d{4})$/);
  if (y) return y[1];
  const d = new Date(t); // a zone-less string is parsed as local time
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function columnNames(cfg) {
  return cfg.columns.map((c) => c.name);
}

// The declared TYPE of every column — the extractor needs it to know which
// field is a date (so it can take the machine-readable value, not the display
// one) and the create flow needs it to type a column by its DATA.
export function columnTypes(cfg) {
  const out = {};
  for (const c of (cfg.columns || [])) {
    if (typeof c === 'string') out[c] = 'string';
    else if (c && c.name) out[c.name] = (c.type || 'string');
  }
  return out;
}

// --------------------------------------------------------------- coercion

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function squeeze(s) {
  return String(s).replace(CTRL, '').replace(/[\t\r\n]+/g, ' ').replace(/[ ]{2,}/g, ' ').trim();
}

export function toNumber(v) {
  if (typeof v === 'number') return v;
  let s = squeeze(v);
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()]/g, '').replace(/[^\d.,\-]/g, '');
  if (!/\d/.test(s)) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = /,\d{3}(\D|$)/.test(s) && !/,\d{1,2}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return neg && n > 0 ? -n : n;
}

const TRUE = new Set(['true', 'yes', 'y', '1', 'on', 'in stock', 'available', 'ja', 'si', 'paid', 'active', 'open']);
const FALSE = new Set(['false', 'no', 'n', '0', 'off', 'out of stock', 'unavailable', 'nein', 'nooit', 'unpaid', 'inactive', 'closed']);

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = squeeze(v).toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return null;
}

export function coerce(col, value, ctx = {}) {
  if (value === null || value === undefined || value === '') {
    if (col.default !== undefined) return { ok: true, value: col.default };
    if (col.required) return { ok: false, error: 'required' };
    return { ok: true, value: '' };
  }
  let s = typeof value === 'string' ? squeeze(value) : value;

  switch (col.type) {
    case 'number': {
      const n = toNumber(s);
      if (!Number.isFinite(n)) return { ok: false, error: `not a number: ${JSON.stringify(s).slice(0, 60)}` };
      return { ok: true, value: n, raw: n };
    }
    case 'integer': {
      const n = toNumber(s);
      if (!Number.isFinite(n)) return { ok: false, error: `not an integer: ${JSON.stringify(s).slice(0, 60)}` };
      return { ok: true, value: Math.round(n), raw: Math.round(n) };
    }
    case 'bool': {
      const b = toBool(s);
      if (b === null) return { ok: false, error: `not a boolean: ${JSON.stringify(s).slice(0, 60)}` };
      return { ok: true, value: b, raw: b };
    }
    case 'url': {
      const str = String(s).trim();
      try {
        const abs = new URL(str, ctx.baseUrl || undefined).toString();
        return { ok: true, value: abs, raw: abs };
      } catch {
        return { ok: false, error: `not a url: ${str.slice(0, 60)}` };
      }
    }
    case 'datetime':
    case 'date': {
      const raw = String(s).trim();
      // A slash date with no way to tell day from month is not a date this
      // tool may read: it would be a coin toss, and data is not a coin toss.
      const slash = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
      if (slash && Number(slash[1]) <= 12 && Number(slash[2]) <= 12) {
        return { ok: false, error: `ambiguous date (day or month?): ${raw.slice(0, 40)}` };
      }
      const t = Date.parse(raw);
      if (Number.isNaN(t)) return { ok: false, error: `not a date: ${raw.slice(0, 60)}` };
      const prec = datePrecision(raw);
      if (prec === 'second') {
        const iso = new Date(t).toISOString();
        return { ok: true, value: iso, raw: iso, precision: 'second' };
      }
      // No time of day in the source. A timestamp here would invent one (and,
      // in a non-UTC zone, shift the calendar day), so the calendar date the
      // source STATES is what is kept — at the precision the source gave.
      const day = calendarDate(raw, t);
      return { ok: true, value: day, raw: day, precision: prec || 'day' };
    }
    case 'enum': {
      const str = squeeze(s);
      if (!col.values.includes(str)) return { ok: false, error: `not in enum: ${str.slice(0, 40)}` };
      return { ok: true, value: str, raw: str };
    }
    case 'string':
    default: {
      let str = squeeze(s);
      if (col.maxLength && str.length > col.maxLength) str = str.slice(0, col.maxLength);
      return { ok: true, value: str, raw: str };
    }
  }
}

export function coerceRow(cfg, raw, ctx = {}) {
  const values = {};
  const errors = [];   // hard: a REQUIRED column could not be coerced -> reject the row
  const soft = [];    // soft: an optional column could not be coerced -> empty the cell, keep the row
  for (const col of cfg.columns) {
    const res = coerce(col, raw[col.name], ctx);
    if (!res.ok) {
      if (col.required) errors.push(`${col.name}: ${res.error}`);
      else soft.push(`${col.name}: ${res.error}`);
      values[col.name] = '';
    } else values[col.name] = res.value;
  }
  return { values, errors, soft };
}

// --------------------------------------------------------------- loading

export async function listDatasetFiles(dir) {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  return entries.filter((f) => /\.json$/i.test(f)).map((f) => path.join(dir, f)).sort();
}

export async function loadDatasetFile(file) {
  const txt = await readFile(file, 'utf8');
  let cfg;
  try { cfg = JSON.parse(txt); } catch (err) { throw new Error(`${file}: invalid JSON — ${err.message}`); }
  return validateDataset(cfg, file);
}

export async function loadDatasets(dir, only = null) {
  const files = await listDatasetFiles(dir);
  if (!files.length) throw new Error(`no dataset configs in ${dir}`);
  const out = [];
  for (const f of files) {
    const cfg = await loadDatasetFile(f);
    if (only && !only.includes(cfg.name)) continue;
    out.push(cfg);
  }
  if (only) {
    const missing = only.filter((n) => !out.some((d) => d.name === n));
    if (missing.length) throw new Error(`unknown dataset(s): ${missing.join(', ')}`);
  }
  return out;
}

// Change the row order of a dataset WITHOUT rewriting the rest of the config:
// the raw file keeps every field (headers, delayMs, unknown keys) except the
// order itself. The CSV is a projection of the raw log, so a rebuild is enough.
export async function setDatasetOrder(file, sortBy, kinds = null) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  if (sortBy === null || sortBy === undefined || sortBy === 'reset' || sortBy === '') {
    raw.sortBy = null;
    if (kinds) raw.timeKinds = kinds;
  } else {
    const spec = Array.isArray(sortBy) ? sortBy : [sortBy];
    const declared = new Set((raw.columns || []).map((c) => (typeof c === 'string' ? c : c.name)));
    for (const s of spec) {
      const [col] = String(s).split(':');
      if (!declared.has(col)) throw new Error(`unknown column "${col}" in ${file} (declared: ${[...declared].join(', ')})`);
    }
    raw.sortBy = spec.length === 1 ? spec[0] : spec;
    if (kinds) raw.timeKinds = kinds;
  }
  validateDataset(raw, file); // rejects a malformed spec before it touches disk
  await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return raw;
}

// The engine can find a next-page link the plan missed. When it does, the
// corrected pagination is written back to the config — so the NEXT run follows
// the same chain and the dataset does not change shape between runs.
export async function setDatasetPagination(file, sourceId, paginate) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const src = (raw.sources || []).find((s) => String(s.id || 'main') === String(sourceId));
  if (!src) throw new Error(`source "${sourceId}" not found in ${file}`);
  if (paginate === null || paginate === undefined) delete src.paginate;
  else src.paginate = paginate;
  validateDataset(raw, file);
  await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return raw;
}

export async function writeDatasetFile(dir, cfg) {
  await mkdir(dir, { recursive: true });
  const clean = {
    name: cfg.name,
    description: cfg.description,
    columns: cfg.columns,
    key: cfg.key,
    sortBy: cfg.sortBy,
    sources: cfg.sources.map((s) => ({
      id: s.id, url: s.url, extract: s.extract,
      ...(s.map && Object.keys(s.map).length ? { map: s.map } : {}),
      ...(s.paginate ? { paginate: s.paginate } : {}),
      ...(s.notes ? { notes: s.notes } : {}),
    })),
    csv: cfg.csv,
    limits: cfg.limits,
    ...(cfg.dropAllZero ? { dropAllZero: cfg.dropAllZero } : {}),
    ...(cfg.timeKinds ? { timeKinds: cfg.timeKinds } : {}),
    ...(cfg.profile ? { profile: cfg.profile } : {}),
    ...(cfg.respectRobots ? { respectRobots: true } : {}),
    ...(cfg.schedule?.every ? { schedule: cfg.schedule } : {}),
  };
  const file = path.join(dir, `${cfg.name}.json`);
  await writeFile(file, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return file;
}
