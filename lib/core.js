import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const DK_HOME = path.join(os.homedir(), '.devkit');
export const APPS_DIR = path.join(DK_HOME, 'apps');
export const LOCK_FILE = path.join(DK_HOME, '.lock');
export const STATE_DIR = path.join(DK_HOME, 'state');
export const DEPS_DIR = path.join(DK_HOME, 'deps');
export const DEPS_FILE = path.join(DEPS_DIR, 'package.json');
export const DEPS_NM = path.join(DEPS_DIR, 'node_modules');

// MOTEUR .dk — aucun module externe (Node natif uniquement)
// Format .dk v2 : magic "DKPK" | version | headerSize u32 LE
// | header JSON | payload (chunks compressés + dédupliqués)
export const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', 'target', '__pycache__', '.venv', 'vendor', '.turbo', 'out'];
export const DK_MAGIC = Buffer.from('DKPK');
export const DK_VERSION = 2;
export const SUPPORTED_VERSIONS = new Set([1, 2]);
export const ZLIB_LEVEL = 9;
export const BROTLI_QUALITY = 9;
export const EXTRACT_CONCURRENCY = 16;

let _zlib = null;
export async function zlibMod() { if (!_zlib) _zlib = await import('zlib'); return _zlib; }
let _crypto = null;
export async function cryptoMod() { if (!_crypto) _crypto = await import('crypto'); return _crypto; }

export async function loadTable() { return (await import('cli-table3')).default; }
export async function loadFg() { return (await import('fast-glob')).default; }
export async function loadExeca() { return (await import('execa')).execa; }

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
export function ttyCols() {
  const c = process.stdout.columns;
  return c && c > 20 ? c : 80;
}
export function wrapAnsi(text, width) {
  if (!text) return [''];
  const lines = [];
  const tokens = text.match(/\x1b\[[0-9;]*m|[\S]|\s+/g) || [];
  let line = '';
  let vis = 0;
  const pushHard = (tok) => {
    const chars = tok.match(/\x1b\[[0-9;]*m|[\s\S]/g);
    for (const ch of chars) {
      if (/^\x1b/.test(ch)) { line += ch; continue; }
      if (vis > 0 && vis + 1 > width) { lines.push(line); line = ''; vis = 0; }
      line += ch; vis += 1;
    }
  };
  for (const tok of tokens) {
    if (/^\x1b/.test(tok)) { line += tok; continue; }
    const tv = stripAnsi(tok).length;
    if (/^\s+$/.test(tok)) {
      if (line && vis + tv > width) { lines.push(line.trimEnd()); line = ''; vis = 0; }
      else if (line) { line += tok; vis += tv; }
      continue;
    }
    if (vis > 0 && vis + tv > width) {
      lines.push(line.trimEnd());
      line = '';
      vis = 0;
    }
    if (tv > width) pushHard(tok);
    else { line += tok; vis += tv; }
  }
  lines.push(line.trimEnd());
  return lines.length ? lines.map(l => l.trimEnd() || ' ') : [''];
}
export function truncVis(s, w) {
  let out = '';
  let vis = 0;
  const tokens = s.match(/\x1b\[[0-9;]*m|[\s\S]/g) || [];
  for (const t of tokens) {
    if (/^\x1b/.test(t)) { out += t; continue; }
    if (vis >= w) { out += '…'; break; }
    out += t; vis += 1;
  }
  return out;
}
export function humanSize(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(1) + 'MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + 'KB';
  return b + 'B';
}
export function clearLine() { process.stderr.write('\r\x1b[K'); }

export function ensureDirs() { fs.mkdirSync(APPS_DIR, { recursive: true }); }

export function acquireLock() {
  ensureDirs();
  if (fs.existsSync(LOCK_FILE)) return false;
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}
export function releaseLock() { fs.rmSync(LOCK_FILE, { force: true }); }

export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function readPackage(dir) {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

export function parseCommandLine(parts) {
  const args = [];
  for (const part of parts) {
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(part))) args.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return [args[0] || '', args.slice(1)];
}

export function runApp([cmd, args], dir, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: dir, stdio: ['inherit', 'inherit', 'pipe'], env: env || process.env });
    let log = '';
    p.stderr.on('data', (d) => {
      log = (log + d.toString()).slice(-200000);
      process.stderr.write(d);
    });
    p.on('error', (e) => resolve({ status: 1, error: e, log }));
    p.on('close', (code) => resolve({ status: typeof code === 'number' ? code : 1, log }));
  });
}

export function appEnv(manifest) { return { ...process.env, ...(manifest.env || {}) }; }

export function stateFile(name) { return path.join(STATE_DIR, `${String(name).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`); }
export function loadState(name) {
  try { return JSON.parse(fs.readFileSync(stateFile(name), 'utf-8')); } catch { return {}; }
}
export function saveState(name, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFile(name), JSON.stringify(state, null, 2));
}
