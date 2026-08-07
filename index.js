#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import fg from 'fast-glob';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execa } from 'execa';
import { createHash } from 'crypto';
import { randomBytes } from 'crypto';
import { deflateSync, inflateSync } from 'zlib';

const program = new Command();
const TODO_FILE = path.join(process.cwd(), '.devkit-todo.json');
const DK_HOME = path.join(os.homedir(), '.devkit');
const APPS_DIR = path.join(DK_HOME, 'apps');
const APPS_FILE = path.join(DK_HOME, 'apps.json');
const LOCK_FILE = path.join(DK_HOME, '.lock');

// ========== AIDE VISUELLE ==========
const c = {
  success: chalk.green.bold,
  error: chalk.red.bold,
  warn: chalk.yellow.bold,
  info: chalk.cyan,
  dim: chalk.gray,
  accent: chalk.magenta.bold,
};
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function gradientLines(lines, from, to) {
  const total = lines.join('\n').length - 1 || 1;
  const f = hexToRgb(from), t = hexToRgb(to);
  let idx = 0;
  return lines.map(line =>
    [...line].map(ch => {
      const p = idx / total;
      idx++;
      const r = f[0] + (t[0] - f[0]) * p;
      const g = f[1] + (t[1] - f[1]) * p;
      const b = f[2] + (t[2] - f[2]) * p;
      return chalk.hex(rgbToHex(r, g, b))(ch);
    }).join('')
  ).join('\n');
}

function box(title, lines, opts = {}) {
  const color = opts.color || c.info;
  const r = opts.rounded ? ['╭', '╮', '╰', '╯'] : ['╔', '╗', '╚', '╝'];
  const clean = [title, ...lines].map(l => stripAnsi(l));
  const w = Math.max(...clean.map(l => l.length)) + 2;
  const out = [];
  out.push(color(`${r[0]}${'═'.repeat(w + 2)}${r[1]}`));
  out.push(color('│ ') + chalk.bold(title) + color(` ${'─'.repeat(Math.max(0, w - stripAnsi(title).length - 1))}│`));
  out.push(color(`├${'─'.repeat(w + 2)}┤`));
  lines.forEach((l, i) => out.push(color('│ ') + l + color(` ${' '.repeat(Math.max(0, w - stripAnsi(l).length - 1))}│`)));
  out.push(color(`${r[2]}${'═'.repeat(w + 2)}${r[3]}`));
  return out.join('\n');
}

function createSpinner(text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const pad = ' '.repeat(60);
  const timer = setInterval(() => {
    process.stderr.write(`\r${chalk.cyan(frames[i++ % frames.length])} ${chalk.dim(text)}${pad}`);
  }, 70);
  return {
    set(t) { text = t; },
    stop(final) {
      clearInterval(timer);
      process.stderr.write('\r' + pad + '\r');
      if (final) console.log(c.success(`  ${final}`));
    },
  };
}

function hint(msg) { console.log('\n  ' + c.dim('💡 ') + msg + '\n'); }
function sep() { console.log(c.dim('  ─'.repeat(28))); }

function banner() {
  const art = gradientLines([
    '  ██████╗ ███████╗██╗   ██╗██╗  ██╗██╗████████╗',
    '  ██╔══██╗██╔════╝██║   ██║██║ ██╔╝██║╚══██╔══╝',
    '  ██║  ██║█████╗  ██║   ██║█████╔╝ ██║   ██║   ',
    '  ██║  ██║██╔══╝  ╚██╗ ██╔╝██╔═██╗ ██║   ██║   ',
    '  ██████╔╝███████╗ ╚████╔╝ ██║  ██╗██║   ██║   ',
    '  ╚═════╝ ╚══════╝  ╚═══╝  ╚═╝  ╚═╝╚═╝   ╚═╝   ',
  ], '#00c6ff', '#8a2cff');
  console.log('\n' + art);
  console.log(chalk.dim('      ' + '◆'.repeat(3) + '  Boîte à outils pour développeurs  ' + '◆'.repeat(3)) + '\n');
}

program
 .name('devkit')
 .description('Boîte à outils pour développeurs')
 .version('1.0.0');

// Menu d'accueil
program.action(() => {
  banner();
  const commands = [
    ['scan', 'Analyse un dossier de projet'],
    ['vue', 'Créer un projet Vue 3 + Vite'],
    ['todo', 'Gestionnaire de tâches'],
    ['add', 'Installer un projet → package .dk'],
    ['list', 'Lister les apps installées (.dk)'],
    ['run', 'Extraire et lancer une app'],
    ['info', 'Inspecter un package .dk'],
    ['verify', 'Vérifier l\'intégrité des packages'],
    ['update', 'Reconstruire un package .dk'],
    ['remove', 'Supprimer un package .dk'],
  ];
  const lines = commands.map(([name, desc], i) => {
    const num = c.accent(String(i + 1).padStart(2, '0'));
    return `  ${num}  ${chalk.white(name.padEnd(9))} ${c.dim(desc)}`;
  });
  console.log(box('📌 Commandes disponibles', lines, { color: chalk.cyan, rounded: true }));
  console.log(c.dim('  Astuce: tapez ') + c.accent('devkit <commande> --help') + c.dim(' pour plus de détails.\n'));
});

// ========== COMMANDE 1 : SCAN ==========
program
 .command('scan')
 .description('Analyse un dossier de projet')
 .argument('[path]', 'dossier à scanner', '.')
 .option('-j, --json', 'export en JSON')
 .option('-d, --depth <n>', 'profondeur max de scan (défaut: 4)', '4')
 .action(async (targetPath, options) => {
    const resolved = path.resolve(targetPath);
    const depth = parseInt(options.depth, 10) || 4;
    console.log(box('🔍 Scan du projet', [
      `  📂 ${c.dim(resolved)}`,
      `  📏 Profondeur: ${c.accent(options.depth)}`,
    ], { color: chalk.cyan, rounded: true }));
    const spinner = createSpinner('Analyse en cours...');
    const stats = {};
    let totalLines = 0;
    let totalSize = 0;
    let fileCount = 0;
    const todos = [];

    for await (const file of fg.stream(['**/*'], { cwd: targetPath, dot: true, onlyFiles: true, deep: depth, ignore: ['node_modules/**', '.git/**'] })) {
      const relPath = String(file);
      const fullPath = path.join(targetPath, relPath);
      const stat = fs.statSync(fullPath);
      const ext = path.extname(relPath) || 'sans-extension';
      const content = fs.readFileSync(fullPath, 'utf-8');

      fileCount++;
      spinner.set(`Analyse: ${fileCount} fichiers...`);
      totalSize += stat.size;
      totalLines += content.split('\n').length;
      if (!stats[ext]) stats[ext] = { count: 0, size: 0 };
      stats[ext].count++; stats[ext].size += stat.size;
      if (content.includes('TODO') || content.includes('FIXME')) todos.push(relPath);
    }
    spinner.stop(`✅ ${fileCount} fichiers analysés`);

    const table = new Table({
      head: [c.info('Extension'), c.info('Fichiers'), c.info('Taille')],
      style: { head: [], border: [], 'padding-left': 1, 'padding-right': 1 },
      chars: { top: '═', 'top-mid': '╤', 'top-left': '╔', 'top-right': '╗', bottom: '═', 'bottom-mid': '╧', 'bottom-left': '╚', 'bottom-right': '╝', left: '║', 'left-mid': '╟', mid: '─', 'mid-mid': '┼', right: '║', 'right-mid': '╢' },
    });
    Object.entries(stats).sort((a, b) => b[1].size - a[1].size).forEach(([ext, data]) => {
      table.push([chalk.white(ext), chalk.white(data.count), c.success(`${(data.size / 1024 / 1024).toFixed(2)} MB`)]);
    });
    console.log('\n' + table.toString() + '\n');

    const pct = totalSize === 0 ? 100 : 100;
    const bar = '█'.repeat(Math.max(1, Math.min(10, Math.round(pct / 10))));
    const summary = [
      `  ${c.success('📊 Fichiers')}  ${chalk.white(String(fileCount).padStart(6))}`,
      `  ${c.success('📝 Lignes')}    ${chalk.white(String(totalLines).padStart(6))}`,
      `  ${c.success('💾 Taille')}    ${chalk.white((totalSize / 1024 / 1024).toFixed(2) + ' MB')}`,
    ];
    if (todos.length > 0) summary.push(`  ${c.warn('📌 TODO/FIXME')}  ${chalk.white(String(todos.length).padStart(6))} fichier(s)`);
    summary.push(`  ${c.info('▉')} ${chalk.green(bar.padEnd(10))} ${c.dim('100%')}`);
    console.log(box('📦 Résumé', summary, { color: chalk.green, rounded: true }));

    if (options.json) {
      fs.writeFileSync('devkit-scan.json', JSON.stringify({ stats, totalLines, totalSize }, null, 2));
      hint(`Rapport exporté dans ${c.accent('devkit-scan.json')}`);
    }
    console.log(c.success('\n  ✅ Scan terminé\n'));
  });

// ========== COMMANDE 2 : VUE ==========
const vue = program.command('vue').description('Outils pour Vue.js');

vue
 .command('create')
 .description('Créer un projet Vue 3 + Vite')
 .argument('<project-name>', 'nom du projet')
 .option('--ts', 'utiliser TypeScript')
 .option('--router', 'ajouter Vue Router')
 .option('--pinia', 'ajouter Pinia')
 .action(async (name, options) => {
    console.log(box('⚡ Création du projet', [
      `  📛 Nom: ${c.accent(name)}`,
      `  🧩 TypeScript: ${options.ts ? c.success('✓') : c.dim('—')}`,
      `  🧭 Router:     ${options.router ? c.success('✓') : c.dim('—')}`,
      `  🍍 Pinia:      ${options.pinia ? c.success('✓') : c.dim('—')}`,
    ], { color: chalk.magenta, rounded: true }));
    const template = options.ts ? 'vue-ts' : 'vue';
    const spinner = createSpinner('Création du projet Vite...');
    await execa('npm', ['create', 'vite@latest', name, '--', '--template', template], { stdio: 'inherit' });
    const projectPath = path.join(process.cwd(), name);
    spinner.set('Installation des dépendances...');
    await execa('npm', ['install'], { cwd: projectPath, stdio: 'inherit' });

    if (options.router) {
      await execa('npm', ['install', 'vue-router@4'], { cwd: projectPath });
      fs.mkdirSync(path.join(projectPath, 'src/router'), { recursive: true });
      fs.writeFileSync(path.join(projectPath, 'src/router/index.js'), `import { createRouter, createWebHistory } from 'vue-router'\nexport default createRouter({ history: createWebHistory(), routes: [] })`);
    }
    if (options.pinia) await execa('npm', ['install', 'pinia'], { cwd: projectPath });
    spinner.stop(`✅ ${name} prêt !`);

    console.log(box('🚀 Pour lancer', [
      `  📦 ${c.accent(name)}`,
      `  ${c.info('cd ' + name + ' && npm run dev')}`,
    ], { color: chalk.green, rounded: true }));
  });

// ========== COMMANDE 3 : TODO ==========
const todo = program.command('todo').description('Gestionnaire de todo');

function loadTodos() {
  if (!fs.existsSync(TODO_FILE)) return [];
  return JSON.parse(fs.readFileSync(TODO_FILE, 'utf-8'));
}
function saveTodos(todos) {
  fs.writeFileSync(TODO_FILE, JSON.stringify(todos, null, 2));
}

todo
 .command('add')
 .description('Ajouter une tâche')
 .argument('<task>', 'la tâche')
 .action((task) => {
    const todos = loadTodos();
    todos.push({ id: Date.now(), task, done: false });
    saveTodos(todos);
    console.log(c.success(`\n  ✅ Ajouté: ${c.accent('"' + task + '"')}\n`));
  });

todo
 .command('list')
 .description('Lister les tâches')
 .action(() => {
    const todos = loadTodos();
    if (todos.length === 0) return console.log(c.warn('\n  📭 Aucune tâche. Ajoutez-en avec: devkit todo add <tâche>\n'));
    const lines = todos.map((t, i) => {
      const num = c.accent(String(i + 1).padStart(2, '0'));
      return `  ${t.done ? c.success('✓') : c.dim('○')}  ${num}  ${t.done ? c.dim(t.task) : chalk.white(t.task)}`;
    });
    const done = todos.filter(t => t.done).length;
    const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10));
    lines.push(`  ${c.info('▉')} ${chalk.green(bar.padEnd(10))} ${c.dim(pct + '%')}`);
    console.log('\n' + box(`📋 Mes tâches (${done}/${todos.length})`, lines, { color: chalk.cyan, rounded: true }) + '\n');
  });

todo
 .command('done')
 .description('Marquer comme fait')
 .argument('<id>', 'id de la tâche')
 .action((id) => {
    const todos = loadTodos();
    const t = todos.find(x => x.id == id);
    if (t) { t.done = true; saveTodos(todos); console.log(c.success(`\n  ✅ Fait: ${c.accent(t.task)}\n`)); }
    else console.log(c.error(`\n  ✗ Tâche #${id} introuvable\n`));
  });

// ========== COMMANDE 4 : APPS (conteneur compressé .dk) ==========
// Format .dk v1 — binaire, accès aléatoire, extraction instantanée par fichier.
//   [0..4)   magic "DKPK"
//   [4)      version = 1
//   [5..9)   headerSize uint32 LE
//   [9..9+N) header JSON (manifest + index des fichiers)
//   [9+N..)  payload : flux zlib déflatés, un par fichier (offsets dans le header)
const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', 'target', '__pycache__', '.venv', 'vendor', '.turbo', 'out'];
const DK_MAGIC = Buffer.from('DKPK');
const DK_VERSION = 1;
const COMPRESSION_LEVEL = 9;
const EXTRACT_CONCURRENCY = 16;

function ensureDirs() { fs.mkdirSync(APPS_DIR, { recursive: true }); }
function dkFileFor(name) { return path.join(APPS_DIR, `${name}.dk`); }
function cacheDirFor(name) { return path.join(DK_HOME, 'cache', name); }
function cacheStamp(cacheDir) { return path.join(cacheDir, '.dk-stamp'); }
function acquireLock() {
  ensureDirs();
  if (fs.existsSync(LOCK_FILE)) return false;
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}
function releaseLock() { fs.rmSync(LOCK_FILE, { force: true }); }

async function mapConcurrent(items, limit, fn) {
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
function readPackage(dir) {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}
function detectCommands(dir) {
  const pkg = readPackage(dir);
  const out = { run: null, build: null, version: '0.0.0', packageManager: 'npm' };
  if (pkg) {
    out.version = pkg.version || '0.0.0';
    if (pkg.bin) {
      const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
      out.run = { cmd: 'node', args: [path.join(dir, bin)] };
    } else if (pkg.scripts && pkg.scripts.start) out.run = { cmd: 'npm', args: ['run', 'start'] };
    else if (pkg.scripts && pkg.scripts.dev) out.run = { cmd: 'npm', args: ['run', 'dev'] };
    if (pkg.scripts && pkg.scripts.build) out.build = { cmd: 'npm', args: ['run', 'build'] };
  }
  for (const entry of ['index.js', 'main.js', 'app.js', 'server.js']) {
    if (!out.run && fs.existsSync(path.join(dir, entry))) out.run = { cmd: 'node', args: [entry] };
  }
  return out;
}
function sourceInfo(source) {
  if (/^(https?:\/\/|git@|git:\/\/)/.test(source)) {
    return { type: 'git', url: source, defaultName: source.replace(/\.git$/, '').split(/[\/:]/).pop() };
  }
  if (fs.existsSync(source)) return { type: 'local', path: path.resolve(source), defaultName: path.basename(path.resolve(source)) };
  return null;
}

// ---------- PACK : build d'un .dk ----------
function packProject(sourcePath, meta) {
  const files = fg.sync(['**/*'], { cwd: sourcePath, dot: true, onlyFiles: true, ignore: IGNORE_DIRS.map(d => `${d}/**`), suppressErrors: true });
  const chunks = [];
  const entries = [];
  let offset = 0;
  let usize = 0;
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(sourcePath, rel)); } catch { continue; }
    const comp = deflateSync(buf, { level: COMPRESSION_LEVEL });
    entries.push({ p: rel, o: offset, c: comp.length, u: buf.length, h: createHash('sha256').update(buf).digest('hex') });
    chunks.push(comp);
    offset += comp.length;
    usize += buf.length;
  }
  const payload = Buffer.concat(chunks);
  const header = {
    magic: 'DKPK', version: DK_VERSION, formatVersion: DK_VERSION, format: 'devkit-package',
    name: meta.name, type: meta.type, source: meta.source,
    version: meta.version || '0.0.0',
    fileCount: entries.length, usize, csize: payload.length,
    payloadHash: createHash('sha256').update(payload).digest('hex'),
    createdAt: new Date().toISOString(), files: entries,
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

// ---------- UNPACK : lecture du header / extraction ----------
function readHeader(dkFile) {
  const fd = fs.openSync(dkFile, 'r');
  try {
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    if (!magic.equals(DK_MAGIC)) throw new Error('Fichier .dk invalide (magic inattendu)');
    const ver = Buffer.alloc(1);
    fs.readSync(fd, ver, 0, 1, 4);
    if (ver[0] !== DK_VERSION) throw new Error(`Version .dk non supportée: ${ver[0]}`);
    const hlenBuf = Buffer.alloc(4);
    fs.readSync(fd, hlenBuf, 0, 4, 5);
    const hlen = hlenBuf.readUInt32LE(0);
    const hbuf = Buffer.alloc(hlen);
    fs.readSync(fd, hbuf, 0, hlen, 9);
    const header = JSON.parse(hbuf.toString('utf-8'));
    header._payloadStart = 9 + hlen;
    return header;
  } finally { fs.closeSync(fd); }
}
function extractFile(dkFile, header, entry, dest) {
  const fd = fs.openSync(dkFile, 'r');
  try {
    const buf = Buffer.alloc(entry.c);
    fs.readSync(fd, buf, 0, entry.c, header._payloadStart + entry.o);
    const raw = inflateSync(buf);
    const to = path.join(dest, entry.p);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, raw);
  } finally { fs.closeSync(fd); }
}
async function ensureExtracted(dkFile, header, spinner) {
  const dest = cacheDirFor(header.name);
  const stamp = cacheStamp(dest);
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf-8') === header.payloadHash) return dest;
  spinner && spinner.set('Extraction (cache à jour)...');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await mapConcurrent(header.files, EXTRACT_CONCURRENCY, e => extractFile(dkFile, header, e, dest));
  fs.writeFileSync(stamp, header.payloadHash);
  return dest;
}
function verifyDk(dkFile, header) {
  const fd = fs.openSync(dkFile, 'r');
  try {
    const payload = Buffer.alloc(header.csize);
    fs.readSync(fd, payload, 0, header.csize, header._payloadStart);
    return createHash('sha256').update(payload).digest('hex') === header.payloadHash;
  } finally { fs.closeSync(fd); }
}

// ---------- SOURCES ----------
async function fetchSource(src, tmp, spinner) {
  if (src.type === 'git') {
    spinner && spinner.set('Clonage du dépôt (shallow)...');
    await execa('git', ['clone', '--depth', '1', '--quiet', src.url, tmp], { stdio: 'inherit' });
    return tmp;
  }
  spinner && spinner.set('Lecture de la source locale...');
  return src.path;
}
async function installDeps(dir, spinner) {
  spinner && spinner.set('Installation des dépendances (npm install)...');
  await execa('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
}

// ---------- COMMANDE add : packer en .dk ----------
program
 .command('add')
 .description('Installer un projet → package .dk compressé')
 .argument('<source>', 'chemin local ou URL git du projet')
 .option('-n, --name <name>', 'nom de l\'app (défaut: nom du dépôt)')
 .option('-o, --out <file>', 'fichier .dk de sortie (défaut: ~/.devkit/apps/<nom>.dk)')
 .option('-f, --force', 'écraser si déjà présente')
 .action(async (source, options) => {
    const src = sourceInfo(source);
    if (!src) return console.log(c.error(`\n  ✗ Source introuvable: ${c.dim(source)}\n`));
    const name = options.name || src.defaultName;
    const outFile = options.out ? path.resolve(options.out) : dkFileFor(name);
    if (!options.force && fs.existsSync(outFile)) return console.log(c.error(`\n  ✗ "${name}.dk" existe déjà. Utilise: ${c.accent('devkit update ' + name)} ou ${c.accent('-f')}\n`));
    if (!acquireLock()) return console.log(c.error('\n  ✗ Une opération est déjà en cours. Réessayez dans un instant.\n'));
    ensureDirs();
    const tmp = path.join(DK_HOME, 'tmp', `${name}-${randomBytes(4).toString('hex')}`);
    const spinner = createSpinner('Préparation...');
    const t0 = Date.now();
    try {
      const srcDir = await fetchSource(src, tmp, spinner);
      const cmds = detectCommands(srcDir);
      spinner.set('Compression des sources (niveau 9)...');
      const { buffer, header } = packProject(srcDir, { name, type: src.type, source: src.type === 'git' ? src.url : src.path, version: cmds.version });
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      const tmpOut = `${outFile}.part-${randomBytes(3).toString('hex')}`;
      fs.writeFileSync(tmpOut, buffer);
      fs.renameSync(tmpOut, outFile);
      fs.rmSync(tmp, { recursive: true, force: true });
      spinner.stop(`✅ Empaqueté en ${((Date.now() - t0) / 1000).toFixed(2)}s`);

      const ratio = header.usize ? Math.round((1 - header.csize / header.usize) * 100) : 0;
      const lines = [
        `  📦 Fichier:  ${c.accent(path.basename(outFile))}  ${c.dim('v' + header.version)}`,
        `  🧩 Contenu:  ${chalk.white(header.fileCount)} fichiers  ${c.dim((header.usize / 1024 / 1024).toFixed(2) + ' MB → ' + (header.csize / 1024 / 1024).toFixed(2) + ' MB')}`,
        `  🗜️  Compression: ${c.success(ratio + '%')}  ${c.dim('sha256:' + header.payloadHash.slice(0, 12))}`,
        `  🧬 Source:   ${c.dim(header.source)}`,
      ];
      if (cmds.run) lines.push(`  ⚙️  Lancement: ${c.info(cmds.run.cmd + ' ' + cmds.run.args.join(' '))}`);
      console.log(box('✅ Package .dk créé', lines, { color: chalk.green, rounded: true }));
      hint(`Lancer: ${c.accent('devkit run ' + name)}   Détails: ${c.accent('devkit info ' + name)}`);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      spinner.stop('❌ Échec');
      console.log(c.error(`\n  ✗ Erreur: ${e.message}\n`));
    } finally { releaseLock(); }
  });

// ---------- COMMANDE list : scan des .dk sans extraction ----------
program
 .command('list')
 .description('Lister les apps installées (.dk)')
 .action(() => {
    ensureDirs();
    const dks = fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.dk')).sort();
    if (dks.length === 0) return console.log(c.warn('\n  📭 Aucune app .dk. Utilise: devkit add <chemin|url-git>\n'));
    const lines = dks.map((f, i) => {
      try {
        const h = readHeader(path.join(APPS_DIR, f));
        const num = c.accent(String(i + 1).padStart(2, '0'));
        const type = h.type === 'git' ? c.info('git ') : c.dim('local');
        const size = c.dim(`${(h.csize / 1024).toFixed(1)} KB`);
        return `  ${num}  ${chalk.white(h.name.padEnd(18))} ${c.dim('v' + h.version).padEnd(9)} ${type} ${size.padEnd(10)} ${chalk.white(h.fileCount)} fichiers`;
      } catch { return `  ${c.accent(String(i + 1).padStart(2, '0'))}  ${c.error('✗')} ${c.dim(f)}  ${c.warn('corrompu')}`; }
    });
    console.log('\n' + box('🗜️  Apps .dk ' + c.dim(`(${dks.length})`), lines, { color: chalk.cyan, rounded: true }) + '\n');
    hint(`Installer: ${c.accent('devkit add <chemin|url-git>')}   Lancer: ${c.accent('devkit run <nom>')}   Inspecter: ${c.accent('devkit info <nom>')}`);
  });

// ---------- COMMANDE info : inspecter un .dk ----------
program
 .command('info')
 .description('Inspecter un package .dk')
 .argument('<name>', 'nom de l\'app')
 .action((name) => {
    const file = dkFileFor(name);
    if (!fs.existsSync(file)) return console.log(c.error(`\n  ✗ App "${name}" introuvable. Utilise: ${c.accent('devkit list')}\n`));
    let h;
    try { h = readHeader(file); } catch (e) { return console.log(c.error(`\n  ✗ ${e.message}\n`)); }
    const ok = verifyDk(file, h);
    const ratio = h.usize ? Math.round((1 - h.csize / h.usize) * 100) : 0;
    const lines = [
      `  📛 App:       ${c.accent(h.name)}  ${c.dim('v' + h.version)}`,
      `  📦 Fichier:   ${c.dim(path.basename(file))}`,
      `  🧬 Source:    ${c.dim(h.source)}`,
      `  🗜️  Format:    ${c.info('.dk v' + h.formatVersion)}  ${c.dim(h.format)}`,
      `  🧩 Contenu:   ${chalk.white(h.fileCount)} fichiers  ${c.dim('(' + (h.usize / 1024 / 1024).toFixed(2) + ' MB → ' + (h.csize / 1024 / 1024).toFixed(2) + ' MB, ' + ratio + '% de compression)')}`,
      `  🔒 Intégrité: ${ok ? c.success('✓ sha256:' + h.payloadHash) : c.error('✗ CORROMPU')}`,
      `  🕒 Créé le:   ${c.dim(new Date(h.createdAt).toLocaleString())}`,
    ];
    const top = h.files.slice().sort((a, b) => b.u - a.u).slice(0, 5);
    if (top.length) {
      lines.push('');
      lines.push('  ' + c.dim('Top fichiers:'));
      top.forEach(f => lines.push(`    ${c.info('▸')} ${c.dim(f.p.padEnd(30))} ${chalk.white((f.u / 1024).toFixed(1) + ' KB')}`));
    }
    console.log('\n' + box('🔎 Inspection', lines, { color: chalk.magenta, rounded: true }) + '\n');
  });

// ---------- COMMANDE verify : contrôle d'intégrité ----------
program
 .command('verify')
 .description('Vérifier l\'intégrité de tous les packages .dk')
 .action(() => {
    ensureDirs();
    const dks = fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.dk')).sort();
    if (dks.length === 0) return console.log(c.warn('\n  📭 Aucune app .dk à vérifier\n'));
    const lines = dks.map((f) => {
      try {
        const h = readHeader(path.join(APPS_DIR, f));
        const ok = verifyDk(path.join(APPS_DIR, f), h);
        return `  ${chalk.white(h.name.padEnd(18))} ${ok ? c.success('✓ valide (sha256:' + h.payloadHash.slice(0, 12) + ')') : c.error('✗ corrompu')}`;
      } catch { return `  ${c.dim(f.padEnd(18))} ${c.error('✗ illisible')}`; }
    });
    console.log('\n' + box('🛡️  Vérification des packages', lines, { color: chalk.green, rounded: true }) + '\n');
  });

// ---------- COMMANDE run : extraction + lancement ----------
program
 .command('run')
 .description('Extraire et lancer une app .dk')
 .argument('<name>', 'nom de l\'app')
 .argument('[args...]', 'arguments à passer à l\'app')
 .option('--no-install', 'ne pas installer les dépendances manquantes')
 .action(async (name, args, options) => {
    const file = dkFileFor(name);
    if (!fs.existsSync(file)) return console.log(c.error(`\n  ✗ App "${name}" introuvable. Utilise: ${c.accent('devkit list')}\n`));
    let h;
    try { h = readHeader(file); } catch (e) { return console.log(c.error(`\n  ✗ ${e.message}\n`)); }
    const spinner = createSpinner('Préparation du runtime...');
    const dir = await ensureExtracted(file, h, spinner);
    const cmds = detectCommands(dir);
    if (cmds.run && options.install && !fs.existsSync(path.join(dir, 'node_modules'))) await installDeps(dir, spinner);
    spinner.stop();
    if (!cmds.run) return console.log(c.error(`\n  ✗ Aucune commande de lancement détectée dans ${c.dim(h.name)}\n`));
    console.log(box('🚀 Lancement', [
      `  📛 App:      ${c.accent(h.name)}  ${c.dim('v' + h.version)}`,
      `  🗜️  Package:  ${c.dim(path.basename(file))}  ${c.dim('(' + h.fileCount + ' fichiers)')}`,
      `  📂 Runtime:  ${c.dim(dir)}`,
      `  ⚙️  Commande: ${c.info(cmds.run.cmd + ' ' + [...cmds.run.args, ...args].join(' '))}`,
    ], { color: chalk.blue, rounded: true }));
    await execa(cmds.run.cmd, [...cmds.run.args, ...args], { cwd: dir, stdio: 'inherit' });
  });

// ---------- COMMANDE update : re-packer depuis la source ----------
program
 .command('update')
 .description('Reconstruire un package .dk depuis sa source')
 .argument('<name>', 'nom de l\'app')
 .action(async (name) => {
    const file = dkFileFor(name);
    if (!fs.existsSync(file)) return console.log(c.error(`\n  ✗ App "${name}" introuvable. Utilise: ${c.accent('devkit list')}\n`));
    let old;
    try { old = readHeader(file); } catch (e) { return console.log(c.error(`\n  ✗ ${e.message}\n`)); }
    if (!acquireLock()) return console.log(c.error('\n  ✗ Une opération est déjà en cours. Réessayez.\n'));
    const tmp = path.join(DK_HOME, 'tmp', `${name}-${randomBytes(4).toString('hex')}`);
    const spinner = createSpinner('Mise à jour...');
    const t0 = Date.now();
    try {
      const srcInfo = old.type === 'git' ? { type: 'git', url: old.source, defaultName: name } : { type: 'local', path: old.source, defaultName: name };
      const srcDir = await fetchSource(srcInfo, tmp, spinner);
      const cmds = detectCommands(srcDir);
      spinner.set('Re-compression...');
      const { buffer, header } = packProject(srcDir, { name, type: old.type, source: old.source, version: cmds.version });
      const tmpOut = `${file}.part-${randomBytes(3).toString('hex')}`;
      fs.writeFileSync(tmpOut, buffer);
      fs.renameSync(tmpOut, file);
      fs.rmSync(tmp, { recursive: true, force: true });
      spinner.stop(`✅ Reconstruit en ${((Date.now() - t0) / 1000).toFixed(2)}s`);
      console.log(c.success(`  → ${c.accent(name)} ${c.dim('v' + header.version)} (sha256:${header.payloadHash.slice(0, 12)})\n`));
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      spinner.stop('❌ Échec');
      console.log(c.error(`\n  ✗ Erreur: ${e.message}\n`));
    } finally { releaseLock(); }
  });

// ---------- COMMANDE remove : suppression ----------
program
 .command('remove')
 .alias('rm')
 .description('Supprimer un package .dk')
 .argument('<name>', 'nom de l\'app')
 .action((name) => {
    const file = dkFileFor(name);
    if (!fs.existsSync(file)) return console.log(c.error(`\n  ✗ App "${name}" introuvable\n`));
    fs.rmSync(file, { force: true });
    fs.rmSync(cacheDirFor(name), { recursive: true, force: true });
    console.log(c.success(`\n  🗑️  Package "${c.accent(name + '.dk')}" et son cache supprimés\n`));
  });

program.parse();
