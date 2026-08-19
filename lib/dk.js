import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  DK_HOME, APPS_DIR, DK_MAGIC, DK_VERSION, SUPPORTED_VERSIONS, ZLIB_LEVEL, BROTLI_QUALITY,
  EXTRACT_CONCURRENCY, IGNORE_DIRS, mapConcurrent, zlibMod, cryptoMod, loadFg, readPackage,
} from './core.js';

export function dkFileFor(name) { return path.join(DK_HOME, 'apps', `${name}.dk`); }
export function cacheDirFor(name) { return path.join(DK_HOME, 'cache', name); }
export function cacheStamp(cacheDir) { return path.join(cacheDir, '.dk-stamp'); }

export function listApps() {
  const files = fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.dk')).sort();
  return files.map((f, i) => ({ index: i + 1, file: path.join(APPS_DIR, f), name: f.slice(0, -3) }));
}
export function resolveAppRef(target) {
  if (!/^\d{1,3}$/.test(String(target))) return String(target);
  const apps = listApps();
  const app = apps[parseInt(target, 10) - 1];
  return app ? app.name : null;
}

export function isBinary(buf) { return buf.subarray(0, 4096).includes(0); }

function zlibAsync(z, fn, buf, opts) {
  return new Promise((resolve, reject) => fn(buf, opts, (err, out) => (err ? reject(err) : resolve(out))));
}
async function compressChunk(buf) {
  const z = await zlibMod();
  if (!isBinary(buf) && buf.length >= 8) {
    const b = await zlibAsync(z, z.brotliCompress, buf, { params: { [z.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [z.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
    if (b.length < buf.length * 0.9) return { comp: 'brotli', buf: b };
  }
  const d = await zlibAsync(z, z.deflate, buf, { level: ZLIB_LEVEL });
  if (d.length < buf.length * 0.98) return { comp: 'zlib', buf: d };
  return { comp: 'raw', buf };
}
async function decompressChunk(chunk, buf) {
  const z = await zlibMod();
  if (chunk.comp === 'brotli') return zlibAsync(z, z.brotliDecompress, buf, {});
  if (chunk.comp === 'zlib') return zlibAsync(z, z.inflate, buf, {});
  return buf;
}

export function projectMeta(dir) {
  const pkg = readPackage(dir) || {};
  const deps = [];
  for (const [n, v] of Object.entries({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) deps.push({ n, v });
  let repository = '';
  if (typeof pkg.repository === 'string') repository = pkg.repository;
  else if (pkg.repository && typeof pkg.repository === 'object' && pkg.repository.url) repository = pkg.repository.url;
  const scripts = pkg.scripts && typeof pkg.scripts === 'object'
    ? Object.keys(pkg.scripts)
        .filter(k => ['start', 'dev', 'build', 'test', 'serve', 'server', 'preview', 'lint', 'typecheck'].includes(k))
        .map(k => `${k}: ${String(pkg.scripts[k]).trim()}`)
    : [];
  let readme = '';
  for (const f of ['README.md', 'README', 'Readme.md', 'readme.md', 'Readme']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      try { readme = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n').trim().slice(0, 4000); } catch { /* ignore */ }
      break;
    }
  }
  return {
    description: pkg.description || '',
    license: pkg.license || '',
    author: typeof pkg.author === 'object' ? (pkg.author.name || '') : (pkg.author || ''),
    icon: (pkg.devkit && pkg.devkit.icon) || pkg.icon || '',
    homepage: pkg.homepage || '',
    repository,
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords.slice(0, 20) : [],
    engines: pkg.engines && typeof pkg.engines === 'object' ? pkg.engines : {},
    scripts,
    main: typeof pkg.main === 'string' ? pkg.main : '',
    deps: deps.slice(0, 50),
    readme,
  };
}

export function loadDkIgnore(sourcePath) {
  const f = path.join(sourcePath, '.dkignore');
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (let line of fs.readFileSync(f, 'utf-8').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    line = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!line) continue;
    out.push({ negate, line });
  }
  return out;
}

function ignoreGlobs(line) {
  const globs = [];
  if (!line.includes('/')) globs.push(`**/${line}`);
  globs.push(line);
  globs.push(`${line}/**`);
  return globs;
}

function matchIgnores(fg, sourcePath, patterns) {
  const ignored = new Set();
  const apply = (negate) => {
    for (const p of patterns) {
      if (p.negate !== negate) continue;
      for (const g of ignoreGlobs(p.line)) {
        for (const f of fg.sync(g, { cwd: sourcePath, dot: true, onlyFiles: true, suppressErrors: true })) {
          if (negate) ignored.delete(f);
          else ignored.add(f);
        }
      }
    }
  };
  apply(false);
  apply(true);
  return ignored;
}

export function detectCommands(dir) {
  const pkg = readPackage(dir);
  const out = { run: null, build: null, version: '0.0.0', packageManager: 'npm', needDeps: false };
  if (pkg) {
    out.version = pkg.version || '0.0.0';
    out.needDeps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length > 0;
    if (pkg.bin) {
      const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
      out.run = { cmd: 'node', args: [path.join(dir, bin)] };
    } else if (pkg.scripts && pkg.scripts.start) {
      const m = pkg.scripts.start.trim().match(/^node\s+(.+)$/);
      if (m) out.run = { cmd: 'node', args: m[1].split(/\s+/) };
      else out.run = { cmd: 'npm', args: ['run', 'start'] };
    } else if (pkg.scripts && pkg.scripts.dev) {
      const m = pkg.scripts.dev.trim().match(/^node\s+(.+)$/);
      if (m) out.run = { cmd: 'node', args: m[1].split(/\s+/) };
      else out.run = { cmd: 'npm', args: ['run', 'dev'] };
    }
    if (pkg.scripts && pkg.scripts.build) out.build = { cmd: 'npm', args: ['run', 'build'] };
  }
  for (const entry of ['index.js', 'main.js', 'app.js', 'server.js']) {
    if (!out.run && fs.existsSync(path.join(dir, entry))) out.run = { cmd: 'node', args: [entry] };
  }
  return out;
}

export function shellString(run) {
  if (!run) return null;
  return run.cmd + ' ' + run.args.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ');
}

export function sourceInfo(source) {
  if (/^(https?:\/\/|git@|git:\/\/)/.test(source)) {
    return { type: 'git', url: source, defaultName: source.replace(/\.git$/, '').split(/[\/:]/).pop() };
  }
  if (fs.existsSync(source)) return { type: 'local', path: path.resolve(source), defaultName: path.basename(path.resolve(source)) };
  return null;
}

export async function packProject(sourcePath, meta, keepDirs = [], excludeRel = []) {
  const fg = await loadFg();
  const ignores = ['**/*.dk'];
  for (const d of IGNORE_DIRS) {
    if (keepDirs.includes(d)) continue;
    ignores.push(`${d}/**`);
  }
  let files = fg.sync(['**/*'], { cwd: sourcePath, dot: true, onlyFiles: true, ignore: ignores, suppressErrors: true });
  if (excludeRel && excludeRel.length) files = files.filter(f => !excludeRel.includes(f));
  const dkIgnore = loadDkIgnore(sourcePath);
  if (dkIgnore.length) {
    const ignored = matchIgnores(fg, sourcePath, dkIgnore);
    if (ignored.size) files = files.filter(f => !ignored.has(f));
  }
  const cr = await cryptoMod();
  const readItems = await mapConcurrent(files, 8, async (rel) => {
    let buf;
    let stat;
    try { [buf, stat] = await Promise.all([fs.promises.readFile(path.join(sourcePath, rel)), fs.promises.stat(path.join(sourcePath, rel))]); } catch { return null; }
    const h = cr.createHash('sha256').update(buf).digest('hex');
    return { rel, buf, u: buf.length, h, m: stat.mode & 0o777, t: Math.floor(stat.mtimeMs / 1000) };
  });
  const uniqMap = new Map();
  const uniqItems = [];
  let loc = 0;
  for (const it of readItems) {
    if (!it) continue;
    if (!isBinary(it.buf)) loc += it.buf.toString('utf-8').split('\n').length;
    if (!uniqMap.has(it.h)) { uniqMap.set(it.h, uniqItems.length); uniqItems.push(it); }
    else it.buf = null;
  }
  const compressed = await mapConcurrent(uniqItems, 4, async (it) => {
    const { comp, buf: cb } = await compressChunk(it.buf);
    it.buf = null;
    return { comp, cb, u: it.u };
  });
  const chunkIndex = new Map();
  const chunks = [];
  const chunkBufs = [];
  const entries = [];
  let offset = 0;
  let usize = 0;
  for (const it of readItems) {
    if (!it) continue;
    usize += it.u;
    let chunk = chunkIndex.get(it.h);
    if (chunk === undefined) {
      const c = compressed[uniqMap.get(it.h)];
      chunk = chunks.length;
      chunks.push({ comp: c.comp, o: offset, c: c.cb.length, u: c.u });
      chunkBufs.push(c.cb);
      offset += c.cb.length;
      chunkIndex.set(it.h, chunk);
    }
    entries.push({ p: it.rel, chunk, u: it.u, h: it.h, m: it.m, t: it.t });
  }
  const payload = Buffer.concat(chunkBufs);
  const m = projectMeta(sourcePath);
  const header = {
    magic: 'DKPK', version: DK_VERSION, formatVersion: DK_VERSION, format: 'devkit-package',
    name: meta.name, type: meta.type, source: meta.source,
    version: meta.version || '0.0.0',
    description: m.description, license: m.license, author: m.author,
    icon: m.icon, readme: m.readme, loc,
    homepage: m.homepage, repository: m.repository, keywords: m.keywords,
    engines: m.engines, scripts: m.scripts, main: m.main,
    deps: m.deps,
    fileCount: entries.length, chunkCount: chunks.length, usize, csize: payload.length,
    payloadHash: cr.createHash('sha256').update(payload).digest('hex'),
    builder: { name: 'devkit', node: process.version, platform: `${os.platform()}-${os.arch()}` },
    createdAt: new Date().toISOString(),
    frontend: meta.frontend || null,
    backend: meta.backend ? { run: shellString(meta.backend), entry: meta.backend.entry || null } : null,
    chunks, files: entries,
  };
  const headerJson = Buffer.from(JSON.stringify(header), 'utf-8');
  const out = Buffer.alloc(9 + headerJson.length + payload.length);
  DK_MAGIC.copy(out, 0);
  out[4] = DK_VERSION;
  out.writeUInt32LE(headerJson.length, 5);
  headerJson.copy(out, 9);
  payload.copy(out, 9 + headerJson.length);
  return { buffer: out, header };
}

export function readHeader(dkFile) {
  const fd = fs.openSync(dkFile, 'r');
  try {
    const probe = Buffer.alloc(65536);
    const got = fs.readSync(fd, probe, 0, probe.length, 0);
    const base = probe.subarray(0, got).indexOf(DK_MAGIC);
    if (base < 0) throw new Error('Fichier .dk invalide (magic inattendu)');
    const head = Buffer.alloc(9);
    fs.readSync(fd, head, 0, 9, base);
    const ver = head[4];
    if (!SUPPORTED_VERSIONS.has(ver)) throw new Error(`Version .dk non supportée: ${ver}`);
    const hlen = head.readUInt32LE(5);
    const hbuf = Buffer.alloc(hlen);
    fs.readSync(fd, hbuf, 0, hlen, base + 9);
    const header = JSON.parse(hbuf.toString('utf-8'));
    header._payloadStart = base + 9 + hlen;
    header._legacy = ver === 1;
    return header;
  } finally { fs.closeSync(fd); }
}

async function readPayloadChunk(dkFile, header, chunk) {
  const fd = fs.openSync(dkFile, 'r');
  try {
    const buf = Buffer.alloc(chunk.c);
    fs.readSync(fd, buf, 0, chunk.c, header._payloadStart + chunk.o);
    return await decompressChunk(chunk, buf);
  } finally { fs.closeSync(fd); }
}

export async function loadAllChunks(dkFile, header) {
  if (header._legacy) {
    const raws = [];
    for (const e of header.files) raws.push(await readPayloadChunk(dkFile, header, { comp: 'zlib', o: e.o, c: e.c }));
    return raws;
  }
  const raws = new Array(header.chunks.length);
  await mapConcurrent(header.chunks.map((ch, i) => ({ ch, i })), EXTRACT_CONCURRENCY, async ({ ch, i }) => {
    raws[i] = await readPayloadChunk(dkFile, header, ch);
  });
  return raws;
}

export async function readFileContent(dkFile, header, entry) {
  const chunk = header._legacy ? { comp: 'zlib', o: entry.o, c: entry.c } : header.chunks[entry.chunk];
  return readPayloadChunk(dkFile, header, chunk);
}

async function writeEntry(dest, e, raw) {
  const to = path.join(dest, e.p);
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.writeFile(to, raw);
  if (typeof e.m === 'number') {
    await fs.promises.chmod(to, e.m).catch(() => {});
    if (typeof e.t === 'number') await fs.promises.utimes(to, e.t, e.t).catch(() => {});
  }
}

export async function extractAll(dkFile, header, dest) {
  if (header._legacy) {
    await mapConcurrent(header.files, EXTRACT_CONCURRENCY, async (e) => {
      const raw = await readPayloadChunk(dkFile, header, { comp: 'zlib', o: e.o, c: e.c });
      await writeEntry(dest, e, raw);
    });
    return;
  }
  const raws = await loadAllChunks(dkFile, header);
  await mapConcurrent(header.files, EXTRACT_CONCURRENCY, async (e) => {
    await writeEntry(dest, e, raws[e.chunk]);
  });
}

export async function ensureExtracted(dkFile, header, spinner) {
  const cache = cacheDirFor(header.name);
  const stamp = cacheStamp(cache);
  let upToDate = false;
  if (fs.existsSync(stamp)) {
    const raw = fs.readFileSync(stamp, 'utf-8').trim();
    let s = null;
    try { s = JSON.parse(raw); } catch { /* format legacy */ }
    if (s && typeof s === 'object') {
      upToDate = s.hash === header.payloadHash && s.files === header.fileCount;
    } else {
      upToDate = /^[0-9a-f]{64}$/i.test(raw) && raw === header.payloadHash;
    }
  }
  if (!upToDate) {
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(cache, { recursive: true });
    spinner && spinner.set('Extraction...');
    await extractAll(dkFile, header, cache);
    fs.writeFileSync(stamp, JSON.stringify({ hash: header.payloadHash, files: header.fileCount, name: header.name, at: Date.now() }));
  }
  const cmds = detectCommands(cache);
  const manifestJson = JSON.stringify({
    version: cmds.version, needDeps: cmds.needDeps,
    run: cmds.run ? shellString(cmds.run) : null,
    build: cmds.build ? shellString(cmds.build) : null,
  });
  const mPath = path.join(cache, '.dk-manifest');
  try { if (fs.readFileSync(mPath, 'utf-8') !== manifestJson) fs.writeFileSync(mPath, manifestJson); }
  catch { fs.writeFileSync(mPath, manifestJson); }
  return cache;
}

export function loadManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, '.dk-manifest'), 'utf-8'));
    if (m.run) return m;
  } catch { /* ignore */ }
  const cmds = detectCommands(dir);
  return { version: cmds.version, needDeps: cmds.needDeps, run: cmds.run ? shellString(cmds.run) : null };
}

export async function verifyDk(dkFile, header) {
  const fd = fs.openSync(dkFile, 'r');
  try {
    const payload = Buffer.alloc(header.csize);
    fs.readSync(fd, payload, 0, header.csize, header._payloadStart);
    const cr = await cryptoMod();
    return cr.createHash('sha256').update(payload).digest('hex') === header.payloadHash;
  } finally { fs.closeSync(fd); }
}

const SELFEXEC_STUB = `const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { spawn } = require('child_process');
const http = require('http');

const self = process.argv[2];
const buf = fs.readFileSync(self);
let magic = -1;
let at = 0;
while (at >= 0) {
  at = buf.indexOf(Buffer.from('DKPK'), at);
  if (at < 0) break;
  const ver = buf[at + 4];
  if (ver === 1 || ver === 2) {
    const hlen = buf.readUInt32LE(at + 5);
    if (hlen > 0 && hlen < 10485760) {
      try {
        const h = JSON.parse(buf.toString('utf8', at + 9, at + 9 + hlen));
        if (h && h.name) { magic = at; break; }
      } catch (e) {}
    }
  }
  at += 4;
}
if (magic < 0) { console.error('devkit: fichier .dk invalide (magic introuvable)'); process.exit(1); }
const hlen = buf.readUInt32LE(magic + 5);
const header = JSON.parse(buf.toString('utf8', magic + 9, magic + 9 + hlen));
const base = magic + 9 + hlen;

function inflate(ch, cb) {
  return new Promise(function (res, rej) {
    if (ch.comp === 'brotli') return zlib.brotliDecompress(cb, function (e, o) { return e ? rej(e) : res(o); });
    if (ch.comp === 'zlib') return zlib.inflate(cb, function (e, o) { return e ? rej(e) : res(o); });
    return res(cb);
  });
}

function mime(fp) {
  const m = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm' };
  return m[path.extname(fp).toLowerCase()] || 'application/octet-stream';
}

(async function () {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-run-'));
  const raws = [];
  if (header.chunks) {
    for (let i = 0; i < header.chunks.length; i++) {
      const ch = header.chunks[i];
      raws[i] = await inflate(ch, buf.subarray(base + ch.o, base + ch.o + ch.c));
    }
  }
  for (let i = 0; i < header.files.length; i++) {
    const e = header.files[i];
    const to = path.join(dest, e.p);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const raw = header.chunks ? raws[e.chunk] : zlib.inflateSync(buf.subarray(base + e.o, base + e.o + e.c));
    fs.writeFileSync(to, raw);
    if (typeof e.m === 'number') {
      try { fs.chmodSync(to, e.m); } catch (e2) {}
      if (typeof e.t === 'number') { try { fs.utimesSync(to, e.t, e.t); } catch (e3) {} }
    }
  }
  let cmd = null; let args = [];
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')); } catch (e4) {
    try { pkg = JSON.parse(fs.readFileSync(path.join(dest, 'devkit.json'), 'utf8')); } catch (e5) {}
  }
  if (pkg && pkg.run && pkg.run.cmd) {
    cmd = pkg.run.cmd; args = (pkg.run.args || []).map(String);
  } else if (pkg && pkg.bin) {
    const b = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
    cmd = 'node'; args = [path.join(dest, b)];
  } else if (pkg && pkg.scripts && (pkg.scripts.start || pkg.scripts.dev)) {
    const sc = String(pkg.scripts.start || pkg.scripts.dev).trim().match(/^node\\s+(.+)$/);
    if (sc) { cmd = 'node'; args = sc[1].split(/\\s+/); }
    else { cmd = 'npm'; args = ['run', pkg.scripts.start ? 'start' : 'dev']; }
  }
  if (!cmd) {
    for (const f of ['index.js', 'main.js', 'app.js', 'server.js']) {
      if (fs.existsSync(path.join(dest, f))) { cmd = 'node'; args = [f]; break; }
    }
  }
  function run(c, a) {
    const child = spawn(c, a, { cwd: dest, stdio: 'inherit' });
    child.on('close', function (code) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e5) {}
      process.exit(typeof code === 'number' ? code : 1);
    });
  }
  if (pkg && cmd) {
    const deps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
    if (deps > 0 && !fs.existsSync(path.join(dest, 'node_modules'))) {
      console.error('devkit: ce package a besoin de dependances non inclues.');
      console.error("devkit: empaquetez avec 'devkit pack --bundle' pour un fichier 100% autonome (offline).");
      process.exit(1);
    }
  }
  if (cmd) {
    console.log('\\ndevkit: extraction terminee, lancement de ' + (pkg && pkg.name ? pkg.name : "l'app") + '\\n');
    run(cmd, args);
    return;
  }
  function serve(root) {
    if (!fs.existsSync(root)) { console.error('devkit: contenu introuvable dans le package'); process.exit(1); }
    const port = Number(process.env.PORT) || 4173;
    const server = http.createServer(function (req, res) {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = path.normalize(path.join(root, p));
      if (fp !== root && !fp.startsWith(root + path.sep)) { res.writeHead(403); return res.end('403'); }
      fs.readFile(fp, function (err, data) {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'Content-Type': mime(fp) }); res.end(data);
      });
    });
    server.listen(port, function () { console.log('\\ndevkit: app servie sur http://localhost:' + port); });
  }
  if (header.frontend) { serve(path.join(dest, header.frontend)); return; }
  if (fs.existsSync(path.join(dest, 'index.html'))) { serve(dest); return; }
  console.error('devkit: aucune commande de lancement detectee dans le package');
  process.exit(1);
})().catch(function (e) { console.error('devkit: ' + (e && e.message)); process.exit(1); });
`;

export function selfExecutableWrapper() {
  return [
    '#!/bin/sh',
    '# .dk auto-exécutable — généré par devkit',
    '# Lance cette app sans devkit (node requis). Toute l\'extraction est faite à la volée.',
    'SELF="$(readlink -f "$0")"',
    'TMPD="$(mktemp -d)"',
    'trap \'rm -rf "$TMPD"\' EXIT INT TERM',
    'cat > "$TMPD/run.js" <<\'DK_EOF_8F2A\'',
    SELFEXEC_STUB.trim(),
    'DK_EOF_8F2A',
    'node "$TMPD/run.js" "$SELF"',
    'exit $?',
    '',
  ].join('\n');
}

export function pkgStubSource() {
  return SELFEXEC_STUB.replace('process.argv[2]', 'process.execPath');
}
