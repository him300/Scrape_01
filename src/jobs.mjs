// In-process job runner for the web UI: one job at a time (which keeps the
// single-writer guarantee), live log lines, and cooperative cancellation.

import { randomUUID } from 'node:crypto';
import { createLogger } from './log.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createJobRunner({ root, logDir, verbose = false, log = () => {} }) {
  const jobs = new Map();
  const subscribers = new Map(); // jobId -> Set(fn)
  const queue = [];
  let active = null;
  let seq = 0;

  const nowIso = () => new Date().toISOString();

  function broadcast(job, event, payload) {
    const subs = subscribers.get(job.id);
    if (!subs) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const fn of [...subs]) { try { fn(frame); } catch { /* dropped client */ } }
  }

  function summary(job) {
    return {
      id: job.id, kind: job.kind, label: job.label, dataset: job.dataset,
      status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      params: job.params, result: job.result, error: job.error, cancelled: job.cancelled,
      lineCount: job.lines.length, queuePosition: job.status === 'queued' ? queue.indexOf(job) + 1 : 0,
    };
  }

  function create({ kind, label, dataset = null, params = {}, run }) {
    const job = {
      id: `${kind}-${++seq}-${randomUUID().slice(0, 8)}`,
      kind, label, dataset, params,
      status: 'queued', createdAt: nowIso(), startedAt: null, finishedAt: null,
      lines: [], result: null, error: null, cancelRequested: false, cancelled: false,
      run,
    };
    jobs.set(job.id, job);
    queue.push(job);
    drain();
    return job;
  }

  async function drain() {
    if (active) return;
    const job = queue.shift();
    if (!job) return;
    active = job;
    job.status = 'running';
    job.startedAt = nowIso();
    broadcast(job, 'status', summary(job));
    log('info', { msg: 'job started', id: job.id, kind: job.kind, label: job.label });

    const sink = (record) => {
      const line = { ...record, level: record.level || 'info' };
      job.lines.push(line);
      if (job.lines.length > 5000) job.lines.splice(0, job.lines.length - 5000);
      broadcast(job, 'line', line);
    };
    const jobLog = createLogger({
      dir: logDir,
      level: verbose ? 'debug' : 'info',
      console: verbose,
      sinks: [sink],
    });
    const ctx = {
      root,
      log: jobLog,
      shouldStop: () => job.cancelRequested,
      job,
    };

    try {
      job.result = await job.run(ctx);
      job.status = job.cancelled || job.result?.cancelled ? 'cancelled' : 'ok';
    } catch (err) {
      job.error = String(err.message || err);
      job.status = err.code === 'LOCKED' ? 'locked' : 'failed';
      sink({ time: nowIso(), level: 'error', msg: 'job failed', error: job.error });
    } finally {
      job.finishedAt = nowIso();
      active = null;
      broadcast(job, 'status', summary(job));
      log(job.status === 'ok' ? 'info' : 'warn', { msg: 'job finished', id: job.id, status: job.status, ms: Date.parse(job.finishedAt) - Date.parse(job.startedAt) });
      subscribers.delete(job.id);
      drain();
    }
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return { ok: false, reason: 'unknown job' };
    if (job.status !== 'queued' && job.status !== 'running') return { ok: false, reason: `job is ${job.status}` };
    job.cancelRequested = true;
    job.cancelled = true;
    if (job.status === 'queued') {
      const i = queue.indexOf(job);
      if (i > -1) queue.splice(i, 1);
      job.status = 'cancelled';
      job.finishedAt = nowIso();
      broadcast(job, 'status', summary(job));
    }
    return { ok: true };
  }

  function subscribe(id, fn) {
    const job = jobs.get(id);
    if (!job) return null;
    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(fn);
    return () => subscribers.get(id)?.delete(fn);
  }

  function get(id) {
    const job = jobs.get(id);
    return job ? { ...summary(job), lines: job.lines.slice(-500) } : null;
  }

  function list(limit = 30) {
    return [...jobs.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map(summary);
  }

  return { create, get, list, cancel, subscribe, get active() { return active ? summary(active) : null; }, get queueLength() { return queue.length; } };
}

export { LEVELS };
