// The crawl + ingest engine. One page at a time, commit-then-checkpoint.

import path from 'node:path';
import { rm } from 'node:fs/promises';
import { createClient } from './net.mjs';
import { extractPage, nextPageUrl, detectPagination } from './extract.mjs';
import { coerceRow, columnNames, columnTypes, setDatasetPagination } from './config.mjs';
import { datasetPaths, ensureDir, acquireLock, loadState, saveState, readJsonl, streamJsonl, appendLines, sha256 } from './store.mjs';
import { writeCsv, writeCsvStreaming } from './csvio.mjs';
import { resolveProfile, describeProfile } from './profile.mjs';
import { extractPageAuto } from './extract.mjs';

const AUTO = new Set(['source', 'url', 'page', 'scraped_at', 'rank']);

function recordKey(cfg, values) {
  const parts = cfg.key.length ? cfg.key.map((k) => values[k]) : columnNames(cfg).map((k) => values[k]);
  const basis = parts.map((v) => (v === null || v === undefined ? '' : String(v))).join('\u0001');
  if (!basis.replace(/\u0001/g, '').trim()) return null;
  return sha256(basis).slice(0, 24);
}

export function makeClient(root, opts, log) {
  const profile = resolveProfile({
    datasetProfile: opts.profile ?? null,
    monster: opts.monster ?? false,
    respectRobots: opts.respectRobots ?? false,
    profileName: opts.profileName ?? null,
    overrides: {
      minDelayMs: opts.minDelayMs,
      retries: opts.retries,
      timeoutMs: opts.timeoutMs,
    },
  });
  return createClient({
    cacheDir: path.join(root, '.scrape01', 'cache'),
    cacheTtlSec: opts.cacheTtlSec ?? 3600,
    minDelayMs: profile.minDelayMs,
    profile,
    log,
  });
}

export async function runDataset(cfg, opts) {
  const { root, log, dryRun = false, force = false, fresh = false, maxPages = null, client = null } = opts;
  const profile = resolveProfile({
    datasetProfile: cfg.profile ?? null,
    monster: opts.monster ?? false,
    respectRobots: opts.respectRobots ?? cfg.respectRobots ?? false,
    profileName: opts.profileName ?? null,
    overrides: { minDelayMs: opts.minDelayMs, retries: opts.retries, timeoutMs: opts.timeoutMs },
  });
  const paths = datasetPaths(root, cfg.name);
  await ensureDir(paths.base);
  const http = client || makeClient(root, { ...opts, profile: cfg.profile }, log);
  const lock = dryRun ? { release: async () => {} } : await acquireLock(paths.lock, { log });

  const summary = {
    dataset: cfg.name, startedAt: new Date().toISOString(), sources: [], pages: 0, fetched: 0,
    newRows: 0, duplicates: 0, rejected: 0, drift: [], skipped: [], errors: [], csv: null, cancelled: false,
    stoppedEarly: [], recovered: 0, paginationFixed: [], pagesWithoutRecords: [],
  };

  try {
    const state = await loadState(paths);
    // A FRESH run throws the old log away. The log holds what a previous run
    // produced, under the rules of that run: if the column types or the
    // coercion rules have changed since, the old rows are stale and a
    // re-crawl must replace them, not sit next to the new ones.
    if (fresh && !dryRun) {
      await rm(paths.raw, { force: true });
      await rm(paths.csv, { force: true });
      await rm(paths.manifest, { force: true });
      state.ord = 0;
      state.sources = {};
      await saveState(paths, state);
      log('warn', { msg: 'fresh run: the old log and CSV were discarded', dataset: cfg.name, note: 'every row is fetched again from the source' });
    }
    // Only the dedupe keys are needed up front — holding every row in memory
    // is what used to cap a dataset at a few million rows.
    const { keys: priorKeys, count: priorCount } = await readJsonl(paths.raw, { keysOnly: true, log });
    const seen = new Set(priorKeys);
    log('info', { msg: 'dataset start', dataset: cfg.name, existingRows: priorCount, sources: cfg.sources.length, dryRun, profile: describeProfile(profile) });

    const declared = new Set(columnNames(cfg));
    const autoUsed = [...declared].filter((c) => AUTO.has(c));
    if (autoUsed.length) log('debug', { msg: 'auto-filled columns', columns: autoUsed });

    for (const source of cfg.sources) {
      const st = (state.sources[source.id] ||= { done: false, page: 0, nextUrl: null, fetched: 0, rows: 0, drift: false, lastRun: null, error: null });
      if (st.done && !force) {
        summary.skipped.push(source.id);
        log('info', { msg: 'source already complete (use --force to re-crawl)', source: source.id, rows: st.rows });
        continue;
      }
      const sSum = { id: source.id, pages: 0, records: 0, newRows: 0, duplicates: 0, rejected: 0, coerced: 0, empty: 0, placeholder: 0, recovered: 0, softColumns: new Set(), firstUrl: null, lastUrl: null, note: null };
      let url = force || !st.nextUrl ? source.url : st.nextUrl;
      let pageIndex = force ? 0 : st.page || 0;
      let pagesThisRun = 0;
      let sourceRows = 0;
      const visited = new Set();
      const pageLimit = maxPages ?? Math.max(cfg.limits.maxPages || 0, profile.limits.maxPages || 0);

      while (url && pagesThisRun < pageLimit) {
        if (opts.shouldStop && opts.shouldStop()) {
          summary.cancelled = true;
          st.error = null;
          log('warn', { msg: 'cancelled by request; checkpoint kept', dataset: cfg.name, source: source.id, page: pageIndex });
          break;
        }
        let fetched;
        try {
          fetched = await http.get(url, {
            retries: opts.retries ?? profile.retries,
            timeoutMs: opts.timeoutMs ?? profile.timeoutMs,
            cacheTtlSec: opts.cacheTtlSec ?? 3600,
            headers: source.headers || {},
          });
        } catch (err) {
          st.error = String(err.message || err);
          st.stoppedEarly = { page: pageIndex, reason: `fetch failed: ${st.error}` };
          summary.errors.push({ source: source.id, url, error: st.error });
          summary.stoppedEarly.push({ source: source.id, page: pageIndex, url, reason: `fetch failed: ${st.error}` });
          log('error', { msg: 'fetch failed', source: source.id, url, error: st.error, note: 'the crawl stopped here — the dataset is INCOMPLETE, not finished' });
          break;
        }
        summary.fetched++;

        const ct = fetched.contentType || '';
        if (ct && !/html|json|xml|text\/plain/i.test(ct)) {
          log('warn', { msg: 'non-text response, skipping', url, contentType: ct });
          sSum.note = `skipped ${ct}`;
          break;
        }

        let extracted;
        try {
          extracted = extractPage({ html: fetched.body, source, columns: columnNames(cfg), types: columnTypes(cfg) });
          // The raw page carried no records: the browser is the FALLBACK, not
          // the default. Cheaper for the site, and no 20s round trip when the
          // HTML already had the data.
          if (!extracted.records.length && profile.render && http.renderPage) {
            const rendered = await http.renderPage(url, { timeoutMs: opts.timeoutMs ?? profile.timeoutMs });
            if (rendered?.html) {
              const viaBrowser = extractPage({ html: rendered.html, source, columns: columnNames(cfg), types: columnTypes(cfg) });
              if (viaBrowser.records.length) {
                log('info', { msg: 'the raw page had no rows; the rendered page did', source: source.id, url, rows: viaBrowser.records.length });
                extracted = viaBrowser;
              }
            }
          }
          // still barren: try the other strategies on the same page
          if (!extracted.records.length && profile.render) {
            const auto = extractPageAuto({ html: fetched.body, source, columns: columnNames(cfg) });
            if (auto.records.length) {
              log('warn', { msg: 'declared extractor matched nothing; recovered with another strategy', source: source.id, url, declared: source.extract?.kind, used: auto.strategy, attempts: auto.attempts });
              extracted = auto;
            }
          }
          if (extracted.strategy && extracted.strategy !== (source.extract?.kind || 'table')) {
            log('warn', { msg: 'declared extractor matched nothing; recovered with another strategy', source: source.id, url, declared: source.extract?.kind, used: extracted.strategy, attempts: extracted.attempts });
          }
          if (!extracted.records.length) {
            sSum.noRecords = (sSum.noRecords || 0) + 1;
            log('warn', { msg: 'no records on this page', source: source.id, page: pageIndex + 1, url, note: 'the declared extractor matched nothing here — this page has a different layout (no rows were invented)' });
          }
        } catch (err) {
          summary.errors.push({ source: source.id, url, error: String(err.message || err) });
          st.stoppedEarly = { page: pageIndex, reason: `extraction failed: ${err.message}` };
          summary.stoppedEarly.push({ source: source.id, page: pageIndex, url, reason: `extraction failed: ${err.message}` });
          log('error', { msg: 'extraction failed', source: source.id, url, error: String(err.message || err), note: 'the crawl stopped here — the dataset is INCOMPLETE, not finished' });
          break;
        }

        const scrapedAt = new Date().toISOString();
        const pageRows = [];
        const rejects = [];
        const dataCols = columnNames(cfg).filter((c) => !AUTO.has(c));
        for (const [i, rec] of extracted.records.entries()) {
          const merged = { ...rec };
          for (const col of columnNames(cfg)) if (merged[col] === undefined && rec[col.toLowerCase()] !== undefined) merged[col] = rec[col.toLowerCase()];
          // provenance columns are filled by the engine when the extractor leaves them blank
          const blank = (v) => v === undefined || v === null || String(v).trim() === '';
          if (declared.has('source') && blank(merged.source)) merged.source = source.id;
          if (declared.has('url') && blank(merged.url)) merged.url = fetched.finalUrl || url;
          if (declared.has('page') && blank(merged.page)) merged.page = pageIndex + 1;
          if (declared.has('scraped_at') && blank(merged.scraped_at)) merged.scraped_at = scrapedAt;
          if (declared.has('rank') && blank(merged.rank)) merged.rank = i + 1;

          const { values, errors, soft } = coerceRow(cfg, merged, { baseUrl: fetched.finalUrl || url });
          if (errors.length) {
            sSum.rejected++;
            rejects.push({ at: scrapedAt, source: source.id, page: pageIndex + 1, url: fetched.finalUrl || url, row: i + 1, errors, raw: rec });
            continue;
          }
          // an optional column that could not be coerced loses that CELL, not
          // the whole row: one "-" in a volume column must not delete a price
          if (soft?.length) {
            sSum.coerced += soft.length;
            for (const e of soft) sSum.softColumns.add(e.split(':')[0]);
          }
          // a record whose data columns are all empty carries nothing: drop it
          if (dataCols.length && dataCols.every((c) => blank(values[c]))) { sSum.empty++; continue; }
          // a declared placeholder row (all the listed columns are zero) is not data
          if (cfg.dropAllZero?.length) {
            const zeroed = cfg.dropAllZero.every((c) => Number(values[c]) === 0);
            if (zeroed) { sSum.placeholder++; continue; }
          }
          const key = recordKey(cfg, values);
          if (key && seen.has(key)) { sSum.duplicates++; continue; }
          if (key) seen.add(key);
          state.ord += 1;
          pageRows.push({ _ord: state.ord, _key: key || '', _src: source.id, _page: pageIndex + 1, _url: fetched.finalUrl || url, _at: scrapedAt, ...values });
        }

        sSum.pages++;
        sSum.records += extracted.records.length;
        sSum.newRows += pageRows.length;
        sSum.firstUrl ||= url;
        sSum.lastUrl = url;
        sourceRows += pageRows.length;

        if (!dryRun) {
          // commit data first, checkpoint second: a crash can only repeat work
          await appendLines(paths.raw, pageRows);
          await appendLines(paths.rejects, rejects);
        }

        // The plan's pagination first. If the plan has none — or its selector
        // does not match this page — the PAGE still knows where the next page
        // is. Following it is the difference between a whole dataset and the
        // first five rows; stopping quietly is how a 25-row listing became 5.
        let nextUrl = nextPageUrl(extracted.doc, source, fetched.finalUrl || url, pagesThisRun);
        if (!nextUrl) {
          const here = fetched.finalUrl || url;
          const det = detectPagination(extracted.doc, here);
          if (det.hasNext && det.next.href && det.next.href !== here) {
            nextUrl = det.next.href;
            const fix = { source: source.id, page: pageIndex + 1, nextUrl, how: det.next.why, text: det.next.text };
            summary.paginationFixed.push(fix);
            log('warn', {
              msg: 'the plan did not follow the next-page link; the engine followed it',
              source: source.id, page: pageIndex + 1, next: nextUrl, how: det.next.why, linkText: det.next.text,
              note: 'the corrected pagination is written to the dataset config, so the next run follows the same chain',
            });
            // persist it: the next run must produce the SAME dataset
            const spec = det.next.selector ? { mode: 'next', selector: det.next.selector } : null;
            if (spec) {
              try {
                await setDatasetPagination(path.join(root, 'datasets', `${cfg.name}.json`), source.id, spec);
                source.paginate = spec;
                log('info', { msg: 'pagination written back to the dataset config', source: source.id, paginate: spec });
              } catch (err) {
                log('warn', { msg: 'could not write the corrected pagination to the config', error: String(err.message || err) });
              }
            } else {
              log('info', { msg: 'the corrected pagination has no stable selector, so it was not written to the config', source: source.id, linkText: det.next.text });
            }
          }
        }
        pageIndex++;
        pagesThisRun++;
        visited.add(url);
        // a pagination that points back at a page already fetched would loop
        // for ever: stop, and say so
        if (nextUrl && visited.has(nextUrl)) {
          summary.stoppedEarly.push({ source: source.id, page: pageIndex, url: nextUrl, reason: 'the pagination points back at a page already fetched' });
          st.stoppedEarly = { page: pageIndex, reason: 'the pagination points back at a page already fetched' };
          log('warn', { msg: 'the pagination loops back to a page already fetched; stopping here', source: source.id, url: nextUrl, note: 'the dataset is INCOMPLETE, not finished' });
          nextUrl = null;
        }
        st.page = pageIndex;
        st.nextUrl = nextUrl;
        st.done = !nextUrl;
        st.fetched += 1;
        st.rows += pageRows.length;
        st.lastRun = scrapedAt;
        st.lastUrl = url;
        if (!dryRun) await saveState(paths, state);

        log('debug', { msg: 'page committed', source: source.id, page: pageIndex, records: extracted.records.length, newRows: pageRows.length, duplicates: sSum.duplicates, next: nextUrl || null });
        url = nextUrl;
        if (source.delayMs) await new Promise((r) => setTimeout(r, source.delayMs));
      }

      // DRIFT means the extractor no longer matches the page — NOT that the
      // rows were already ingested. A re-run that finds only duplicates is a
      // healthy dataset, not a broken one.
      if (sSum.pages > 0 && sSum.records === 0) {
        st.drift = true;
        st.error = st.error || 'extracted 0 valid rows';
        summary.drift.push(source.id);
        log('warn', { msg: 'DRIFT: page(s) fetched but no rows matched the extractor', source: source.id, hint: `scrape01 repair ${cfg.name} ${source.id}` });
      } else if (sSum.pages > 0 && sSum.newRows === 0 && sSum.duplicates === 0) {
        st.drift = true;
        st.error = st.error || 'every record was rejected by the column types';
        summary.drift.push(source.id);
        log('warn', { msg: 'DRIFT: rows were extracted but none of them could be written', source: source.id, hint: `scrape01 repair ${cfg.name} ${source.id}` });
      } else if (sSum.pages > 0 && !st.drift) st.drift = false;
      summary.pages += sSum.pages;
      summary.newRows += sSum.newRows;
      summary.duplicates += sSum.duplicates;
      summary.rejected += sSum.rejected;
      summary.coerced = (summary.coerced || 0) + sSum.coerced;
      summary.placeholder = (summary.placeholder || 0) + sSum.placeholder;
      if (sSum.noRecords) {
        summary.pagesWithoutRecords.push({ source: source.id, pages: sSum.noRecords });
        log('warn', { msg: 'some pages matched no records', source: source.id, pages: sSum.noRecords, note: 'those pages are reported, not filled in' });
      }
      if (cfg.limits?.maxRows && summary.totalRows > cfg.limits.maxRows) {
        log('warn', { msg: 'the dataset is larger than its declared maxRows; the limit is advisory, not enforced', dataset: cfg.name, rows: summary.totalRows, maxRows: cfg.limits.maxRows });
      }
      if (sSum.placeholder) {
        log('info', { msg: 'placeholder rows dropped (declared zero rows)', source: source.id, count: sSum.placeholder });
      }
      if (sSum.coerced) {
        log('warn', { msg: 'some values could not be coerced; those cells are empty', source: source.id, count: sSum.coerced, columns: [...sSum.softColumns] });
      }
      summary.sources.push({ ...sSum, softColumns: undefined });
    }

    state.runs = (state.runs || 0) + 1;
    state.lastRun = summary.startedAt;
    summary.finishedAt = new Date().toISOString();
    state.lastSummary = { ...summary, sources: summary.sources.map((s) => ({ id: s.id, pages: s.pages, newRows: s.newRows })) };
    if (!dryRun) await saveState(paths, state);

    // The CSV is a projection of the raw log. Without a declared order it is
    // the log's own order, so it can be STREAMED out — no giant array, no
    // 512 MB string. With a declared order the rows must be held to sort.
    if (!dryRun) {
      if (!cfg.sortBy) {
        summary.csv = await writeCsvStreaming(paths, cfg, streamJsonl(paths.raw, { log }), { log });
        summary.totalRows = summary.csv.rows;
      } else {
        const { rows: finalRows } = await readJsonl(paths.raw, { log });
        summary.totalRows = finalRows.length;
        summary.csv = await writeCsv(paths, cfg, finalRows, { log });
      }
    } else {
      const { count } = await readJsonl(paths.raw, { keysOnly: true, log });
      summary.totalRows = count;
    }
    log('info', {
      msg: 'dataset done', dataset: cfg.name, newRows: summary.newRows, totalRows: summary.totalRows,
      duplicates: summary.duplicates, rejected: summary.rejected, pages: summary.pages, drift: summary.drift.length,
      stoppedEarly: summary.stoppedEarly.length, paginationFixed: summary.paginationFixed.length,
      pagesWithoutRecords: summary.pagesWithoutRecords.length,
    });
    if (summary.stoppedEarly.length) {
      log('warn', {
        msg: 'the dataset is INCOMPLETE — the crawl stopped before the listing ended',
        dataset: cfg.name, stopped: summary.stoppedEarly,
        note: 'a partial dataset is not a finished one; re-run to continue from the checkpoint',
      });
    }
    if (summary.paginationFixed.length) {
      log('info', { msg: 'the pagination was corrected during the crawl', dataset: cfg.name, fixed: summary.paginationFixed });
    }
    return summary;
  } finally {
    await lock.release();
    if (!client) await http.close?.().catch(() => {});
  }
}

export async function rebuildDataset(cfg, { root, log }) {
  const paths = datasetPaths(root, cfg.name);
  // stream it when the order is the log's own; sort in memory only when asked
  if (!cfg.sortBy) {
    const manifest = await writeCsvStreaming(paths, cfg, streamJsonl(paths.raw, { log }), { log });
    log('info', { msg: 'rebuild complete', dataset: cfg.name, rows: manifest.rows, streamed: true });
    return { manifest, rows: manifest.rows, torn: false };
  }
  const { rows, torn } = await readJsonl(paths.raw, { log });
  const manifest = await writeCsv(paths, cfg, rows, { log });
  log('info', { msg: 'rebuild complete', dataset: cfg.name, rows: rows.length, repairedTornLine: torn });
  return { manifest, rows: rows.length, torn };
}
