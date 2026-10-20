// Extractors: HTML/JSON -> raw records keyed by COLUMN NAME (pre-coercion).
// Every strategy returns { records, columns } where `columns` is the set of
// column names it believes it produced (used for drift detection).

import { parseHTML, parseDoc, query, queryAll, text, attr, jsonLd, nextData, metaTags, tableGrid, elems } from './dom.mjs';
import { datePrecision } from './timeorder.mjs';

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

// Slice a balanced {...} / [...] literal out of a string, respecting strings.
function sliceBalanced(raw, start) {
  const open = raw[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

// Embedded payloads arrive in two shapes: pure JSON, or a JS assignment
// (`var ytInitialData = {...}` / `window.__DATA__ = {...}`). Both are common.
export function parseEmbeddedPayload(text, varName = null) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* not pure JSON */ }

  const patterns = varName
    ? [new RegExp(`[\\w$.]*\\b${varName.replace(ESCAPE_RE, '\\$&')}\\s*=\\s*`, 'g')]
    : [/(?:var|let|const)\s+[\w$]+\s*=\s*/g, /window\.[\w$]+\s*=\s*/g];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw))) {
      const obj = sliceBalanced(raw, m.index + m[0].length);
      if (!obj) continue;
      try { return JSON.parse(obj); } catch { /* try the next assignment */ }
    }
  }
  return null;
}

const clean = (s) => (s == null ? '' : String(s).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim());

function getPath(obj, dotted) {
  if (!dotted) return obj;
  let cur = obj;
  for (const key of String(dotted).split('.')) {
    if (cur == null) return undefined;
    if (key === '[]') { if (!Array.isArray(cur)) return undefined; continue; }
    // "result[0][1]" -> .result then [0] then [1]
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(key);
    if (m) {
      const [, name, idxs] = m;
      if (name) {
        if (cur[name] === undefined) return undefined;
        cur = cur[name];
      }
      for (const ix of idxs.matchAll(/\[(\d+)\]/g)) {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[Number(ix[1])];
        if (cur === undefined) return undefined;
      }
    } else {
      cur = cur[key];
    }
  }
  return cur;
}

function applyTransforms(value, spec) {
  let v = value;
  // epoch seconds -> ISO, so a JSON API's timestamps become real datetimes
  if (spec.as === 'iso' || spec.as === 'isoMs') {
    const n = Number(v);
    if (Number.isFinite(n)) v = new Date(spec.as === 'iso' ? n * 1000 : n).toISOString();
  }
  if (spec.stripTags && typeof v === 'string') v = clean(v.replace(/<[^>]*>/g, ' '));
  if (spec.regex) {
    try {
      const re = new RegExp(spec.regex, spec.flags || '');
      const m = re.exec(String(v ?? ''));
      v = m ? (m.length > 1 ? m[1] : m[0]) : '';
    } catch { v = ''; }
  }
  if (spec.replace && typeof v === 'string') {
    try { v = v.replace(new RegExp(spec.replace[0], spec.replace[1] || 'g'), spec.replace[2] ?? ''); } catch { /* ignore */ }
  }
  if (v !== undefined && v !== null && typeof v !== 'string' && spec.stringify !== false) v = String(v);
  return v;
}

// Resolve one field spec against one row node (element) or one object.
function resolveField(node, spec, ctx) {
  if (spec == null) return '';
  if (typeof spec === 'number') spec = String(spec);

  if (typeof spec === 'string') {
    // "css@attr"  |  "@attr"  |  "$.json.path"  |  "$#json.path"  |  "css"
    if (spec.startsWith('$#')) {
      // a parallel array: the path from the payload root, indexed by the row
      const arr = getPath(ctx.root ?? {}, spec.slice(2).replace(/^\./, ''));
      const v = Array.isArray(arr) ? arr[ctx.index] : arr;
      return applyTransforms(v, { stringify: true });
    }
    if (spec.startsWith('$')) return applyTransforms(getPath(ctx.json ?? node, spec.slice(1).replace(/^\./, '')), { stringify: true });
    const at = spec.lastIndexOf('@');
    if (at === 0) return attr(node, spec.slice(1));
    if (at > 0) {
      const sel = spec.slice(0, at);
      const name = spec.slice(at + 1);
      const target = query(node, sel);
      return target ? (attr(target, name) ?? '') : '';
    }
    const el = query(node, spec);
    if (!el) return '';
    return ctx.dateColumns?.has(ctx.col) ? richestDate(el, text(el)) : text(el);
  }

  if (typeof spec === 'object') {
    let base = node;
    if (spec.selector) {
      const found = spec.all ? queryAll(node, spec.selector) : query(node, spec.selector);
      if (Array.isArray(found)) {
        const vals = found.map((el) => (spec.attr ? attr(el, spec.attr) : text(el)));
        return applyTransforms(spec.join ? vals.join(spec.join) : vals, spec);
      }
      if (!found) return applyTransforms(spec.missing ?? '', spec);
      base = found;
    }
    if (spec.json) {
      if (spec.indexed) {
        // a parallel array: the path from the payload root, indexed by the row
        const arr = getPath(ctx.root ?? {}, spec.json);
        const v = Array.isArray(arr) ? arr[ctx.index] : arr;
        return applyTransforms(v, { stringify: true, ...spec });
      }
      return applyTransforms(getPath(ctx.json ?? {}, spec.json), spec);
    }
    if (spec.attr) return applyTransforms(attr(base, spec.attr) ?? '', spec);
    if (typeof node === 'object' && node.type !== 'element') return applyTransforms(getPath(node, spec.path), spec);
    if (spec.path) return applyTransforms(getPath(ctx.json ?? node, spec.path), spec);
    if (spec.self) return applyTransforms(base === node && node.type !== 'element' ? node : text(base), spec);
    return applyTransforms(node.type === 'element' ? text(base) : base, spec);
  }
  return String(spec);
}

// A date column should get the RICHEST value the page offers. The visible
// text is often a display form ("July 1, 2025") while the element carries
// the machine-readable value ("2025-07-01T00:00:00-04:00") — the time of day
// is in the attribute, not in the text. Take the attribute whenever it is at
// least as precise as the text: that is more information, never less.
const DATE_ATTRS = ['datetime', 'content', 'data-date', 'data-datetime', 'data-time', 'data-published', 'data-created', 'value'];
const PREC_RANK = { second: 3, day: 2, month: 1, year: 0 };

function richestDate(el, textValue) {
  const textPrec = datePrecision(textValue);
  let node = el;
  for (let up = 0; up < 3 && node && node.type === 'element'; up++, node = node.parent) {
    for (const name of DATE_ATTRS) {
      const v = attr(node, name);
      if (!v) continue;
      const p = datePrecision(v);
      if (!p) continue;
      if (!textPrec) return v;
      if (PREC_RANK[p] > PREC_RANK[textPrec]) return v;
    }
  }
  return textValue;
}

function buildRecord(spec, node, ctx) {
  const rec = {};
  for (const [col, fieldSpec] of Object.entries(spec)) rec[col] = resolveField(node, fieldSpec, { ...ctx, col });
  return rec;
}

// ------------------------------------------------------------------ table

function extractTable(doc, ex, source, ctx = {}) {
  const tables = ex.table ? doc.queryAll(ex.table) : doc.queryAll('table');
  const records = [];
  const producedCols = new Set();
  if (!tables.length) return { records, columns: producedCols, note: 'no matching table' };

  const wanted = ex.columns || null; // explicit column order for headerless tables
  const cellFields = ex.cellFields || {}; // column -> spec resolved against the cell element (e.g. "a@href")
  for (const table of tables.slice(0, ex.maxTables || 10)) {
    const { headers, rows, cellRows } = tableGrid(table);
    let names = null;
    if (ex.headerRow === false || (wanted && !headers)) names = wanted;
    else if (headers && headers.length) {
      names = headers.map((h) => {
        const key = clean(h).toLowerCase();
        if (ex.headerMap && ex.headerMap[key]) return ex.headerMap[key];
        return key.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      });
      if (!ex.headerMap) {
        // Header text is free-form; the mapping layer owns name mapping.
        names = names.filter((n) => !ex.dropUnmapped);
      }
    } else if (wanted) names = wanted;
    if (!names || !names.length) continue;

    for (const [ri, cells] of rows.entries()) {
      const rec = {};
      names.forEach((name, i) => {
        if (!name) return;
        const spec = cellFields[name];
        const cellEl = cellRows[ri]?.[i];
        rec[name] = spec && cellEl ? resolveField(cellEl, spec, { ...ctx, col: name }) : cells[i] ?? '';
      });
      if (Object.values(rec).some((v) => clean(v))) { records.push(rec); Object.keys(rec).forEach((k) => producedCols.add(k)); }
    }
  }
  return { records, columns: producedCols };
}

// --------------------------------------------------------------- selector

function extractSelector(doc, ex, ctx = {}) {
  const records = [];
  const producedCols = new Set();
  const rowSel = ex.row || 'body';
  const rows = doc.queryAll(rowSel);
  for (const node of rows) {
    const rec = buildRecord(ex.fields || {}, node, ctx);
    if (Object.values(rec).some((v) => clean(v))) {
      records.push(rec);
      Object.keys(rec).forEach((k) => producedCols.add(k));
    }
  }
  return { records, columns: producedCols };
}

// ----------------------------------------------------------------- JSON-LD

function extractJsonLd(doc, ex) {
  const blocks = jsonLd(doc.root);
  let items = blocks;
  if (ex.types) {
    const types = new Set((Array.isArray(ex.types) ? ex.types : [ex.types]).map((t) => String(t).toLowerCase()));
    items = items.filter((b) => {
      const t = b['@type'];
      const list = Array.isArray(t) ? t : [t];
      return list.some((x) => types.has(String(x || '').toLowerCase()));
    });
  }
  if (ex.listPath) items = items.flatMap((b) => { const v = getPath(b, ex.listPath); return Array.isArray(v) ? v : v ? [v] : []; });
  if (!Array.isArray(items)) items = [items];
  const records = items.filter((v) => v && typeof v === 'object').map((item) => buildRecord(ex.fields || {}, item, { json: item }));
  return { records, columns: new Set(Object.keys(ex.fields || {})) };
}

// ------------------------------------------------------- embedded JSON

// Locate the first array of objects inside a payload: JS apps bury their lists
// under a key ("rows", "items", "contents"), and the extractor should not have
// to guess the path.
function findArrayOfObjects(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = findArrayOfObjects(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractJson(doc, ex) {
  let payload = null;
  let payloadSource = null;
  if (ex.scriptSelector) {
    const el = doc.query(ex.scriptSelector);
    if (el) {
      payload = parseEmbeddedPayload(el.children[0]?.text || '', ex.varName);
      if (payload !== null) payloadSource = ex.scriptSelector;
    }
  }
  if (payload === null) {
    payload = nextData(doc.root);
    if (payload !== null) payloadSource = '__NEXT_DATA__';
  }
  if (payload === null) {
    // any embedded JSON, including `var NAME = {...}` assignments
    for (const el of doc.queryAll('script')) {
      const raw = (el.children[0]?.text || '').trim();
      if (!raw) continue;
      const parsed = parseEmbeddedPayload(raw, ex.varName);
      if (parsed !== null) { payload = parsed; payloadSource = 'script'; break; }
    }
  }
  if (payload === null) {
    // a raw JSON endpoint: the body IS the payload
    const whole = (text(doc.root) || '').trim();
    if (whole.startsWith('{') || whole.startsWith('[')) {
      try { payload = JSON.parse(whole); payloadSource = 'body'; }
      catch { /* not JSON after all */ }
    }
  }
  if (payload === null) return { records: [], columns: new Set(), note: 'no embedded JSON found' };

  let items = ex.path ? getPath(payload, ex.path) : payload;
  if (ex.autoArray && !Array.isArray(items) && items && typeof items === 'object') {
    const arr = findArrayOfObjects(items);
    if (arr) items = arr;
  }
  if (!Array.isArray(items)) items = items == null ? [] : [items];
  let fields = ex.fields || {};
  if (!Object.keys(fields).length && ex.autoArray && items.length && items[0] && typeof items[0] === 'object') {
    // no declared field specs: harvest the payload's own keys
    fields = {};
    for (const k of Object.keys(items[0]).slice(0, 30)) fields[k] = '$.' + k;
  }
  const records = items.filter((v) => v && (typeof v === 'object' || typeof v === 'number'))
    .map((item, i) => buildRecord(fields, item, { json: item, index: i, root: payload }));
  return { records, columns: new Set(Object.keys(fields)), note: payloadSource ? `embedded JSON from ${payloadSource}` : null };
}

// ---------------------------------------------------------------- meta

function extractMeta(doc, ex) {
  const meta = metaTags(doc.root);
  const canonical = doc.query('link[rel="canonical"]');
  const flat = {
    ...meta,
    title: doc.title,
    canonical: canonical ? attr(canonical, 'href') : '',
    ...(ex.fields || {}),
  };
  const rec = {};
  for (const [col, spec] of Object.entries(ex.fields || {})) rec[col] = resolveField(doc.root, spec, { json: flat });
  if (!Object.keys(rec).length) {
    for (const [k, v] of Object.entries(meta)) rec[k.replace(/[^a-z0-9]+/g, '_')] = v;
    rec.title = doc.title;
    rec.canonical = flat.canonical;
  }
  return { records: [rec], columns: new Set(Object.keys(rec)) };
}

// ---------------------------------------------------------------- regex

function extractRegex(doc, ex, source) {
  if (!ex.pattern) throw new Error('regex extractor needs a "pattern"');
  const re = new RegExp(ex.pattern, ex.flags || 'gs');
  const records = [];
  let m;
  let guard = 0;
  while ((m = re.exec(doc.html)) && guard++ < (ex.max || 5000)) {
    const rec = {};
    for (const [col, group] of Object.entries(ex.groups || {})) rec[col] = m[Number(group)] ?? '';
    records.push(rec);
    if (!re.global) break;
  }
  return { records, columns: new Set(Object.keys(ex.groups || {})) };
}

// ------------------------------------------------------------------ entry

export function extractPage({ html, source, columns, types = null }) {
  const doc = parseDoc(html || '');
  const ex = source.extract || { kind: 'table' };
  // which columns hold a date: they may carry a richer value than their text
  const dateColumns = new Set((columns || []).filter((c) => types && (types[c] === 'date' || types[c] === 'datetime')));
  const ctx = { dateColumns };
  let result;
  switch (ex.kind) {
    case 'table': result = extractTable(doc, ex, source, ctx); break;
    case 'selector': result = extractSelector(doc, ex, ctx); break;
    case 'jsonld': result = extractJsonLd(doc, ex, source); break;
    case 'json': result = extractJson(doc, ex, source); break;
    case 'meta': result = extractMeta(doc, ex, source); break;
    case 'regex': result = extractRegex(doc, ex, source); break;
    default: throw new Error(`unknown extractor kind "${ex.kind}"`);
  }

  // source-level rename map: extracted key -> declared column name
  const map = source.map || {};
  const declared = new Set(columns);
  const records = result.records.map((rec) => {
    if (!Object.keys(map).length) return rec;
    const out = {};
    for (const [k, v] of Object.entries(rec)) out[map[k] || k] = v;
    return out;
  });

  const hit = new Set();
  for (const rec of records) for (const k of Object.keys(rec)) if (declared.has(k)) hit.add(k);
  return { records, columns: result.columns, mappedColumns: hit, note: result.note || null, doc };
}

// Does this HTML contain records at all? Used to decide whether the browser
// is needed at all — raw HTML first, render only if the page is barren.
export function looksLikeData(html) {
  const probes = [
    { kind: 'table' },
    { kind: 'selector', row: 'tr', fields: { v: 'td' } },
    { kind: 'json' },
  ];
  for (const extract of probes) {
    try {
      const res = extractPage({ html, source: { extract }, columns: [] });
      if (res.records.length) return true;
    } catch { /* keep probing */ }
  }
  return false;
}

// "Reap anything": if the declared extractor matches nothing, try the other
// strategies on the same HTML before declaring the page barren. The winner is
// reported so the caller can log (and eventually rewrite) the extractor.
export function extractPageAuto({ html, source, columns }) {
  const declared = source.extract || { kind: 'table' };
  const first = extractPage({ html, source, columns });
  const attempts = [{ kind: declared.kind, rows: first.records.length }];
  if (first.records.length) return { ...first, strategy: declared.kind, attempts };

  // "meta" is NOT a fallback: it reads the PAGE's metadata (og:title and
  // friends), which is one fabricated record, not a listing row. Recovering
  // with it is how a 25-row dataset became 26.
  for (const kind of ['json', 'jsonld', 'table']) {
    if (kind === declared.kind) continue;
    const spec = kind === 'json' ? { kind: 'json', autoArray: true } : { kind };
    const alt = extractPage({ html, source: { ...source, extract: spec }, columns });
    attempts.push({ kind, rows: alt.records.length });
    if (alt.records.length) {
      return { ...alt, strategy: kind, declaredKind: declared.kind, attempts, note: `recovered with ${kind} (declared ${declared.kind} matched nothing)` };
    }
  }
  return { ...first, strategy: declared.kind, attempts };
}

// Follow pagination -> next page url
// ------------------------------------------------------------ pagination

// Pagination is a property of the PAGE, not of the plan. The plan can be
// wrong (or simply forget the next link); the page never lies about having
// another page. So detect it in code, deterministically, and let the plan be
// checked against it.
const NEXT_TEXT = /^[\[\(\s]*(next|older|more|forward|›|»|→|⟩|>>)[\s›»→>⟩\]\)]*$/i;
const PAGE_PARAM = /[?&](page|pg|p|pageindex|start|offset)=(\d+)/i;

export function detectPagination(doc, currentUrl = null) {
  const anchors = doc.queryAll('a[href]');
  const cands = [];
  for (const a of anchors) {
    const hrefRaw = attr(a, 'href') || '';
    if (!hrefRaw || hrefRaw.startsWith('#') || /^javascript:/i.test(hrefRaw)) continue;
    const t = text(a).replace(/\s+/g, ' ').trim();
    const rel = (attr(a, 'rel') || '').toLowerCase();
    let why = null;
    let selector = null;
    if (rel.split(/\s+/).includes('next')) { why = 'rel=next'; selector = 'a[rel~="next"]'; }
    else if (NEXT_TEXT.test(t)) { why = 'text'; selector = `a:contains("${t.replace(/"/g, '')}")`; }
    else {
      const m = hrefRaw.match(PAGE_PARAM);
      if (m) {
        const n = Number(m[2]);
        if (n === 2 || n === 1) { why = 'href'; selector = null; }
      }
    }
    if (!why) continue;
    let href = hrefRaw;
    try { href = new URL(hrefRaw, currentUrl || 'https://example.invalid/').toString(); } catch { /* keep raw */ }
    cands.push({ text: t, href, why, selector, raw: hrefRaw });
  }
  // prefer the explicit signal (rel=next) over a guess from the text
  cands.sort((a, b) => (a.why === 'rel=next' ? 0 : 1) - (b.why === 'rel=next' ? 0 : 1));
  const best = cands[0] || null;
  return { hasNext: !!best, next: best, candidates: cands.slice(0, 8) };
}

// A pagination spec the engine can use without asking a model: follow the
// next link the page offers.
export function paginationSpecFor(doc, currentUrl) {
  const det = detectPagination(doc, currentUrl);
  if (!det.hasNext) return null;
  const spec = { mode: 'next' };
  if (det.next.selector) spec.selector = det.next.selector;
  else spec.selector = 'a[rel~="next"]';
  return { spec, detected: det };
}

export function nextPageUrl(doc, source, currentUrl, step = 0) {
  const p = source.paginate;
  if (!p) return null;
  const mode = p.mode || 'next';
  let href = null;
  if (mode === 'next') {
    const el = doc.query(p.selector || 'a[rel="next"], link[rel="next"], a.next, .pagination a.next');
    href = el ? attr(el, 'href') : null;
  } else if (mode === 'pageNumbers' || mode === 'urlTemplate') {
    const next = Number(p.start ?? 2) + step;
    if (p.urlTemplate && next <= Number(p.max ?? 10)) href = p.urlTemplate.replace('{page}', String(next));
  } else if (mode === 'offset') {
    const stride = Number(p.step ?? 1);
    const next = (Number(p.start ?? 0) || 0) + step * stride;
    if (p.urlTemplate && next <= Number(p.max ?? 100)) href = p.urlTemplate.replace('{offset}', String(next));
  } else if (mode === 'cursor') {
    // cursor discovered from page HTML, e.g. data-cursor on "load more"
    const el = doc.query(p.selector || '[data-cursor]');
    const cursor = el ? (attr(el, p.attr || 'data-cursor') || '') : '';
    if (cursor && p.urlTemplate) href = p.urlTemplate.replace('{cursor}', encodeURIComponent(cursor));
  }
  if (!href) return null;
  try { return new URL(href, currentUrl).toString(); } catch { return null; }
}

export { getPath, clean as cleanText };
