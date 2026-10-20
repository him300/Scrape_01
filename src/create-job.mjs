// The create flow: seed page -> plan -> refine -> verify -> repair -> save -> run.
//
// One flow for the CLI and the web UI, so both get the same self-healing
// behaviour. Nothing is written until an extractor has produced real rows
// against the live page, and the columns are checked against the goal.

import path from 'node:path';
import { makeClient } from './pipeline.mjs';
import { validateDataset, writeDatasetFile, columnNames } from './config.mjs';
import { planDatasetWithPi, refinePlanWithPi, repairExtractorWithPi, goalCheckWithPi, verifyProposal, verifyPagination, classifyExtraction, alternativeSourceWithPi, typeColumnsByData } from './agent.mjs';
import { detectTimeColumn } from './timeorder.mjs';
import { looksLikeData } from './extract.mjs';

export async function createFlowJob({ root, url, goal = '', name, model = null, monster = false, params = {}, ctx = {}, log = () => {} }) {
  const auditDir = path.join(root, '.scrape01', 'agent');
  const client = makeClient(root, { profile: monster ? 'monster' : 'polite', minDelayMs: monster ? 0 : 400, cacheTtlSec: 0 }, log);
  const pages = new Map(); // url -> html

  const fetchPage = async (u) => {
    if (pages.has(u)) return pages.get(u);
    const res = await client.get(u, { retries: 2, cacheTtlSec: 0 });
    pages.set(u, res.body);
    return res.body;
  };

  // The page pi plans from: raw HTML when it already carries records, and the
  // RENDERED page only when the raw one is an app shell. The browser is a
  // fallback, not the default — it costs the site far more.
  const pageWithData = async (u) => {
    const raw = await fetchPage(u);
    if (!monster || looksLikeData(raw)) return raw;
    const rendered = await client.renderPage?.(u, { timeoutMs: 60000 });
    if (rendered?.html) {
      log('info', { msg: 'the raw page had no records; planning from the rendered page', url: u, bytes: rendered.html.length });
      pages.set(u, rendered.html);
      return rendered.html;
    }
    return raw;
  };

  try {
    log('info', { msg: 'fetching seed page', url, monster });
    const seedHtml = await pageWithData(url);

    // 1. plan
    const planned = await planDatasetWithPi({ url, html: seedHtml, goal, name, model, monster, log, auditDir });
    if (!planned.ok) throw new Error(`pi could not plan this dataset: ${planned.reason}`);
    if (model) planned.cfg.model = model;

    const file = path.join(root, 'datasets', `${name}.json`);
    let cfg;
    try {
      cfg = validateDataset({ ...planned.cfg, name, profile: monster ? 'monster' : (planned.cfg.profile || null) }, file);
    } catch (err) {
      throw new Error(`pi proposed an invalid config (${err.message})`);
    }

    // 2. the plan may point at another page — plan again, now against it
    const source = cfg.sources[0];
    if (source.url !== url) {
      log('info', { msg: 'plan points at another page; re-planning against it', url: source.url });
      const targetHtml = await pageWithData(source.url);
      const refined = await refinePlanWithPi({ url: source.url, html: targetHtml, cfg, goal, model, monster, log, auditDir });
      if (refined.ok) {
        const clean = verifyProposal(cfg, source, refined.proposal, targetHtml);
        if (clean.ok) {
          source.extract = clean.clean.extract;
          if (Object.keys(clean.clean.map).length) source.map = clean.clean.map; else delete source.map;
          log('info', { msg: 'refined extractor verified', rows: clean.rows, columns: clean.columns });
        } else {
          log('warn', { msg: 'refined extractor did not verify, keeping the original', reason: clean.reason });
        }
      }
    }

    // 3. verify against the live page; repair on failure
    let sourceHtml = await pageWithData(source.url);
    let check = verifyProposal(cfg, source, { extract: source.extract, map: source.map || {} }, sourceHtml);
    const attempts = [];

    // 3a. the page may simply not HAVE the data (an error row, an app shell,
    // the wrong granularity). No extractor can fix that — so change the SOURCE,
    // not the selector.
    const switchSource = async (why) => {
      const alt = await alternativeSourceWithPi({ goal, url: source.url, pageText: why, model, log, auditDir });
      if (!alt.ok) return { ok: false, reason: alt.reason || 'no alternative source was found' };
      log('info', { msg: 'switching to a different source', from: source.url, to: alt.url, why: alt.why });
      source.url = alt.url;
      sourceHtml = await pageWithData(source.url);
      const refined = await refinePlanWithPi({ url: source.url, html: sourceHtml, cfg, goal, model, monster, log, auditDir });
      if (refined.ok) {
        const clean = verifyProposal(cfg, source, refined.proposal, sourceHtml);
        if (clean.ok) {
          source.extract = clean.clean.extract;
          if (Object.keys(clean.clean.map).length) source.map = clean.clean.map; else delete source.map;
          log('info', { msg: 'refined extractor verified on the new source', rows: clean.rows, columns: clean.columns });
        } else {
          log('warn', { msg: 'refined extractor did not verify on the new source', reason: clean.reason });
        }
      }
      check = verifyProposal(cfg, source, { extract: source.extract, map: source.map || {} }, sourceHtml);
      return { ok: true, url: alt.url, why: alt.why };
    };

    for (let hop = 0; hop < 3; hop++) {
      const cls = check.ok ? classifyExtraction(check.sampleRows || []) : { kind: 'records' };
      if (!check.ok || cls.kind !== 'error') break;
      log('warn', { msg: 'the page served an error state, not records', url: source.url, reason: cls.reason, text: cls.text });
      const hop1 = await switchSource(cls.text || cls.reason);
      if (!hop1.ok) {
        throw new Error(`the page does not serve the requested data ("${cls.text || cls.reason}") — nothing was written. ${hop1.reason || ''} The goal was: ${goal}`);
      }
    }

    for (let i = 0; i < 2 && !check.ok; i++) {
      log('warn', { msg: 'extractor did not verify, asking pi to repair', reason: check.reason, attempt: i + 1 });
      const res = await repairExtractorWithPi({ cfg, source, html: sourceHtml, model, monster, goal, reason: check.reason, sample: check.sample?.[0] || null, log, auditDir });
      if (!res.ok) { attempts.push(res.reason); break; }
      check = verifyProposal(cfg, source, res.proposal, sourceHtml);
      attempts.push(check.ok ? 'repaired' : check.reason);
      if (check.ok) {
        source.extract = check.clean.extract;
        if (Object.keys(check.clean.map).length) source.map = check.clean.map; else delete source.map;
      }
    }

    if (!check.ok) {
      throw new Error(`the proposed extractor matched nothing on the live page; nothing was written (${check.reason})`);
    }

    // The TYPE follows the DATA. A page that says "July 1, 2025" offers a
    // DAY; typing the column "datetime" prints a time of day that was never
    // scraped (and shifts the calendar date in a non-UTC zone). So the type
    // is measured from the values — the same source then yields the same
    // shape in polite mode and in monster mode.
    typeColumnsByData(cfg, check.sampleRows || [], { log });

    // 3b. the listing must be followed to its END. A plan that ignores the
    // next-page link captures page 1 and the tool would present those rows as
    // the whole dataset — the difference between 25 rows and 5. The plan is
    // checked against the page, and a missing pagination is derived in code.
    let pagination = { continues: false, next: null, followed: false };
    {
      const pg = verifyPagination(cfg, source, sourceHtml, source.url);
      if (pg.continues && pg.derived) {
        log('warn', {
          msg: 'the plan ignored the next-page link; the pagination was derived from the page',
          source: source.id, next: pg.planned, selector: pg.derived.selector, reason: pg.reason,
          note: 'without this the dataset would hold only the first page',
        });
        source.paginate = pg.derived;
      } else if (pg.continues && !pg.ok) {
        throw new Error(
          `the listing continues on other pages (${pg.detected?.next?.href || 'next page unknown'}) but the plan does not follow it, ` +
          `and the pagination could not be derived (${pg.reason}) — nothing was written, because a dataset that holds only the first page is not the dataset.`
        );
      } else if (pg.continues) {
        log('info', { msg: 'the plan follows the listing to its end', source: source.id, next: pg.planned });
      } else {
        log('info', { msg: 'the page has no next-page link; the listing is a single page', source: source.id });
      }
      pagination = { continues: !!pg.continues, next: pg.planned || pg.detected?.next?.href || null, followed: !!pg.planned };
    }

    // a key column that is always empty cannot deduplicate anything
    const sample = check.sample?.[0] || null;
    if (sample) {
      const keyCol = cfg.key[0];
      const keyValue = keyCol ? String(sample[keyCol] ?? '').trim() : '';
      if (keyCol && !keyValue) {
        const better = cfg.columns.map((c) => c.name).find((n) => n !== keyCol && String(sample[n] ?? '').trim());
        if (better) {
          log('warn', { msg: 'key column is empty in the sample; using a populated column instead', from: keyCol, to: better });
          cfg.key = [better];
        }
      }
    }

    // 4. does the data answer the goal, or just exist? And if not, WHOSE fault
    // is it: the extractor's, the source's, or the request's?
    let goalNote = '';
    let goalSatisfied = true;
    let fault = '';
    if (goal && sample) {
      for (let round = 0; round < 3; round++) {
        const verdict = await goalCheckWithPi({ goal, columns: columnNames(cfg), sample: check.sample?.[0] || null, shape: check.shape, sourceUrl: source.url, classification: classifyExtraction(check.sampleRows || []), pagination, model, log, auditDir });
        goalNote = verdict.reason || '';
        goalSatisfied = verdict.satisfies !== false;
        fault = verdict.fault || 'extractor';
        if (goalSatisfied) break;
        log('warn', { msg: 'rows do not answer the goal', reason: goalNote, fault });

        // the SOURCE is at fault: this page does not serve the requested data
        if (fault === 'source') {
          const hop = await switchSource(goalNote);
          if (!hop.ok) {
            throw new Error(`the page does not serve the requested data — nothing was written. ${hop.reason || ''} (${goalNote}) The goal was: ${goal}`);
          }
          if (!check.ok) break;
          // the source changed, so the pagination must be re-checked
          const pg2 = verifyPagination(cfg, source, sourceHtml, source.url);
          if (pg2.continues && pg2.derived) {
            log('warn', { msg: 'the plan ignored the next-page link; the pagination was derived from the page', source: source.id, next: pg2.planned, selector: pg2.derived.selector });
            source.paginate = pg2.derived;
          } else if (pg2.continues && !pg2.ok) {
            throw new Error(`the listing continues on other pages but the pagination could not be derived (${pg2.reason}) — nothing was written.`);
          }
          pagination = { continues: !!pg2.continues, next: pg2.planned || pg2.detected?.next?.href || null, followed: !!pg2.planned };
          continue;
        }
        // the REQUEST is at fault: no amount of scraping will satisfy it
        if (fault === 'goal') {
          throw new Error(`the request cannot be satisfied by this page — nothing was written. ${goalNote} The goal was: ${goal}`);
        }
        // the EXTRACTOR is at fault: the data is there but mis-mapped
        const res = await repairExtractorWithPi({ cfg, source, html: sourceHtml, model, monster, goal, reason: goalNote, sample: check.sample?.[0] || null, log, auditDir });
        if (!res.ok) { log('warn', { msg: 'goal repair produced no extractor', reason: res.reason }); break; }
        const again = verifyProposal(cfg, source, res.proposal, sourceHtml);
        if (!again.ok) {
          log('warn', { msg: 'goal repair did not verify; keeping the previous extractor', reason: again.reason });
          break;
        }
        source.extract = again.clean.extract;
        if (Object.keys(again.clean.map).length) source.map = again.clean.map; else delete source.map;
        check = again;
      }
    }

    // The promise: nothing is written until the rows answer the request.
    if (!goalSatisfied) {
      throw new Error(
        `the extractor produced rows, but they do not answer the goal ("${goal}") — nothing was written. ` +
        `pi's verdict: ${goalNote || 'unspecified'}. ` +
        `The page it scraped: ${source.url}. Re-run with a sharper goal, or write the config by hand.`
      );
    }

    // A time series is ordered by its time axis, whatever the column's type:
    // the detector reads the VALUES (iso strings, epoch numbers, "Oct 20, 2026",
    // day-first dates) and refuses anything ambiguous.
    if (!cfg.sortBy) {
      const det = detectTimeColumn(columnNames(cfg), check.sampleRows || [], { key: cfg.key });
      const wantsRecent = /\b(latest|most recent|recent|last \d+|top \d+)\b/i.test(goal);
      if (det.column && !wantsRecent) {
        cfg.sortBy = `${det.column}:asc`;
        cfg.timeKinds = { ...(cfg.timeKinds || {}), [det.column]: det.kind };
        log('info', {
          msg: 'row order set from the detected time axis',
          column: det.column, kind: det.kind, coverage: det.coverage, distinct: det.distinct,
          note: 'the interpretation is recorded in the config; "scrape01 sort <dataset> --reset" undoes it',
        });
      } else if (det.column && wantsRecent) {
        log('info', { msg: 'the goal asks for the most recent rows, so the page order is kept', column: det.column, kind: det.kind });
      } else if (!det.column) {
        log('info', { msg: 'no unambiguous time axis found, so the page order is kept', reason: det.reason, rejected: det.rejected });
      }
    }

    const written = await writeDatasetFile(path.join(root, 'datasets'), cfg);
    log('info', { msg: 'dataset saved', file: path.relative(root, written), columns: columnNames(cfg), goal: goalNote });

    return { cfg, file: written, verification: check, goal: goalNote, attempts };
  } finally {
    await client.close?.().catch(() => {});
  }
}
