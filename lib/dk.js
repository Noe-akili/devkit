import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  DK_HOME, DK_MAGIC, DK_VERSION, SUPPORTED_VERSIONS, ZLIB_LEVEL, BROTLI_QUALITY,
  EXTRACT_CONCURRENCY, IGNORE_DIRS, mapConcurrent, zlibMod, cryptoMod, loadFg, readPackage,
} from './core.js';

export function dkFileFor(name) { return path.join(DK_HOME, 'apps', `${name}.dk`); }
export function cacheDirFor(name) { return path.join(DK_HOME, 'cache', name); }
export function cacheStamp(cacheDir) { return path.join(cacheDir, '.dk-stamp'); }

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
  return {
    description: pkg.description || '',
    license: pkg.license || '',
    author: typeof pkg.author === 'object' ? (pkg.author.name || '') : (pkg.author || ''),
    deps: deps.slice(0, 50),
  };
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

export async function packProject(sourcePath, meta, keepDirs = []) {
  const fg = await loadFg();
  const ignores = [];
  for (const d of IGNORE_DIRS) {
    if (keepDirs.includes(d)) continue;
    ignores.push(`${d}/**`);
  }
  const files = fg.sync(['**/*'], { cwd: sourcePath, dot: true, onlyFiles: true, ignore: ignores, suppressErrors: true });
  const cr = await cryptoMod();
  const readItems = await mapConcurrent(files, 8, async (rel) => {
    let buf;
    try { buf = await fs.promises.readFile(path.join(sourcePath, rel)); } catch { return null; }
    const h = cr.createHash('sha256').update(buf).digest('hex');
    return { rel, buf, u: buf.length, h };
  });
  const uniqMap = new Map();
  const uniqItems = [];
  for (const it of readItems) {
    if (!it) continue;
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
    entries.push({ p: it.rel, chunk, u: it.u, h: it.h });
  }
  const payload = Buffer.concat(chunkBufs);
  const m = projectMeta(sourcePath);
  const header = {
    magic: 'DKPK', version: DK_VERSION, formatVersion: DK_VERSION, format: 'devkit-package',
    name: meta.name, type: meta.type, source: meta.source,
    version: meta.version || '0.0.0',
    description: m.description, license: m.license, author: m.author,
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
    const head = Buffer.alloc(9);
    fs.readSync(fd, head, 0, 9, 0);
    if (!head.subarray(0, 4).equals(DK_MAGIC)) throw new Error('Fichier .dk invalide (magic inattendu)');
    const ver = head[4];
    if (!SUPPORTED_VERSIONS.has(ver)) throw new Error(`Version .dk non supportée: ${ver}`);
    const hlen = head.readUInt32LE(5);
    const hbuf = Buffer.alloc(hlen);
    fs.readSync(fd, hbuf, 0, hlen, 9);
    const header = JSON.parse(hbuf.toString('utf-8'));
    header._payloadStart = 9 + hlen;
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

export async function extractAll(dkFile, header, dest) {
  if (header._legacy) {
    await mapConcurrent(header.files, EXTRACT_CONCURRENCY, async (e) => {
      const raw = await readPayloadChunk(dkFile, header, { comp: 'zlib', o: e.o, c: e.c });
      const to = path.join(dest, e.p);
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.writeFile(to, raw);
    });
    return;
  }
  const raws = new Array(header.chunks.length);
  await mapConcurrent(header.chunks.map((ch, i) => ({ ch, i })), EXTRACT_CONCURRENCY, async ({ ch, i }) => {
    raws[i] = await readPayloadChunk(dkFile, header, ch);
  });
  await mapConcurrent(header.files, EXTRACT_CONCURRENCY, async (e) => {
    const to = path.join(dest, e.p);
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.writeFile(to, raws[e.chunk]);
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
