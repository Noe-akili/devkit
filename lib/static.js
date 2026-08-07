import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { runApp } from './core.js';

// SERVEUR STATIQUE DEVKIT (Node natif) — sert dist sans backend
const STATIC_SERVER_SRC = String.raw`
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const port = parseInt(process.argv[3], 10);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm', '.txt': 'text/plain', '.xml': 'application/xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.manifest': 'text/cache-manifest',
};
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\//, '');
  let target = path.join(root, rel);
  if (!exists(target)) {
    const idx = path.join(root, 'index.html');
    if (exists(idx)) target = idx;
  }
  if (!exists(target)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 Not Found'); return; }
  const ext = path.extname(target).toLowerCase();
  try {
    const data = fs.readFileSync(target);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  } catch { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('500'); }
});
server.on('error', (e) => { console.error('serveur statique:', e.message); process.exit(1); });
server.listen(port, '0.0.0.0', () => console.log('SERVING ' + port));
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
`;

export function findFreePort(pref) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(findFreePort(pref + 1)));
    srv.listen(pref, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

export async function runStaticServer(webroot, port) {
  const script = path.join(os.tmpdir(), 'devkit-static-server.js');
  fs.writeFileSync(script, STATIC_SERVER_SRC);
  return runApp(['node', [script, webroot, String(port)]], webroot, process.env);
}
