// JA3 / JA4 from a raw ClientHello.
//
// The ClientHello is the first TLS flight and it is NOT encrypted, so a server
// (or a passive observer in front of one) can read it. This parser turns those
// bytes into the two fingerprints bot managers actually compare:
//   JA3  — Salesforce's classic: TLSVersion,Ciphers,Extensions,Curves,PointFormats → MD5
//   JA4  — FoxIO's successor, hashed and order-insensitive for ciphers/extensions
//
// References: salesforce.github.io/ja3, github.com/FoxIO-LLC/ja4

import { createHash } from 'node:crypto';

function u16(b, o) { return b.readUInt16BE(o); }
function u24(b, o) { return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]; }

// Parse one ClientHello (the handshake message, without the record header).
export function parseClientHello(body) {
  let o = 0;
  const version = u16(body, o); o += 2;         // legacy_version
  o += 32;                                      // random
  const sidLen = body[o]; o += 1 + sidLen;      // session id
  const csLen = u16(body, o); o += 2;
  const ciphers = [];
  for (let i = 0; i < csLen / 2; i++) { ciphers.push(u16(body, o)); o += 2; }
  const compLen = body[o]; o += 1 + compLen;    // compression methods
  const exts = [];
  let curves = [];
  let pointFormats = [];
  let sni = '';
  if (o + 2 <= body.length) {
    const extsLen = u16(body, o); o += 2;
    const end = Math.min(o + extsLen, body.length);
    while (o + 4 <= end) {
      const type = u16(body, o); const len = u16(body, o + 2); o += 4;
      const data = body.subarray(o, o + len); o += len;
      exts.push(type);
      if (type === 10 && data.length >= 2) {     // supported_groups
        const n = u16(data, 0);
        for (let i = 0; i + 1 < 2 + n; i += 2) curves.push(u16(data, 2 + i));
      } else if (type === 11 && data.length >= 1) { // ec_point_formats
        const n = data[0];
        for (let i = 0; i < n && 1 + i < data.length; i++) pointFormats.push(data[1 + i]);
      } else if (type === 0 && data.length >= 5) { // server_name
        const n = u16(data, 3);
        sni = data.subarray(5, 5 + n).toString('utf8');
      }
    }
  }
  return { version, ciphers, extensions: exts, curves, pointFormats, sni };
}

// Pull the ClientHello out of a TLS record stream.
export function clientHelloFrom(bytes) {
  if (bytes.length < 5 || bytes[0] !== 0x16) return null;
  const recLen = u16(bytes, 3);
  if (bytes[5] !== 0x01) return null;            // not a ClientHello
  const body = bytes.subarray(5, 5 + Math.min(recLen, bytes.length - 5));
  return parseClientHello(body);
}

const md5 = (s) => createHash('md5').update(s).digest('hex');
const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

export function ja3(hello) {
  const version = hello.version;
  const ciphers = hello.ciphers.join('-');
  const exts = hello.extensions.join('-');
  const curves = hello.curves.join('-');
  const formats = hello.pointFormats.join('-');
  const string = `${version},${ciphers},${exts},${curves},${formats}`;
  return { string, hash: md5(string) };
}

export function ja4(hello, { host = '' } = {}) {
  // ja4: t|tls version|counts|sha of sorted ciphers|sha of sorted extensions
  const proto = hello.version === 0x0304 ? '13' : hello.version === 0x0303 ? '12' : '11';
  const target = host || hello.sni || 'ip';
  const domain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(target) ? 'd' : 'i';
  const ver = String(hello.version).padStart(4, '0');
  const ciphers = [...hello.ciphers].sort((a, b) => a - b);
  const exts = [...hello.extensions].sort((a, b) => a - b);
  const cipherSha = sha12(ciphers.join('-'));
  const extSha = sha12(exts.join('-'));
  const last = exts.length ? exts[exts.length - 1] : 0;
  return `t${proto}${domain}${ver}_${ciphers.length}_${exts.length}_${cipherSha}_${extSha}${String(last).padStart(2, '0')}`;
}
