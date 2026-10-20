// The LAB TARGET — an instrumented site that behaves like a modern bot
// manager, and lives entirely on 127.0.0.1.
//
// It is a TLS terminator (so it can read the ClientHello and the HTTP/2
// frames) plus an app that records everything a real bot manager would look
// at: JA3/JA4, header order, HTTP/2 SETTINGS, canvas/WebGL fingerprints,
// navigator.webdriver, behavioural telemetry, and a local challenge.
//
// It REFUSES to bind anywhere but loopback. This is a measuring instrument,
// not a deployable target.

import http2 from 'node:http2';
import tls from 'node:tls';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientHelloFrom, ja3, ja4 } from './ja3.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(DIR, '.cert');
const HOST = '127.0.0.1';   // loopback only. always.

export function ensureCert() {
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  if (existsSync(key) && existsSync(cert)) return { key: readFileSync(key), cert: readFileSync(cert) };
  mkdirSync(CERT_DIR, { recursive: true });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '365', '-subj', '/CN=lab.local', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:lab.local',
  ], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>lab target</title>
<style>body{font:14px/1.5 system-ui;margin:24px;max-width:760px}
pre{background:#f3f3f1;padding:12px;overflow:auto;font:12px ui-monospace,monospace}
#pad{width:320px;height:120px;border:1px solid #bbb;background:#fafafa;position:relative}
.k{position:absolute;width:6px;height:6px;background:#c00;border-radius:50%}</style></head><body>
<h1>lab target</h1>
<p>This page reports what a bot manager can see about the client.</p>
<div id="pad"></div>
<pre id="out">collecting…</pre>
<h3>challenge</h3>
<p id="ch">loading…</p>
<input id="ans" placeholder="answer"><button id="go">submit</button>
<p id="res"></p>
<script>
const out = document.getElementById('out');
function hash(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0}return h.toString(16).padStart(8,'0')}
function fingerprint(){
  const c=document.createElement('canvas');c.width=280;c.height=80;const x=c.getContext('2d');
  x.textBaseline='top';x.font='16px "Segoe UI", Arial';
  x.fillStyle='#f60';x.fillRect(10,10,80,30);
  x.fillStyle='#069';x.fillText('lab-canvas-\u2728',12,48);
  const data=c.toDataURL();
  let gl=null, vendor='', renderer='';
  try{ gl=c.getContext('webgl'); if(gl){const d=gl.getExtension('WEBGL_debug_renderer_info');
    vendor=d?gl.getParameter(d.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR);
    renderer=d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);} }catch(e){}
  return {
    canvasHash: hash(data),
    canvasDataUrlPrefix: data.slice(0,40),
    webglVendor: vendor, webglRenderer: renderer,
    webdriver: navigator.webdriver === true,
    plugins: navigator.plugins.length,
    languages: (navigator.languages||[]).join(','),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: screen.width + 'x' + screen.height + 'x' + (window.devicePixelRatio||1),
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
}
const behaviour={moves:[],keys:[],first:performance.now(),last:performance.now()};
document.addEventListener('mousemove',e=>{const t=performance.now();behaviour.last=t;behaviour.moves.push([Math.round(e.clientX),Math.round(e.clientY),Math.round(t-behaviour.first)]);if(behaviour.moves.length>400)behaviour.moves.shift()});
document.addEventListener('keydown',e=>{const t=performance.now();behaviour.last=t;behaviour.keys.push([e.key.length,Math.round(t-behaviour.first)])});
document.addEventListener('mouseleave',()=>{behaviour.last=performance.now()});

async function report(){
  const fp=fingerprint();
  const r=await fetch('/collect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fp,behaviour,idle:Math.round(behaviour.last-behaviour.first)})});
  const j=await r.json();
  out.textContent=JSON.stringify({...j,client:fp},null,2);
}
fetch('/challenge').then(r=>r.json()).then(c=>{document.getElementById('ch').textContent=c.prompt+' = ?';document.getElementById('ans').dataset.prompt=c.prompt});
document.getElementById('go').onclick=async()=>{
  const t0=performance.now();
  const r=await fetch('/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answer:document.getElementById('ans').value,elapsedMs:Math.round(performance.now()-t0)})});
  const j=await r.json();
  document.getElementById('res').textContent=JSON.stringify(j);
  report();
};
setTimeout(report,400);
</script></body></html>`;

export function startTarget({ port = 8788, banAfter = 6 } = {}) {
  const { key, cert } = ensureCert();
  const sessions = new Map();     // remotePort -> {ja3, ja4, headers, settings, ...}
  const challenges = new Map();   // id -> {prompt, issued}
  const attempts = [];
  const bans = new Map();         // identity -> count
  let seq = 0;

  const server = http2.createSecureServer({ key, cert, allowHTTP1: true, ALPNProtocols: ['h2', 'http/1.1'] });

  server.on('session', (session) => {
    const rec = sessions.get(session.socket?.remotePort) || {};
    rec.settings = session.remoteSettings;
    rec.httpVersion = session.alpnProtocol || 'h2';
    rec.sessionId = session.sessionId;
    sessions.set(session.socket?.remotePort, rec);
    session.on('close', () => { if (session.socket) sessions.delete(session.socket.remotePort); });
  });

  server.on('request', (req, res) => {
    const url = new URL(req.url, `https://${HOST}`);
    const rec = sessions.get(req.socket?.remotePort) || {};
    rec.headers = req.rawHeaders;
    rec.url = req.url;
    rec.ua = req.headers['user-agent'] || '';
    rec.identity = req.headers['x-lab-identity'] || rec.ua || 'unknown';
    sessions.set(req.socket?.remotePort, rec);

    // the ban oracle: too many requests from one identity gets throttled
    const n = (bans.get(rec.identity) || 0) + 1;
    bans.set(rec.identity, n);
    if (n > banAfter) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: 'rate limited by the lab ban oracle', identity: rec.identity, requests: n }));
      return;
    }

    if (url.pathname === '/collect' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
        Object.assign(rec, { client: payload.fp, behaviour: payload.behaviour, idleMs: payload.idle });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, score: behaviourScore(payload.behaviour, payload.fp) }));
      });
      return;
    }
    if (url.pathname === '/challenge') {
      const a = 10 + Math.floor(Math.random() * 90);
      const b = 10 + Math.floor(Math.random() * 90);
      const id = `c${++seq}`;
      challenges.set(id, { prompt: `${a} + ${b}`, answer: a + b, issued: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, prompt: `${a} + ${b}` }));
      return;
    }
    if (url.pathname === '/verify' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const c = challenges.get(req.headers['x-lab-challenge'] || '') || null;
        const solved = c ? String(payload.answer).trim() === String(c.answer) : false;
        const tooFast = c ? (Date.now() - c.issued) < 1200 : false;
        attempts.push({ solved, tooFast, elapsedMs: payload.elapsedMs ?? null, identity: rec.identity });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ solved, tooFast, note: tooFast ? 'answered faster than a human could read it' : 'timing looks human' }));
      });
      return;
    }
    if (url.pathname === '/report') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        sessions: [...sessions.values()],
        attempts,
        bans: Object.fromEntries(bans),
        note: 'lab target — loopback only',
      }, null, 2));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });

  // the TLS observer: read the ClientHello before the TLS stack eats it
  const front = net.createServer((socket) => {
    const onFirst = (chunk) => {
      socket.pause();
      socket.removeListener('data', onFirst);
      const hello = clientHelloFrom(chunk);
      if (hello) {
        sessions.set(socket.remotePort, { ja3: ja3(hello), ja4: ja4(hello, { host: HOST }) });
      }
      socket.unshift(chunk);
      socket.resume();
      server.emit('connection', socket);
    };
    socket.on('data', onFirst);
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    front.listen(port, HOST, () => {
      resolve({
        url: `https://${HOST}:${port}/`,
        port,
        sessions, attempts, bans,
        close: () => new Promise((r) => { front.close(() => server.close(() => r())); }),
      });
    });
  });
}

// A deliberately simple behavioural scorer: are the movements and the delays
// shaped like a person, or like a script?
export function behaviourScore(behaviour = {}, fp = {}) {
  const moves = behaviour.moves || [];
  const keys = behaviour.keys || [];
  const out = { moves: moves.length, keys: keys.length, reasons: [] };
  if (fp.webdriver) out.reasons.push('navigator.webdriver is true');
  if (moves.length === 0) out.reasons.push('no mouse movement at all');
  else {
    const gaps = [];
    for (let i = 1; i < moves.length; i++) gaps.push(moves[i][2] - moves[i - 1][2]);
    const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / (gaps.length || 1));
    out.meanGap = Math.round(mean);
    out.gapSd = Math.round(sd);
    if (sd < 4) out.reasons.push(`mouse timings are nearly perfectly regular (sd ${Math.round(sd)}ms)`);
  }
  if (keys.length && keys.every((k) => k[1] % 1000 === 0)) out.reasons.push('keystroke timestamps are suspiciously round');
  out.humanLike = out.reasons.length === 0;
  return out;
}
