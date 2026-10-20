// One repair implementation, shared by the CLI and the web UI.
// Fetch -> ask pi -> sanitise -> verify on the live page -> save + reset checkpoint.

import path from 'node:path';
import { makeClient } from './pipeline.mjs';
import { repairExtractorWithPi, verifyProposal, saveRepair } from './agent.mjs';

export async function repairFlowJob({ root, cfg, sourceId, params = {}, ctx = {}, log = () => {} }) {
  const source = cfg.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error(`unknown source "${sourceId}"`);
  const monster = !!params.monster;

  const client = makeClient(root, { profile: monster ? 'monster' : (cfg.profile || 'polite'), minDelayMs: monster ? 0 : 300, cacheTtlSec: 0 }, log);
  log('info', { msg: 'repair: fetching page', dataset: cfg.name, source: sourceId, url: source.url });
  const page = await client.get(source.url, { retries: 2, cacheTtlSec: 0 });

  const res = await repairExtractorWithPi({
    cfg, source, html: page.body, model: params.model || null, monster, log,
    auditDir: path.join(root, '.scrape01', 'agent'),
  });
  if (!res.ok) throw new Error(`pi returned no usable extractor (${res.reason})`);

  const check = verifyProposal(cfg, source, res.proposal, page.body);
  if (!check.ok) throw new Error(`proposal rejected by verification: ${check.reason}`);
  log('info', { msg: 'repair: proposal verified on live page', rows: check.rows, columns: check.columns });

  const saved = await saveRepair(root, cfg, sourceId, res.proposal, { log, sampleRows: check.sampleRows || [] });
  const file = saved.file;
  await client.close?.().catch(() => {});
  log('info', {
    msg: 'extractor repaired; checkpoint reset so the next run re-crawls',
    dataset: cfg.name, source: sourceId, file: path.relative(root, file), why: res.proposal.why,
    staleRowsDropped: saved.dropped || 0,
  });
  return {
    dataset: cfg.name, source: sourceId, rows: check.rows,
    columns: check.columns, why: res.proposal.why || '', file,
    staleRowsDropped: saved.dropped || 0,
    sample: check.sample || null,
  };
}
