// Zero-dependency HTML parser + CSS-selector engine.
// Deliberately small but correct enough for real pages: entity decoding, void
// elements, rawtext elements, implicit closes, and a subset of CSS3 selectors.

const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const RAWTEXT = new Set(['script','style','textarea','title']);
const BLOCK = new Set(['address','article','aside','blockquote','div','dl','fieldset','figure','footer','form','h1','h2','h3','h4','h5','h6','header','hr','main','nav','ol','p','pre','section','table','ul']);

// tag -> set of currently-open tags it implicitly closes
const IMPLICIT = {
  li: new Set(['li']),
  dt: new Set(['dt','dd']),
  dd: new Set(['dt','dd']),
  tr: new Set(['tr','td','th']),
  td: new Set(['td','th']),
  th: new Set(['td','th']),
  option: new Set(['option']),
  thead: new Set(['tbody','tfoot','tr','td','th']),
  tbody: new Set(['thead','tfoot','tr','td','th']),
  tfoot: new Set(['thead','tbody','tr','td','th']),
  p: new Set(['p']),
};

const ENTITIES = {
  amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:'\u00a0', copy:'\u00a9', reg:'\u00ae',
  mdash:'\u2014', ndash:'\u2013', hellip:'\u2026', rsquo:'\u2019', lsquo:'\u2018',
  rdquo:'\u201d', ldquo:'\u201c', trade:'\u2122', euro:'\u20ac', pound:'\u00a3', deg:'\u00b0',
  middot:'\u00b7', laquo:'\u00ab', raquo:'\u00bb', times:'\u00d7', divide:'\u00f7', bull:'\u2022',
};

export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function element(tag) {
  return { type: 'element', tag, attrs: Object.create(null), children: [], parent: null };
}

function addText(cur, raw) {
  if (!raw) return;
  const node = { type: 'text', text: decodeEntities(raw), parent: cur };
  cur.children.push(node);
}

function scanAttrs(html, start) {
  // returns { attrs, end } where end is index just past '>'
  const attrs = Object.create(null);
  let i = start;
  const n = html.length;
  while (i < n) {
    while (i < n && /\s/.test(html[i])) i++;
    if (i >= n) break;
    if (html[i] === '>') return { attrs, end: i + 1, selfClose: false };
    if (html[i] === '/' && html[i + 1] === '>') return { attrs, end: i + 2, selfClose: true };
    let nameEnd = i;
    while (nameEnd < n && !/[\s=>/]/.test(html[nameEnd])) nameEnd++;
    const name = html.slice(i, nameEnd).toLowerCase();
    i = nameEnd;
    while (i < n && /\s/.test(html[i])) i++;
    if (html[i] === '=') {
      i++;
      while (i < n && /\s/.test(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const end = html.indexOf(q, i + 1);
        const val = html.slice(i + 1, end === -1 ? n : end);
        attrs[name] = decodeEntities(val);
        i = end === -1 ? n : end + 1;
      } else {
        let end = i;
        while (end < n && !/[\s>]/.test(html[end])) end++;
        attrs[name] = decodeEntities(html.slice(i, end));
        i = end;
      }
    } else {
      attrs[name] = '';
    }
    if (!name) { i++; } // guard against pathological input
  }
  return { attrs, end: n, selfClose: false };
}

export function parseHTML(html) {
  const root = { type: 'element', tag: '#root', attrs: Object.create(null), children: [], parent: null };
  let cur = root;
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { addText(cur, html.slice(i)); break; }
    if (lt > i) addText(cur, html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![', lt) || html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html[lt + 1] === '/') {
      const end = html.indexOf('>', lt);
      const name = html.slice(lt + 2, end === -1 ? n : end).trim().toLowerCase();
      i = end === -1 ? n : end + 1;
      let node = cur;
      while (node && node.tag !== name) node = node.parent;
      if (node && node.tag === name) cur = node.parent;
      continue;
    }
    // start tag
    let j = lt + 1;
    while (j < n && /[a-z0-9:_-]/i.test(html[j])) j++;
    const tag = html.slice(lt + 1, j).toLowerCase();
    if (!tag) { addText(cur, '<'); i = lt + 1; continue; }
    const { attrs, end, selfClose } = scanAttrs(html, j);
    i = end;

    // <p> is closed by any block-level start (browsers do the same)
    if (cur.tag === 'p' && BLOCK.has(tag) && cur.parent) cur = cur.parent;
    const closes = IMPLICIT[tag];
    if (closes) while (cur.parent && closes.has(cur.tag)) cur = cur.parent;

    const el = element(tag);
    el.attrs = attrs;
    el.parent = cur;
    cur.children.push(el);

    if (VOID.has(tag) || selfClose) continue;

    if (RAWTEXT.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = close.exec(rest);
      const body = m ? rest.slice(0, m.index) : rest;
      if (body) el.children.push({ type: 'text', text: tag === 'script' || tag === 'style' ? body : decodeEntities(body), parent: el });
      i = m ? i + m.index + m[0].length : n;
      continue;
    }
    cur = el;
  }
  return root;
}

// ---------------------------------------------------------------- traversal

export function* walk(node) {
  for (const child of node.children || []) {
    yield child;
    if (child.type === 'element') yield* walk(child);
  }
}

const WS = /[ \t\r\n\f\u00a0]+/g;

export function text(node, { collapse = true } = {}) {
  if (!node) return '';
  let out = '';
  const visit = (n) => {
    for (const c of n.children || []) {
      if (c.type === 'text') out += c.text;
      else if (c.tag !== 'script' && c.tag !== 'style') visit(c);
    }
  };
  visit(node);
  return collapse ? out.replace(WS, ' ').trim() : out;
}

export function attr(node, name) {
  if (!node || !node.attrs) return null;
  return node.attrs[name] ?? node.attrs[name.toLowerCase()] ?? null;
}

export function elems(node) {
  return (node.children || []).filter((c) => c.type === 'element');
}

// ------------------------------------------------------------ selectors

function parseCompound(src) {
  const comp = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '*') { i++; continue; }
    if (ch === '#') {
      let j = i + 1;
      while (j < n && /[\w-]/.test(src[j])) j++;
      comp.id = src.slice(i + 1, j); i = j; continue;
    }
    if (ch === '.') {
      let j = i + 1;
      while (j < n && /[\w-]/.test(src[j])) j++;
      comp.classes.push(src.slice(i + 1, j)); i = j; continue;
    }
    if (ch === '[') {
      const end = src.indexOf(']', i);
      const body = src.slice(i + 1, end === -1 ? n : end);
      const m = /^([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?/.exec(body);
      if (m) comp.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, val: m[3] ?? m[4] ?? (m[5] ? m[5].trim() : '') });
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === ':') {
      let j = i + 1;
      while (j < n && /[\w-]/.test(src[j])) j++;
      const name = src.slice(i + 1, j);
      let arg = null;
      if (src[j] === '(') {
        let depth = 0, k = j;
        for (; k < n; k++) {
          if (src[k] === '(') depth++;
          else if (src[k] === ')' && --depth === 0) break;
        }
        arg = src.slice(j + 1, k);
        j = k + 1;
      }
      comp.pseudos.push({ name: name.toLowerCase(), arg });
      i = j; continue;
    }
    if (/[\w-]/.test(ch)) {
      let j = i;
      while (j < n && /[\w-]/.test(src[j])) j++;
      comp.tag = src.slice(i, j).toLowerCase(); i = j; continue;
    }
    throw new Error(`unsupported selector near "${src.slice(i)}"`);
  }
  return comp;
}

export function parseSelector(sel) {
  const groups = [];
  for (const rawGroup of splitTop(sel, ',')) {
    const g = rawGroup.trim();
    if (!g) continue;
    const steps = [];
    let buf = '';
    let comb = null;
    const flush = (nextComb) => {
      if (buf.trim()) steps.push({ comb: comb || (steps.length ? ' ' : null), comp: parseCompound(buf.trim()) });
      buf = '';
      comb = nextComb;
    };
    // Combinators are only combinators outside brackets and quotes, so that
    // values like [type="application/ld+json"] survive intact.
    let depth = 0;
    let quote = null;
    for (let i = 0; i < g.length; i++) {
      const ch = g[i];
      if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
      if (ch === '(' || ch === '[') { depth++; buf += ch; continue; }
      if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); buf += ch; continue; }
      if (depth === 0) {
        if (ch === '>') { flush('>'); continue; }
        if (ch === '+' || ch === '~') { flush(' '); continue; }
        if (/\s/.test(ch)) { if (buf.trim()) flush(' '); continue; }
      }
      buf += ch;
    }
    flush(null);
    if (steps.length) groups.push(steps);
  }
  return groups;
}

function splitTop(s, sep) {
  const out = []; let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

function matchComp(el, comp) {
  if (el.type !== 'element') return false;
  if (comp.tag && el.tag !== comp.tag) return false;
  if (comp.id && (el.attrs.id || '') !== comp.id) return false;
  if (comp.classes.length) {
    const cls = (el.attrs.class || '').split(WS).filter(Boolean);
    for (const c of comp.classes) if (!cls.includes(c)) return false;
  }
  for (const a of comp.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (!a.op) continue;
    const needle = a.val;
    if (a.op === '=' && v !== needle) return false;
    if (a.op === '*=' && !v.includes(needle)) return false;
    if (a.op === '^=' && !v.startsWith(needle)) return false;
    if (a.op === '$=' && !v.endsWith(needle)) return false;
    if (a.op === '~=' && !v.split(WS).includes(needle)) return false;
    if (a.op === '|=' && !(v === needle || v.startsWith(needle + '-'))) return false;
  }
  for (const p of comp.pseudos) {
    if (p.name === 'first-child') {
      const sib = el.parent?.children.filter((c) => c.type === 'element') || [];
      if (sib[0] !== el) return false;
    } else if (p.name === 'last-child') {
      const sib = el.parent?.children.filter((c) => c.type === 'element') || [];
      if (sib[sib.length - 1] !== el) return false;
    } else if (p.name === 'nth-child') {
      const nm = /^\s*(\d+)\s*$/.exec(p.arg || '');
      if (nm) {
        const sib = el.parent?.children.filter((c) => c.type === 'element') || [];
        if (sib[Number(nm[1]) - 1] !== el) return false;
      }
    } else if (p.name === 'not') {
      if (matchComp(el, parseCompound((p.arg || '').trim()))) return false;
    } else if (p.name === 'contains') {
      const needle = (p.arg || '').replace(/^["']|["']$/g, '').toLowerCase();
      if (!text(el).toLowerCase().includes(needle)) return false;
    } else if (p.name === 'empty') {
      if (text(el, { collapse: false }).trim()) return false;
    } else {
      return false; // unknown pseudo -> no match, never silently true
    }
  }
  return true;
}

function matchSteps(el, steps, idx) {
  if (!matchComp(el, steps[idx].comp)) return false;
  if (idx === 0) return true;
  const comb = steps[idx].comb;
  if (comb === '>') {
    const p = el.parent;
    return !!p && p.type === 'element' && matchSteps(p, steps, idx - 1);
  }
  let p = el.parent;
  while (p && p.type === 'element') {
    if (matchSteps(p, steps, idx - 1)) return true;
    p = p.parent;
  }
  return false;
}

export function queryAll(root, selector) {
  const groups = parseSelector(selector);
  const out = [];
  const seen = new Set();
  for (const node of walk(root)) {
    for (const steps of groups) {
      if (matchSteps(node, steps, steps.length - 1)) {
        if (!seen.has(node)) { seen.add(node); out.push(node); }
        break;
      }
    }
  }
  return out;
}

export function query(root, selector) {
  const groups = parseSelector(selector);
  for (const node of walk(root)) {
    for (const steps of groups) if (matchSteps(node, steps, steps.length - 1)) return node;
  }
  return null;
}

export function closest(el, selector) {
  const groups = parseSelector(selector);
  let p = el;
  while (p && p.type === 'element') {
    for (const steps of groups) if (matchSteps(p, steps, steps.length - 1)) return p;
    p = p.parent;
  }
  return null;
}

// ------------------------------------------------------------ page helpers

export function parseDoc(html) {
  const root = parseHTML(html);
  return {
    root,
    html,
    title: text(query(root, 'title') || { children: [] }),
    query: (sel) => query(root, sel),
    queryAll: (sel) => queryAll(root, sel),
  };
}

export function jsonLd(root) {
  const out = [];
  for (const el of queryAll(root, 'script[type="application/ld+json"]')) {
    const raw = (el.children[0]?.text || '').trim();
    if (!raw) continue;
    try {
      const v = JSON.parse(raw);
      Array.isArray(v) ? out.push(...v) : out.push(v);
    } catch { /* ignore malformed blocks */ }
  }
  return out;
}

export function nextData(root) {
  const el = query(root, 'script#__NEXT_DATA__');
  if (!el) return null;
  try { return JSON.parse(el.children[0]?.text || ''); } catch { return null; }
}

export function metaTags(root) {
  const map = {};
  for (const el of queryAll(root, 'meta')) {
    const key = el.attrs.property || el.attrs.name;
    const val = el.attrs.content;
    if (key && val !== undefined) map[key.toLowerCase()] = val;
  }
  return map;
}

export function anchors(root) {
  return queryAll(root, 'a[href]').map((a) => ({ href: a.attrs.href, text: text(a) }));
}

// Flatten nested tables/rows: returns { headers, rows, cellRows } where rows
// are texts and cellRows are the cell ELEMENTS (so link columns can read href).
export function tableGrid(table) {
  if (!table) return { headers: null, rows: [], cellRows: [] };
  const rows = queryAll(table, 'tr');
  const grid = [];
  for (const tr of rows) {
    // skip rows of a nested table
    let p = tr.parent;
    let nested = false;
    while (p && p !== table) { if (p.tag === 'table') { nested = true; break; } p = p.parent; }
    if (nested) continue;
    const cells = [];
    const els = [];
    for (const cell of elems(tr)) {
      if (cell.tag !== 'td' && cell.tag !== 'th') continue;
      const span = Math.min(parseInt(cell.attrs.colspan || '1', 10) || 1, 12);
      cells.push({ text: text(cell), isHead: cell.tag === 'th' });
      els.push(cell);
      for (let k = 1; k < span; k++) { cells.push({ text: '', isHead: cell.tag === 'th' }); els.push(null); }
    }
    if (cells.length) grid.push({ cells, els });
  }
  const headIdx = grid.findIndex((r) => r.cells.some((c) => c.isHead));
  const headers = headIdx === -1 ? null : grid[headIdx].cells.map((c) => c.text);
  const body = grid.filter((_, i) => i !== headIdx);
  return {
    headers,
    rows: body.map((r) => r.cells.map((c) => c.text)),
    cellRows: body.map((r) => r.els),
  };
}
