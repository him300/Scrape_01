// JavaScript rendering via the Chrome DevTools Protocol — no npm dependencies.
//
// Node 22 ships a global WebSocket, so we can drive a locally installed
// Chrome/Edge/Chromium directly: launch it headless, open a target, navigate,
// and read back the rendered DOM. This is what lets a scraper see the page a
// human sees instead of the empty app shell that server-side HTML ships.
//
// The browser is a local tool. It renders pages; it does not defeat CAPTCHAs,
// fingerprint defences or bans. If a site blocks the client, that answer
// stands — the renderer just makes JS apps legible.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.SCRAPE01_BROWSER || process.env.PIDU_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

export function findBrowser() {
  for (const c of CANDIDATES) {
    try { if (existsSync(c)) return c; } catch { /* unreadable path */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ------------------------------------------------------------- CDP client

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message || 'CDP error'} (${msg.error.code || '?'})`));
        else p.resolve(msg.result || {});
        return;
      }
      const list = this.handlers.get(msg.method) || [];
      for (const h of list) {
        try { h(msg.params || {}, msg.sessionId); } catch { /* a handler must not kill the socket */ }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP websocket timeout')), 15000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error('CDP websocket error: ' + (e.message || 'unknown'))); }, { once: true });
    });
    return new Cdp(ws);
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

// ------------------------------------------------------------- renderer

export class Renderer {
  constructor({ bin, userAgent, log = () => {}, headless = true } = {}) {
    this.bin = bin;
    this.userAgent = userAgent;
    this.log = log;
    this.headless = headless;
    this.proc = null;
    this.cdp = null;
    this.profileDir = null;
    this.closed = false;
  }

  static async create(opts = {}) {
    const bin = opts.bin || findBrowser();
    if (!bin) {
      const err = new Error('no Chrome/Edge/Chromium found for JS rendering (set SCRAPE01_BROWSER to a browser binary)');
      err.code = 'NO_BROWSER';
      throw err;
    }
    const r = new Renderer({ ...opts, bin });
    await r.start();
    return r;
  }

  async start() {
    this.profileDir = await mkdtemp(path.join(os.tmpdir(), 'scrape01-render-'));
    const port = await freePort();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=1366,2200',
      'about:blank',
    ];
    if (this.headless) args.unshift('--headless=new');
    if (this.userAgent) args.unshift(`--user-agent=${this.userAgent}`);

    this.proc = spawn(this.bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.proc.on('error', (err) => this.log('warn', { msg: 'browser failed to start', error: String(err.message || err) }));
    this.proc.unref?.();

    let info = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) { info = await res.json(); break; }
      } catch { /* not up yet */ }
      await sleep(150);
    }
    if (!info) {
      await this.close();
      const err = new Error(`browser did not expose a devtools endpoint on port ${port}`);
      err.code = 'NO_BROWSER';
      throw err;
    }
    this.cdp = await Cdp.connect(info.webSocketDebuggerUrl);
    this.log('debug', { msg: 'renderer ready', browser: info.Browser, bin: this.bin });
  }

  async render(url, { timeoutMs = 45000, settleMs = 1200 } = {}) {
    if (this.closed) throw new Error('renderer is closed');
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, timeoutMs);
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, timeoutMs);
    try {
      await this.cdp.send('Page.enable', {}, sessionId, timeoutMs);
      await this.cdp.send('Network.enable', {}, sessionId, timeoutMs);
      if (this.userAgent) {
        try { await this.cdp.send('Network.setUserAgentOverride', { userAgent: this.userAgent }, sessionId, timeoutMs); }
        catch { /* not fatal */ }
      }

      let loaded = false;
      const onLoad = (_p, sid) => { if (sid === sessionId) loaded = true; };
      this.cdp.on('Page.loadEventFired', onLoad);

      const nav = await this.cdp.send('Page.navigate', { url }, sessionId, timeoutMs);
      if (nav.errorText) {
        this.log('warn', { msg: 'navigation error', url, error: nav.errorText });
      }
      const loadDeadline = Date.now() + Math.max(2000, timeoutMs - 5000);
      while (!loaded && Date.now() < loadDeadline) await sleep(100);
      if (settleMs) await sleep(settleMs);

      const res = await this.cdp.send('Runtime.evaluate', {
        expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
        returnByValue: true,
      }, sessionId, timeoutMs);
      const href = await this.cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId, 10000)
        .then((r) => r.result?.value).catch(() => url);
      const title = await this.cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId, 10000)
        .then((r) => r.result?.value).catch(() => '');

      return { html: res.result?.value || '', finalUrl: href || url, title: title || '' };
    } finally {
      try { await this.cdp.send('Target.closeTarget', { targetId }, undefined, 5000); } catch { /* browser may be gone */ }
    }
  }

  async close() {
    this.closed = true;
    try { await this.cdp?.send('Browser.close', {}, undefined, 3000); } catch { /* ignore */ }
    this.cdp?.close();
    try { this.proc?.kill(); } catch { /* ignore */ }
    if (this.profileDir) { try { await rm(this.profileDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    this.proc = null;
    this.cdp = null;
  }
}
