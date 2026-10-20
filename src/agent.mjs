// The "pi" half: a headless pi agent generates the extractor when a site is
// unknown, and repairs it when a page stops matching. Agent output is never
// trusted — every proposal is run through the real extractor and inspected
// before it can touch a dataset config.

import { spawn } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDoc, text as nodeText, walk } from './dom.mjs';
import { parseEmbeddedPayload } from './extract.mjs';
import { extractPage, cleanText, detectPagination, nextPageUrl } from './extract.mjs';
import { validateDataset, writeDatasetFile } from './config.mjs';
import { detectTimeKind } from './timeorder.mjs';

export const SYSTEM_RULES = `You are a scraper architect inside Scrape_01.
Rules:
- Reply with ONE fenced json block and nothing else. No prose before or after.
- CSS selectors only: tag, #id, .class, [attr], [attr=value], descendant, child (>), :first-child, :nth-child(n), :not(...), :contains("...").
- Never invent data. If a value is absent from the page, use "".
- Column names must be snake_case.

Field specs (use the richest one that fits):
  "css"                                  -> text of match
  "css@attr"                             -> attribute of match, e.g. "h3 a@href"
  {"selector":"css","attr":"class"}      -> attribute of match
  {"selector":"css","all":true,"join":" | "} -> join every match (use for tag lists)
  {"selector":"css","attr":"class","regex":"prefix (\\w+)"} -> regex the value, group 1
  {"json":"<path in the payload>","indexed":true} -> a PARALLEL array: the value at that path, indexed by the row
  {"json":"<path>","indexed":true,"as":"iso"} -> the same, but epoch seconds become an ISO datetime
  "$#<path in the payload>"              -> shorthand for the indexed form

Parallel arrays: when a JSON API returns timestamps in one array and the prices in
others (["timestamp":[...], "quote":[{"close":[...]}]}), use "path" for the row key and
"indexed" fields for the rest, so row i takes element i of every array.

Pagination shapes:
  {"mode":"next","selector":"li.next a"}
  {"mode":"pageNumbers","urlTemplate":"https://site/list?page={page}","max":20}
  {"mode":"offset","urlTemplate":"https://api/x?offset={offset}&limit=50","step":50,"max":1000}`;

export const MONSTER_RULES = `Monster mode: the target is JS-rendered or hostile to plain HTTP.
- The HTML you receive may be an app shell with no rows in it. Say so in your plan instead of inventing selectors.
- Embedded data often lives in a JS assignment: "var ytInitialData = {...}". Extract it with {"kind":"json","scriptSelector":"script","varName":"ytInitialData","path":"<dotted.path>","fields":{...}}.
- The JSON OUTLINE below shows the real path. A "path" MUST end at an ARRAY of records, never at a single record.
- When that array holds mixed items, the per-item key belongs in the FIELD path, not in "path": e.g. path "...itemSectionRenderer.contents" with field "$.channelRenderer.title.simpleText".
- Field paths start with "$." and read the value at that key of each record. Use "" when a value is genuinely absent.
- Field values are the RECORD's own fields. Read the sample values in the outline: a key named like "subscribers" may hold a handle, and the count may live under a different key.
- You MAY return a different source url than the seed url (a search or listing page, for example). It is fetched and verified; keep the same host unless the goal needs another site.
- Selectors are applied to the RENDERED DOM, so tag.class names that exist in the page brief will match.
- GRAB EVERYTHING THE PAGE OFFERS. A column for every distinct piece of information on the record: identifiers, links, dates, categories, quantities, authors, tags, images, excerpts, counts. Do not drop a field because the goal did not name it.
- For a date, prefer the MACHINE-READABLE value over the display text: map it to the attribute that holds it ("<css>@datetime", "<css>@content", "<css>@data-date") when the page offers one. The visible text is often "July 1, 2025" while the attribute carries "2025-07-01T00:00:00-04:00" — the attribute has the time, the text does not.
- Type a date column "date" when the page only offers a calendar date, and "datetime" only when a time of day is really there. Never let a display date be printed as a timestamp: a fabricated time of day is a lie in a data column.`;

function resolvePiBin() {
  return process.env.PI_BIN || (process.platform === 'win32' ? 'pi.cmd' : 'pi');
}

export function runPi(args, { stdin = '', timeoutMs = 180000, cwd = process.cwd(), model = null } = {}) {
  const safe = args.map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  if (model) safe.push('--model', model);
  const cmd = `${resolvePiBin()} ${safe.join(' ')}`;
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    // shell:true on Windows means cmd.exe; windowsHide keeps that console
    // window off the screen (a detached server has no console to inherit).
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, code: null, stdout: out, stderr: err + '\n[timeout]', timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: out, stderr: String(e.message || e) });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: out, stderr: err });
    });
    if (stdin) child.stdin.end(stdin); else child.stdin.end();
  });
}

// Everything the agent needs goes over stdin. argv stays ASCII and quote-free,
// because Windows shell quoting mangles multi-line prompts containing quotes.
export const STDIN_PROMPT = 'Follow the instructions in the text provided on standard input and reply exactly as they require.';

export async function askPi({ instruction, payload = '', model = null, timeoutMs = 240000, auditDir = null, log = () => {} }) {
  const request = `${instruction}\n\n<<<INPUT\n${payload}\nINPUT>>>\n`;
  if (auditDir) {
    try {
      await mkdir(auditDir, { recursive: true });
      await writeFile(path.join(auditDir, 'last-request.txt'), request, 'utf8');
    } catch { /* audit is best effort */ }
  }
  const res = await runPi(['--print', STDIN_PROMPT, '--no-session', '--no-tools'], { stdin: request, model, timeoutMs });
  if (auditDir) {
    try {
      await writeFile(path.join(auditDir, 'last-response.txt'), `ok=${res.ok} code=${res.code}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`, 'utf8');
    } catch { /* ignore */ }
  }
  if (!res.ok) log('warn', { msg: 'pi call failed', code: res.code, stderr: res.stderr.slice(0, 300) });
  return res;
}

export function extractJson(text) {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const chunk of [...fenced, text]) {
    const start = chunk.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < chunk.length; i++) {
      const c = chunk[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(chunk.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

// The anatomy of a repeating card: the structure a row actually has, with the
// ids, classes and text inside it. This is what tells a model which id holds
// "16 subscribers" and which holds a handle.

// Attributes that carry a MACHINE-READABLE value. A date's time of day lives
// in one of these, not in the visible text — so the model must see them.
const DATA_ATTRS = ['datetime', 'content', 'value', 'itemprop', 'data-date', 'data-datetime', 'data-time', 'data-published', 'data-created', 'title'];

export function recordAnatomy(doc, { maxRows = 2, maxDepth = 5, maxLines = 60, goal = '' } = {}) {
  const STOP = new Set(['that', 'this', 'with', 'from', 'into', 'channel', 'count', 'data', 'name', 'page', 'list', 'each', 'they', 'them', 'have', 'what', 'when', 'want', 'give', 'find', 'show', 'also', 'more', 'than', 'then', 'your', 'about']);
  const tokens = String(goal || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t));
  const tagCounts = new Map();
  const idParents = new Map();
  for (const el of walk(doc.root)) {
    if (el.type !== 'element') continue;
    const tag = el.tag || '';
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    const id = el.attrs?.id;
    if (!id) continue;
    let p = el.parent;
    let hops = 0;
    while (p && p.type === 'element' && hops < 16) {
      idParents.set(p, (idParents.get(p) || 0) + 1);
      p = p.parent;
      hops++;
    }
  }

  const COMMON = new Set(['div', 'span', 'a', 'p', 'li', 'td', 'tr', 'section', 'article', 'body', 'html', 'head', 'main', 'header', 'footer', 'nav', 'ul', 'ol', 'h1', 'h2', 'h3']);
  const CHROME = new Set(['svg', 'defs', 'g', 'path', 'rect', 'use', 'symbol', 'circle', 'line', 'polygon', 'polyline', 'filter', 'mask', 'text']);
  // subtree size separates a record card (small) from a page wrapper (huge)
  const size = new Map();
  const all = [...walk(doc.root)];
  for (const el of all.reverse()) {
    if (el.type !== 'element') continue;
    let s = 0;
    for (const c of el.children || []) if (c.type === 'element') s += 1 + (size.get(c) || 0);
    size.set(el, s);
  }
  const cands = [...idParents.entries()]
    .filter(([el, n]) => n >= 2 && !CHROME.has(el.tag) && (tagCounts.get(el.tag) || 0) >= 2 && (size.get(el) || 0) <= 220)
    .map(([el, n]) => ({ el, n, tag: el.tag, reps: tagCounts.get(el.tag) || 0, size: size.get(el) || 0, score: n * Math.min(tagCounts.get(el.tag) || 0, 25) * (COMMON.has(el.tag) ? 1 : 4) - (size.get(el) || 0) / 10 }))
    .sort((a, b) => b.score - a.score);

  // No ids anywhere? Many sites (Webflow, Shopify) identify their cards by
  // CLASS alone. Without this the model is left guessing which class holds
  // the date, and it guesses differently on every run.
  if (!cands.length) {
    // how often each tag.class appears
    const classCount = new Map();
    for (const el of walk(doc.root)) {
      if (el.type !== 'element') continue;
      const cls = String(el.attrs?.class || '').split(/\s+/).filter((c) => c && !/^style-scope$/.test(c))[0];
      if (!cls) continue;
      const key = `${el.tag}.${cls}`;
      classCount.set(key, (classCount.get(key) || 0) + 1);
    }
    const byClass = new Map();
    for (const el of walk(doc.root)) {
      if (el.type !== 'element') continue;
      const cls = String(el.attrs?.class || '').split(/\s+/).filter((c) => c && !/^style-scope$/.test(c))[0];
      if (!cls) continue;
      const key = `${el.tag}.${cls}`;
      if (!byClass.has(key)) byClass.set(key, { el, n: 0, key, cls });
      byClass.get(key).n += 1;
    }
    for (const { el, n, key, cls } of byClass.values()) {
      if (n < 2) continue;
      const sz = size.get(el) || 0;
      if (sz > 400) continue;
      // the RECORD card is the element that CONTAINS the other repeated
      // pieces (title, date, category, excerpt). A link in a sidebar holds
      // one class and repeats sixty times — that is chrome, not a record.
      const inside = new Set();
      for (const d of walk(el)) {
        if (d.type !== 'element') continue;
        const dc = String(d.attrs?.class || '').split(/\s+/).filter((c) => c && !/^style-scope$/.test(c))[0];
        if (!dc) continue;
        const dk = `${d.tag}.${dc}`;
        if ((classCount.get(dk) || 0) >= 2) inside.add(dk);
      }
      cands.push({ el, n, tag: el.tag, cls, reps: n, size: sz, richness: inside.size, score: n * 10 + inside.size * 60 - sz / 10 });
    }
    cands.sort((a, b) => b.score - a.score);
  }

  // a card whose text mentions the goal beats chrome that happens to be big
  const shortlist = cands.slice(0, 10);
  for (const c of shortlist) {
    const el = c.el;
    const text = cleanText(nodeText(el)).toLowerCase();
    c.goalHits = tokens.filter((t) => text.includes(t)).length;
    c.score += c.goalHits * 4000;
  }
  shortlist.sort((a, b) => b.score - a.score);

  const out = [];
  for (const c of shortlist.slice(0, 3)) {
    const instances = [];
    for (const el of walk(doc.root)) {
      if (el.type === 'element' && el.tag === c.tag && (!c.cls || String(el.attrs?.class || '').split(/\s+/).includes(c.cls))) {
        instances.push(el);
        if (instances.length >= maxRows) break;
      }
    }
    if (!instances.length) continue;
    out.push(`\nRECORD ANATOMY — <${c.tag}> (${c.reps} on this page${c.goalHits ? `, mentions the goal: ${c.goalHits} keyword(s)` : ''}, first instance):`);
    const lines = [];
    const print = (el, depth) => {
      if (lines.length >= maxLines) return;
      const id = el.attrs?.id;
      const cls = String(el.attrs?.class || '').split(/\s+/).filter((c) => c && !c.startsWith('style-scope')).slice(0, 2).join('.');
      const href = el.attrs?.href;
      const kids = (el.children || []).filter((c) => c.type === 'element');
      const own = cleanText((el.children || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ')).slice(0, 40);
      const label = el.tag + (id ? '#' + id : '') + (cls ? '.' + cls : '');
      let line = '  '.repeat(depth) + label;
      if (href) line += ` @href=${String(href).slice(0, 60)}`;
      // machine-readable values: the time of day lives here, not in the text
      for (const an of DATA_ATTRS) {
        const av = el.attrs?.[an];
        if (av) line += ` @${an}=${String(av).slice(0, 40)}`;
      }
      if (own) line += ` = "${own}"`;
      else if (!kids.length) {
        const deep = cleanText(nodeText(el)).slice(0, 40);
        if (deep) line += ` = "${deep}"`;
      }
      lines.push(line);
      for (const c2 of kids) print(c2, depth + 1);
    };
    print(instances[0], 1);
    out.push(lines.join('\n'));
  }
  return out.join('\n');
}

// Candidate record arrays inside an embedded payload: where the records are
// likely to live, with the leaf fields of a sample item (name AND value) so a
// model can see that "subscriberCountText" holds a handle, not a count.
export function jsonCandidates(payload, { maxCandidates = 6, maxLeaves = 18, maxDepth = 8 } = {}) {
  const found = [];
  const collect = (obj, path = '', depth = 0) => {
    if (depth > maxDepth || found.length > 60) return;
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (Array.isArray(v)) {
        if (v.length && v[0] && typeof v[0] === 'object') found.push({ path: p, n: v.length, items: v.slice(0, 3) });
      } else if (v && typeof v === 'object') collect(v, p, depth + 1);
    }
  };
  if (payload && typeof payload === 'object') collect(payload);

  const leavesOf = (item, prefix = '', out = [], depth = 0) => {
    if (out.length >= maxLeaves || depth > 6) return out;
    if (!item || typeof item !== 'object') return out;
    for (const [k, v] of Object.entries(item)) {
      if (out.length >= maxLeaves) break;
      const p = prefix ? `${prefix}.${k}` : k;
      if (v === null || typeof v !== 'object') {
        out.push({ path: p, value: String(v).slice(0, 32) });
      } else if (!Array.isArray(v)) {
        leavesOf(v, p, out, depth + 1);
      }
    }
    return out;
  };

  const scored = found.map((c) => {
    const leafMap = new Map();
    for (const item of c.items) for (const l of leavesOf(item)) if (!leafMap.has(l.path)) leafMap.set(l.path, l);
    return { ...c, leaves: [...leafMap.values()].slice(0, maxLeaves) };
  });
  scored.sort((a, b) => b.leaves.length - a.leaves.length);
  return scored.slice(0, maxCandidates);
}

// A compact outline of an embedded JSON payload: the path a record array
// lives at, and what a record inside it looks like. Without this, a model
// guesses paths and guesses wrong.
export function jsonOutline(value, { maxLines = 120, maxDepth = 7, maxChildren = 2 } = {}) {
  const lines = [];
  const walk = (v, path, depth) => {
    if (lines.length >= maxLines || depth > maxDepth) return;
    if (Array.isArray(v)) {
      lines.push(`${path || '(root)'}[] (${v.length} items)`);
      if (v.length) walk(v[0], `${path}[0]`, depth + 1);
      return;
    }
    if (!v || typeof v !== 'object') return;
    let recursed = 0;
    for (const [k, val] of Object.entries(v)) {
      if (lines.length >= maxLines) return;
      const p = path ? `${path}.${k}` : k;
      if (val === null || typeof val !== 'object') {
        lines.push(`${p} = ${JSON.stringify(String(val).slice(0, 40))}`);
        continue;
      }
      lines.push(`${p}${Array.isArray(val) ? '[]' : '{}'}`);
      if (recursed < maxChildren) { recursed++; walk(val, p, depth + 1); }
    }
  };
  walk(value, '', 0);
  return lines.join('\n');
}

// A compact, model-readable view of a page: structure without the noise.
export function htmlBrief(html, { maxChars = 26000, maxRows = 40, goal = '', url = null } = {}) {
  const doc = parseDoc(html);
  const parts = [`TITLE: ${doc.title}`];

  const tables = doc.queryAll('table').slice(0, 6);
  for (const [i, table] of tables.entries()) {
    const trs = doc.queryAll('tr').filter((tr) => {
      let p = tr.parent;
      while (p && p !== table) { if (p.tag === 'table') return false; p = p.parent; }
      return true;
    }).slice(0, maxRows);
    if (!trs.length) continue;
    parts.push(`\nTABLE ${i + 1} (${trs.length} rows shown)`);
    for (const tr of trs) {
      const cells = (tr.children || [])
        .filter((c) => c.tag === 'td' || c.tag === 'th')
        .map((c) => `${c.tag}:${cleanText(nodeText(c)).slice(0, 40)}`);
      if (cells.length) parts.push('  | ' + cells.join(' | '));
    }
  }

  const ld = doc.queryAll('script[type="application/ld+json"]');
  if (ld.length) parts.push(`\nJSON-LD BLOCKS: ${ld.length}\n${(ld[0].children[0]?.text || '').slice(0, 2000)}`);

  // Structure inventory: what repeats on the page, and where the data hides.
  // The SAMPLE TEXT matters as much as the count: without it a model cannot
  // tell ".text-block-9" (a bullet) from ".meta-data-font" (the date), and it
  // guesses — which is how the same page produced a date in one run and a
  // bullet in the next.
  const hist = new Map();
  const samples = new Map();
  let elements = 0;
  for (const el of walk(doc.root)) {
    if (el.type !== 'element') continue;
    elements++;
    const cls = String(el.attrs?.class || '').split(/\s+/).filter((c) => c && !/^style-scope$|^yt-.*Host$|^ytSpec/.test(c))[0];
    if (!cls) continue;
    const key = `${el.tag}.${cls}`;
    hist.set(key, (hist.get(key) || 0) + 1);
    if (!samples.has(key)) {
      const t = cleanText(nodeText(el)).slice(0, 60);
      if (t) samples.set(key, t);
    }
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (top.length) {
    parts.push(`\nREPEATED CLASSES (tag.class x count — sample text):\n${top.map(([k, v]) => `  ${k} x${v}${samples.has(k) ? ` — "${samples.get(k)}"` : ''}`).join('\n')}`);
  }

  // Element ids and custom elements: the vocabulary a selector needs, with
  // sample text so a model can see that a field holds something else.
  const idCounts = new Map();
  const idSamples = new Map();
  const tagCounts = new Map();
  for (const el of walk(doc.root)) {
    if (el.type !== 'element') continue;
    const tag = el.tag || '';
    if (tag.includes('-')) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    const id = el.attrs?.id;
    if (!id) continue;
    idCounts.set(id, (idCounts.get(id) || 0) + 1);
    if (!idSamples.has(id)) {
      const t = cleanText(nodeText(el)).slice(0, 40);
      if (t) idSamples.set(id, t);
    }
  }
  const topIds = [...idCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  if (topIds.length) {
    parts.push(`\nELEMENT IDS (id xcount — sample text):\n${topIds.map(([id, n]) => `  #${id} x${n}${idSamples.has(id) ? ` — ${idSamples.get(id)}` : ''}`).join('\n')}`);
  }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (topTags.length) {
    parts.push(`\nCUSTOM ELEMENTS (tag xcount):\n${topTags.map(([t, n]) => `  ${t} x${n}`).join('\n')}`);
  }

  const anatomy = recordAnatomy(doc, { goal });
  if (anatomy) parts.push(anatomy.slice(0, 5000));

  const scriptTags = doc.queryAll('script');
  const jsonVars = new Set();
  const jsonScriptTags = [];
  const payloads = [];
  for (const s of scriptTags) {
    const body = s.children?.[0]?.text || '';
    if (!body || body.length < 20) continue;
    if (/json/i.test(String(s.attrs?.type || '')) || s.attrs?.id) jsonScriptTags.push(s.attrs?.id || s.attrs?.type);
    for (const m of body.matchAll(/(?:var|let|const)\s+([\w$]+)\s*=\s*\{/g)) jsonVars.add(m[1]);
    if (payloads.length < 6) {
      const p = parseEmbeddedPayload(body, null);
      if (p && typeof p === 'object') payloads.push({ name: s.attrs?.id || 'embedded', payload: p });
    }
  }
  if (jsonScriptTags.length) parts.push(`\nJSON SCRIPT TAGS: ${[...new Set(jsonScriptTags)].join(', ')}`);
  if (jsonVars.size) parts.push(`\nEMBEDDED JSON VARIABLES: ${[...jsonVars].slice(0, 20).join(', ')}`);

  // rank payloads by how many record-like fields they carry: the config blob
  // ("ytcfg") has thousands of keys but no records
  const ranked = payloads.map((p) => ({ ...p, cands: jsonCandidates(p.payload) }))
    .map((p) => ({ ...p, score: p.cands.reduce((n, c) => n + c.leaves.length, 0) }))
    .sort((a, b) => b.score - a.score);
  for (const { name, payload, cands } of ranked.slice(0, 2)) {
    if (!cands.length) continue;
    const block = cands.map((c) => {
      const leaves = c.leaves.map((l) => `    .${l.path} = ${JSON.stringify(l.value)}`).join('\n');
      return `  ${c.path}[] (${c.n} items)\n${leaves}`;
    }).join('\n');
    parts.push(`\nCANDIDATE RECORD ARRAYS (${name}) — a "path" must end at one of these:\n${block.slice(0, 5000)}`);
  }

  // a raw JSON endpoint: the body IS the payload — outline it
  if (!payloads.length) {
    const whole = (nodeText(doc.root) || '').trim();
    if (whole.startsWith('{') || whole.startsWith('[')) {
      try {
        const body = JSON.parse(whole);
        const outline = jsonOutline(body, { maxLines: 90, maxDepth: 6 });
        if (outline) parts.push(`\nJSON BODY OUTLINE (this URL returns JSON, not HTML):\n${outline.slice(0, 6000)}`);
      } catch { /* not JSON */ }
    }
  }

  const links = doc.queryAll('a[href]').slice(0, 40).map((a) => `${a.attrs.href} :: ${cleanText(nodeText(a)).slice(0, 50)}`);
  if (links.length) parts.push(`\nLINKS (first 40):\n${links.join('\n')}`);

  // The pagination control is usually at the BOTTOM of the page, far past the
  // first 40 links — so the planner never saw it and wrote a plan that stops
  // at page 1. Show it explicitly.
  const pg = detectPagination(doc, url || null);
  if (pg.hasNext) {
    const cands = pg.candidates.map((c) => `${c.text || '(no text)'} -> ${c.href} [${c.why}]`).join('\n');
    parts.push(`\nPAGINATION (this listing CONTINUES on other pages — a plan that ignores this captures only the first page):\nnext link: ${pg.next.text || '(no text)'} -> ${pg.next.href}\ncandidates:\n${cands}`);
  } else {
    parts.push('\nPAGINATION: no next-page link was found on this page (the listing appears to be a single page).');
  }

  const heads = doc.queryAll('h1, h2, h3').slice(0, 25).map((h) => `${h.tag}: ${cleanText(nodeText(h)).slice(0, 70)}`);
  if (heads.length) parts.push(`\nHEADINGS:\n${heads.join('\n')}`);

  const body = doc.query('body') || doc.root;
  parts.push(`\nBODY TEXT (trimmed):\n${cleanText(nodeText(body)).slice(0, maxChars)}`);
  return parts.join('\n').slice(0, maxChars);
}

export async function piAvailable() {
  const res = await runPi(['--version'], { timeoutMs: 30000 });
  return { available: res.ok, version: (res.stdout || '').trim().split('\n')[0], stderr: res.stderr.slice(0, 300) };
}

// ----------------------------------------------------------------- plan

export async function planDatasetWithPi({ url, html, goal = '', name = null, model = null, log = () => {}, auditDir = null, monster = false }) {
  const instruction = `${SYSTEM_RULES}
${monster ? MONSTER_RULES : ''}

Task: design a dataset config that scrapes ${url}.
Goal: ${goal || 'extract the main structured listing or table on this page.'}
Dataset name: ${name || 'auto'}

Reply with this exact shape:
{"name":"snake_case","description":"...","columns":[{"name":"...","type":"string|number|integer|bool|url|date|datetime|enum"}],"key":["col"],
 "sources":[{"id":"main","url":"${url}","extract":{...},"map":{},"paginate":null}]}

extract must be one of:
 - {"kind":"table","table":"<css for the table>","headerMap":{"<lowercased header text>":"<column>"},"cellFields":{"<column>":"a@href"}}
 - {"kind":"selector","row":"<css for each record>","fields":{"<column>":"<field spec>"}}
 - {"kind":"jsonld","types":["Product"],"listPath":"...","fields":{"<column>":"$<dotted.path>"}}
 - {"kind":"json","scriptSelector":"script#__NEXT_DATA__","path":"props.pageProps.items","fields":{"<column>":"$<dotted.path>"}}
Declare 3-12 columns that are genuinely present on the page. Use a paginate object when the listing continues on further pages.

The PAGINATION block of the page brief is decisive: if it says the listing continues, you MUST include a paginate object, or the dataset will hold only the first page. Use:
 - {"mode":"next","selector":"<css for the next link, e.g. a:contains(\\"Next\\")>"}
 - {"mode":"pageNumbers","start":2,"urlTemplate":"https://host/page/{page}","max":20}
 - {"mode":"offset","start":0,"step":50,"urlTemplate":"https://host/list?offset={offset}","max":2000}
 - {"mode":"cursor","selector":"[data-cursor]","attr":"data-cursor","urlTemplate":"https://host/list?cursor={cursor}"}
If there is no PAGINATION block, use paginate: null.`;

  log('info', { msg: 'asking pi to plan extractor', url, model: model || 'default', monster: !!monster });
  const res = await askPi({ instruction, payload: htmlBrief(html, { goal, url }), model, auditDir, log });
  const json = extractJson(res.stdout);
  if (!json) return { ok: false, reason: 'pi returned no parsable JSON', stderr: res.stderr.slice(0, 600), stdout: res.stdout.slice(0, 600) };
  if (name) json.name = name;
  // Keep the URL pi chose. It sees the goal and the page, so it may know that
  // the data lives on another page (a search page, a listing page). Clobbering
  // it with the seed URL is how a good plan dies on the way to the extractor.
  const src = json.sources?.[0];
  if (src) {
    const proposed = String(src.url || '').trim();
    if (!/^https?:\/\//i.test(proposed)) {
      src.url = url;
    } else if (proposed !== url) {
      log('info', { msg: 'plan targets a different url than the seed', seed: url, planned: proposed });
    }
  }
  return { ok: true, cfg: json, raw: res.stdout };
}

// --------------------------------------------------------------- refine

// The plan may point at a different page than the seed (a search page, a
// listing page). That page has never been shown to the model, so plan again
// against it — now with its real structure and its JSON outline.
export async function refinePlanWithPi({ url, html, cfg, goal = '', model = null, monster = false, log = () => {}, auditDir = null }) {
  const instruction = `${SYSTEM_RULES}
${monster ? MONSTER_RULES : ''}

Task: you chose this page for the dataset: ${url}
Declared columns (must be preserved exactly): ${JSON.stringify(cfg?.columns?.map((c) => c.name) || [])}
Below is that page for real, with its structure and, if it carries embedded JSON, the JSON OUTLINE of the payload.
Your previous proposal was:
${JSON.stringify(cfg?.sources?.[0]?.extract || {})}

The JSON OUTLINE shows where records actually live. A "path" must end at an ARRAY of records. If that array mixes item kinds, the per-item key belongs in the FIELD path (e.g. field "$.channelRenderer.title.simpleText").

Reply with the corrected extractor only:
{"extract":{...},"map":{},"why":"one short sentence"}

"extract" MUST be one of these kinds:
 - {"kind":"table","table":"<css>","headerMap":{...},"cellFields":{...}}
 - {"kind":"selector","row":"<css for each record>","fields":{"<column>":"<field spec>"}}
 - {"kind":"jsonld","types":["..."],"listPath":"...","fields":{...}}
 - {"kind":"json","scriptSelector":"script","varName":"ytInitialData","path":"<dotted.path ending at an array>","fields":{"<column>":"$.<path in the record>"}}
 - {"kind":"meta","fields":{...}}   - {"kind":"regex","pattern":"...","groups":{...}}
Never invent another kind.

"map" maps an extracted field name to a DECLARED column name: {"<extracted field>":"<column>"}. Omit it when the extractor already uses the column names. Never emit an empty {} spec.`;

  log('info', { msg: 'asking pi to refine the extractor against the chosen page', url });
  const res = await askPi({ instruction, payload: htmlBrief(html, { goal, url }), model, auditDir, log });
  const json = extractJson(res.stdout);
  if (!json?.extract) return { ok: false, reason: 'pi returned no usable extractor', stdout: res.stdout.slice(0, 600) };
  return { ok: true, proposal: json, raw: res.stdout };
}

// Does the extraction contain RECORDS, or did the page serve an error state?
// "There are no data in the selected time period" is a record-looking table
// with one row — and no extractor can fix a page that has no data.
const NO_DATA_RE = /\b(no data|not available|no information|sorry|there are no|invalid|symbol not found|not found|error|try again|unavailable|out of range|no .* in the selected)\b/i;

export function classifyExtraction(records) {
  const rows = records || [];
  if (!rows.length) return { kind: 'empty', reason: 'the extractor matched no rows at all', text: '' };
  const cells = rows.flatMap((r) => Object.values(r).map((v) => String(v ?? '').trim()).filter(Boolean));
  const errorHits = cells.filter((v) => NO_DATA_RE.test(v));
  const cols = Object.keys(rows[0] || {}).length;
  // a row that is nearly empty (next to nothing in a wider table) is not a record
  const nearEmpty = (r) => {
    const filled = Object.values(r).filter((v) => String(v ?? '').trim()).length;
    return filled <= Math.max(1, Math.floor(cols / 3));
  };
  const allNearEmpty = rows.every(nearEmpty);
  const longError = errorHits.find((v) => v.length >= 15);
  if (rows.length <= 3 && (allNearEmpty || longError)) {
    return {
      kind: 'error',
      reason: errorHits.length
        ? 'the page served an error message instead of records'
        : 'the page served a near-empty row instead of records',
      text: (errorHits[0] || cells[0] || '').slice(0, 200),
      rows: rows.length,
    };
  }
  return { kind: 'records', reason: `${rows.length} rows with data`, text: '', rows: rows.length };
}

// The page does not have the data. Ask for the URL that does — a different
// page, or the JSON endpoint behind it. This is the only repair that can work.
export async function alternativeSourceWithPi({ goal, url, pageText, model = null, log = () => {}, auditDir = null }) {
  const instruction = `A scraper needs a different source URL.
Goal: ${goal}
This URL was tried and the page did not contain the data: ${url}
What the page actually said: ${pageText}

Reply with ONE fenced json block and nothing else:
{"url":"<a URL that serves the data>","why":"one short sentence"}
Use the same site if it serves the data somewhere else (a different page, or the JSON endpoint behind it). If nothing on this site can serve the data, reply with {"url":"","why":"<why not>"}.`;
  const res = await askPi({ instruction, payload: '', model, auditDir, log });
  const json = extractJson(res.stdout);
  if (!json) return { ok: false, reason: 'pi returned no parsable answer' };
  const alt = String(json.url || '').trim();
  if (!/^https?:\/\//i.test(alt)) return { ok: false, reason: String(json.why || 'no alternative URL was proposed') };
  return { ok: true, url: alt, why: String(json.why || '') };
}

// Does the scraped data actually answer the goal? Rows are not enough: the
// extractor can match the page and still harvest the wrong fields.
// The shape of what was actually scraped: how many rows, over what window, at
// what granularity. A goal check that sees one row cannot tell hourly bars
// from minute bars, or a 5-row scrape from a full history.
export function describeShape(records, columns = []) {
  const shape = { rows: records.length };
  if (!records.length) return shape;
  const dateCol = columns.find((c) => records.some((r) => r && r[c] && !Number.isNaN(Date.parse(r[c]))));
  if (!dateCol) return shape;
  const times = records.map((r) => Date.parse(r[dateCol])).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (!times.length) return shape;
  shape.datetimeColumn = dateCol;
  shape.first = new Date(times[0]).toISOString();
  shape.last = new Date(times[times.length - 1]).toISOString();
  shape.windowDays = Number(((times[times.length - 1] - times[0]) / 864e5).toFixed(2));
  shape.distinctDays = new Set(times.map((t) => new Date(t).toISOString().slice(0, 10))).size;
  const gaps = new Map();
  for (let i = 1; i < times.length; i++) {
    const g = Math.round((times[i] - times[i - 1]) / 1000);
    gaps.set(g, (gaps.get(g) || 0) + 1);
  }
  if (gaps.size) {
    const [gap, count] = [...gaps.entries()].sort((a, b) => b[1] - a[1])[0];
    shape.gapSeconds = gap;
    shape.gapCount = count;
    shape.granularity = gap >= 86400 ? `${Math.round(gap / 86400)} day(s)` : gap >= 3600 ? `${Math.round(gap / 3600)} hour(s)` : gap >= 60 ? `${Math.round(gap / 60)} minute(s)` : `${gap}s`;
    shape.gaps = Object.fromEntries([...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4));
  }
  // how many distinct minute-of-hour values: 60 means real minute bars
  shape.distinctMinuteOfHour = new Set(times.map((t) => new Date(t).getUTCMinutes())).size;
  shape.sample = records.slice(0, 3);
  return shape;
}

export async function goalCheckWithPi({ goal, columns, sample, shape = null, sourceUrl = '', classification = null, pagination = null, model = null, log = () => {}, auditDir = null }) {
  const evidence = shape
    ? [
      `rows: ${shape.rows}`,
      shape.first ? `first: ${shape.first}` : null,
      shape.last ? `last: ${shape.last}` : null,
      shape.windowDays != null ? `window: ${shape.windowDays} days` : null,
      shape.granularity ? `granularity: ${shape.granularity} (${shape.gapCount} consecutive gaps of ${shape.gapSeconds}s)` : null,
      shape.distinctMinuteOfHour != null ? `distinct minute-of-hour values: ${shape.distinctMinuteOfHour} (60 = real minute bars, 1 = one bar per hour)` : null,
      shape.distinctDays != null ? `distinct calendar days: ${shape.distinctDays}` : null,
      shape.gaps ? `gap histogram (seconds): ${JSON.stringify(shape.gaps)}` : null,
      sourceUrl ? `requested url: ${sourceUrl}` : null,
      classification ? `what the page actually contains: ${classification.kind} — ${classification.reason}${classification.text ? ` ("${classification.text}")` : ''}` : null,
    ].filter(Boolean).join('\n')
    : '(no shape measured)';
  // The judge must know whether the listing CONTINUES. Five rows from a
  // six-page listing is not the same as five rows from a five-row site.
  const pgEvidence = pagination
    ? (pagination.continues
      ? `the listing CONTINUES on other pages (next page: ${pagination.next || 'unknown'}) — the sample below is ONE PAGE, not the whole listing${pagination.followed ? '; the crawl follows the chain' : '; THE PLAN DOES NOT FOLLOW IT, so the crawl would stop after this page'}`
      : 'the page has no next-page link: this is the whole listing')
    : null;
  const instruction = `You are checking whether scraped data answers a request.
Request: ${goal}
Declared columns: ${JSON.stringify(columns)}

DATA SHAPE (measured on the live page — use it, do not guess from one row):
${evidence}
${pgEvidence ? `\nPAGINATION:\n${pgEvidence}\n` : ''}
A sample row: ${JSON.stringify(sample).slice(0, 900)}

Judge the DATA SHAPE as well as the row: the number of rows, the window it covers, and the bar granularity decide whether the request is satisfied (one row per minute is not the same as one row per hour; 500 rows is not a full history).
A provider's own ceiling (e.g. "the maximum window the API allows") is a property of the SOURCE, not of the page you scraped: if the request asked for a window and the data fills it without gaps, do not fail the goal because you cannot see the ceiling from here.
A listing that continues on other pages is NOT covered by the sample: judge the EXTRACTOR, not the page count, when the plan follows the chain.
Name whose fault it is:
  "source"    — the page does not serve the data at all (an error row, an app shell, a login wall, or the WRONG GRANULARITY: daily bars when the request asked for hourly ones)
  "extractor" — the data is there but mis-mapped (the count is in the wrong column, a value is empty, the field names are off)
  "goal"      — the request itself cannot be satisfied by this site (a symbol that does not exist, a window the provider does not serve)
Reply with ONE fenced json block and nothing else:
{"satisfies":true|false,"fault":"source|extractor|goal","reason":"one short sentence"}`;
  const res = await askPi({ instruction, payload: '', model, auditDir, log });
  const json = extractJson(res.stdout);
  const read = (j) => ({
    ok: true,
    satisfies: j.satisfies !== false,
    fault: ['source', 'extractor', 'goal'].includes(String(j.fault)) ? String(j.fault) : 'extractor',
    reason: String(j.reason || ''),
  });
  if (!json) {
    // one retry, then fail closed: an unreadable verdict is not a pass
    log('warn', { msg: 'goal check returned no parsable verdict; retrying', goal: String(goal).slice(0, 80) });
    const again = await askPi({ instruction, payload: '', model, auditDir, log });
    const retry = extractJson(again.stdout);
    if (!retry) return { ok: true, satisfies: false, fault: 'goal', reason: 'the goal check could not reach a verdict (the model reply was not parsable)' };
    return read(retry);
  }
  return read(json);
}

// --------------------------------------------------------------- repair

export async function repairExtractorWithPi({ cfg, source, html, model = null, monster = false, reason = '', sample = null, goal = '', log = () => {}, auditDir = null }) {
  const instruction = `${SYSTEM_RULES}
${monster ? MONSTER_RULES : ''}

Task: the extractor below returns zero usable rows for ${source.url}, but the page is reachable.
Declared columns (must be preserved exactly): ${JSON.stringify(cfg.columns.map((c) => c.name))}
Current extractor: ${JSON.stringify(source.extract)}
${reason ? `A row the current extractor produced: ${JSON.stringify(sample).slice(0, 800)}\nProblem: ${reason}\n` : ''}
Reply with the replacement extractor and, only if field names differ from the column names, a rename map:
{"extract":{...},"map":{},"why":"one short sentence"}

"extract" MUST be one of these kinds:
 - {"kind":"table","table":"<css>","headerMap":{...},"cellFields":{...}}
 - {"kind":"selector","row":"<css for each record>","fields":{"<column>":"<field spec>"}}
 - {"kind":"jsonld","types":["..."],"listPath":"...","fields":{...}}
 - {"kind":"json","scriptSelector":"script","varName":"ytInitialData","path":"<dotted.path ending at an array>","fields":{"<column>":"$.<path in the record>"}}
 - {"kind":"meta","fields":{...}}   - {"kind":"regex","pattern":"...","groups":{...}}
Never invent another kind.

"map" maps an extracted field name to a DECLARED column name: {"<extracted field>":"<column>"}. Omit it when the extractor already uses the column names. Do not include fields for source/page/scraped_at, and never emit an empty {} spec.
If a value sits in the WRONG column, fix it with the map: {"<the field that holds the value>":"<the column that should hold it>"}.`;

  log('info', { msg: 'asking pi to repair extractor', dataset: cfg.name, source: source.id, model: model || 'default' });
  const res = await askPi({ instruction, payload: htmlBrief(html, { goal, url: source.url }), model, auditDir, log });
  const json = extractJson(res.stdout);
  if (!json?.extract) return { ok: false, reason: 'pi returned no usable extractor', stdout: res.stdout.slice(0, 600), stderr: res.stderr.slice(0, 400) };
  return { ok: true, proposal: json, raw: res.stdout };
}

// The agent often over-reaches: an empty {} spec, or a map whose values are
// selectors instead of column names. Keep only what the engine can honour.
export function sanitizeProposal(cfg, proposal) {
  const declared = new Set(cfg.columns.map((c) => c.name));
  const extract = { ...(proposal.extract || {}) };
  if (extract.fields && typeof extract.fields === 'object') {
    const fields = { ...extract.fields };
    for (const [k, v] of Object.entries(fields)) {
      if (!declared.has(k)) delete fields[k];
      else if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) delete fields[k];
    }
    extract.fields = fields;
  }
  const map = {};
  for (const [from, to] of Object.entries(proposal.map || {})) {
    if (typeof to === 'string' && declared.has(to) && from !== to) map[from] = to;
  }
  return { extract, map, why: proposal.why || '' };
}

// Verify a proposal against the live page. Nothing ships unverified.
export function verifyProposal(cfg, source, proposal, html) {
  const clean = sanitizeProposal(cfg, proposal);
  const candidate = { ...source, extract: clean.extract, map: Object.keys(clean.map).length ? clean.map : source.map || {} };
  const types = {};
  for (const c of cfg.columns || []) if (c && c.name) types[c.name] = c.type || 'string';
  let result;
  try {
    result = extractPage({ html, source: candidate, columns: (cfg.columns || []).map((c) => c.name), types });
  } catch (err) {
    return { ok: false, reason: `extractor threw: ${err.message}`, rows: 0 };
  }
  const declared = new Set(cfg.columns.map((c) => c.name));
  const hits = [...result.mappedColumns].filter((c) => declared.has(c));
  const nonEmptyRows = result.records.filter((r) => Object.values(r).some((v) => String(v ?? '').trim()));
  const nonEmpty = nonEmptyRows.length;
  const shape = describeShape(nonEmptyRows, cfg.columns.map((c) => c.name));
  const sampleRows = nonEmptyRows.slice(0, 200); // enough to detect a time axis
  if (nonEmpty < 1) return { ok: false, reason: 'produced 0 non-empty rows', rows: 0, shape };
  // auto-filled columns do not count as coverage: at least 2 real fields must land
  const autoCols = new Set(['source', 'url', 'page', 'scraped_at', 'rank']);
  const real = hits.filter((h) => !autoCols.has(h));
  if (real.length < Math.min(2, [...declared].filter((c) => !autoCols.has(c)).length)) {
    return { ok: false, reason: `matched only ${real.length} declared data column(s): ${real.join(', ') || 'none'}`, rows: nonEmpty, shape };
  }
  return { ok: true, rows: nonEmpty, columns: hits, sample: result.records.slice(0, 3), sampleRows, shape, clean };
}

// The listing must be followed to its end. A plan that ignores the next-page
// link captures only the first page — and the tool would then present those
// few rows as the whole dataset. So the plan is checked against the PAGE, and
// when the plan forgot the pagination it is derived in code (a next link is a
// next link; no model needs to guess it).
export function verifyPagination(cfg, source, html, url) {
  const doc = parseDoc(html || '');
  const det = detectPagination(doc, url);
  const planned = nextPageUrl(doc, source, url, 0);
  if (!det.hasNext) {
    return { ok: true, continues: false, planned: planned || null, reason: 'the page has no next-page link' };
  }
  if (planned) {
    return { ok: true, continues: true, planned, detected: det, reason: 'the plan follows the listing' };
  }
  const spec = det.next.selector ? { mode: 'next', selector: det.next.selector } : null;
  if (!spec) {
    return { ok: false, continues: true, detected: det, reason: `the listing continues (${det.next.href}) but the plan does not follow it, and that link has no stable selector` };
  }
  const derived = nextPageUrl(doc, { ...source, paginate: spec }, url, 0);
  if (!derived) {
    return { ok: false, continues: true, detected: det, reason: `the derived pagination did not resolve (${spec.selector})` };
  }
  return { ok: true, continues: true, planned: derived, derived: spec, detected: det, reason: 'the plan ignored the next-page link; the pagination was derived from the page' };
}

// The TYPE follows the DATA. A page that says "July 1, 2025" offers a DAY;
// typing the column "datetime" prints a time of day that was never scraped
// (and shifts the calendar date in a non-UTC zone). So the type is measured
// from the values — the same source then yields the same shape in polite mode
// and in monster mode.
export function typeColumnsByData(cfg, sampleRows, { log = () => {} } = {}) {
  const changed = [];
  for (const col of cfg.columns || []) {
    if (!col || !col.name) continue;
    if (!['string', 'date', 'datetime'].includes(col.type)) continue;
    const values = (sampleRows || []).map((r) => r?.[col.name]);
    const det = detectTimeKind(values);
    if (!det.kind) continue;
    const want = (det.precision || 'day') === 'second' ? 'datetime' : 'date';
    if (col.type === want) continue;
    log('info', {
      msg: 'the column type follows the data', column: col.name, from: col.type, to: want,
      precision: det.precision, reason: det.reason,
      note: 'a date-only source must not be printed as a timestamp with an invented time',
    });
    col.type = want;
    changed.push({ column: col.name, from: col.type, to: want, precision: det.precision });
  }
  return changed;
}

export async function saveRepair(root, cfg, sourceId, proposal, { log = () => {}, sampleRows = null } = {}) {
  const dir = path.join(root, 'datasets');
  await mkdir(dir, { recursive: true });
  const file = cfg.file && cfg.file.endsWith('.json') ? cfg.file : path.join(dir, `${cfg.name}.json`);
  let target;
  try { target = JSON.parse(await readFile(file, 'utf8')); } catch { target = null; }
  target ||= {
    name: cfg.name,
    description: cfg.description,
    columns: cfg.columns.map((c) => ({ name: c.name, type: c.type })),
    key: cfg.key,
    sources: cfg.sources,
  };
  const src = (target.sources || []).find((s) => String(s.id || 'main') === String(sourceId));
  if (!src) throw new Error(`source "${sourceId}" not found in ${file}`);
  const clean = sanitizeProposal(cfg, proposal);
  src.extract = clean.extract;
  if (Object.keys(clean.map).length) src.map = clean.map;
  else delete src.map;
  const validated = validateDataset(target, file);
  await writeDatasetFile(dir, validated);

  // The type follows the data — a repaired source that reads the date
  // correctly must not keep printing it as a fabricated timestamp.
  const retyped = typeColumnsByData(cfg, sampleRows || [], { log });
  if (retyped.length) {
    const target = cfg.file && cfg.file.endsWith('.json') ? cfg.file : path.join(root, 'datasets', `${cfg.name}.json`);
    await writeDatasetFile(path.dirname(target), cfg);
  }

  // A repaired source must be crawlable again: reset its checkpoint but keep
  // the raw log, so already-ingested rows dedupe instead of duplicating.
  const { datasetPaths: dpaths, loadState: loadSt, saveState: saveSt, dropSourceRows } = await import('./store.mjs');
  const paths = dpaths(root, validated.name);
  const st = await loadSt(paths);
  const prevRows = st.sources?.[sourceId]?.rows || 0;
  // The rows the OLD extractor wrote are stale: the repaired extractor reads
  // the page differently, so keeping them would make the re-crawl dedupe
  // against them and the repair would change nothing. They go, and the
  // re-crawl puts the truth back.
  const dropped = await dropSourceRows(paths, sourceId, { log: (level, data) => log(level, data) });
  st.sources[sourceId] = { done: false, page: 0, nextUrl: null, fetched: 0, rows: 0, drift: false, lastRun: null, error: null };
  await saveSt(paths, st);
  return { file, dropped: dropped.dropped, previousRows: prevRows };
}
