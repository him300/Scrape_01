// Structured JSONL run log (machine-readable, append-only) + compact console.
import { open, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ORDER = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger({ dir = null, level = 'info', console: toConsole = true, pretty = true, sinks = [] } = {}) {
  const threshold = ORDER[level] ?? ORDER.info;
  let file = null;

  async function handle() {
    if (file) return file;
    if (!dir) return null;
    await mkdir(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    file = path.join(dir, `run-${day}.jsonl`);
    return file;
  }

  function fmt(obj) {
    const { level: lvl, msg, time, ...rest } = obj;
    const extras = Object.entries(rest)
      .filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'object' && !Object.keys(v).length))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    return `${obj.time.slice(11, 19)} ${String(lvl).padEnd(5)} ${msg || ''}${extras ? '  ' + extras : ''}`;
  }

  const write = (lvl, payload) => {
    const obj = { time: new Date().toISOString(), level: lvl, ...payload };
    const l = ORDER[lvl] ?? 20;
    if (toConsole && l >= threshold) {
      const line = pretty ? fmt(obj) : JSON.stringify(obj);
      (l >= ORDER.warn ? console.error : console.log)(line);
    }
    handle().then((f) => {
      if (!f) return;
      open(f, 'a').then(async (fh) => { try { await fh.writeFile(JSON.stringify(obj) + '\n'); } finally { await fh.close(); } }).catch(() => {});
    }).catch(() => {});
    for (const sink of sinks) { try { sink(obj); } catch { /* a sink must never break a run */ } }
    return obj;
  };

  const log = (lvl, payload) => write(lvl, typeof payload === 'string' ? { msg: payload } : payload);
  log.debug = (p) => write('debug', typeof p === 'string' ? { msg: p } : p);
  log.info = (p) => write('info', typeof p === 'string' ? { msg: p } : p);
  log.warn = (p) => write('warn', typeof p === 'string' ? { msg: p } : p);
  log.error = (p) => write('error', typeof p === 'string' ? { msg: p } : p);
  log.level = level;
  return log;
}
