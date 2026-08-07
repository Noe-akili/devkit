import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  DK_HOME, APPS_DIR, DEPS_DIR, ttyCols, stripAnsi, truncVis, wrapAnsi, humanSize,
  loadTable, loadFg, loadExeca, ensureDirs, acquireLock, releaseLock, stateFile, cryptoMod,
} from './core.js';
import { sourceInfo, dkFileFor, readHeader, detectCommands, packProject, verifyDk, shellString, cacheDirFor } from './dk.js';
import { installDeps } from './deps.js';
import { fetchSource } from './git.js';
import { stageBuiltProject, hasBuild, looksLikeFrontend } from './build.js';
import { fastRun } from './fastrun.js';

function isBinaryFile(fullPath, stat) {
  if (!stat.size) return false;
  const fd = fs.openSync(fullPath, 'r');
  try {
    const head = Buffer.alloc(Math.min(4096, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    return head.includes(0);
  } finally { fs.closeSync(fd); }
}

export async function main() {
  const { Command } = await import('commander');
  const chalk = (await import('chalk')).default;
  const program = new Command();
  const TODO_FILE = path.join(process.cwd(), '.devkit-todo.json');

  const c = {
    success: chalk.green.bold,
    error: chalk.red.bold,
    warn: chalk.yellow.bold,
    info: chalk.cyan,
    dim: chalk.gray,
    accent: chalk.magenta.bold,
  };
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
        return chalk.hex(rgbToHex(f[0] + (t[0] - f[0]) * p, f[1] + (t[1] - f[1]) * p, f[2] + (t[2] - f[2]) * p))(ch);
      }).join('')
    ).join('\n');
  }
  function box(title, lines, opts = {}) {
    const color = opts.color || c.info;
    const r = opts.rounded ? ['╭', '╮', '╰', '╯'] : ['╔', '╗', '╚', '╝'];
    const avail = Math.max(16, ttyCols() - 4);
    const ideal = Math.max(...[title, ...lines].map(l => stripAnsi(l).length)) + 2;
    const contentW = Math.min(avail, ideal);
    const sep = '─'.repeat(contentW + 2);
    const out = [color(`${r[0]}${sep}${r[1]}`)];
    const titleVis = stripAnsi(title).length;
    if (titleVis <= contentW) {
      out.push(color('│ ') + chalk.bold(title) + color(` ${'─'.repeat(Math.max(0, contentW - titleVis - 1))}│`));
    } else {
      out.push(color('│ ') + chalk.bold(truncVis(title, contentW - 1)) + color(' │'));
    }
    out.push(color(`├${sep}┤`));
    for (const l of lines) {
      for (const seg of wrapAnsi(l, contentW)) {
        const vis = stripAnsi(seg).length;
        out.push(color('│ ') + seg + color(` ${' '.repeat(Math.max(1, contentW - vis))}│`));
      }
    }
    out.push(color(`${r[2]}${sep}${r[3]}`));
    return out.join('\n');
  }
  function createSpinner(text) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const tty = !!process.stderr.isTTY;
    const pad = ' '.repeat(Math.max(20, ttyCols() - 4));
    let timer = null;
    if (tty) {
      timer = setInterval(() => {
        process.stderr.write(`\r${chalk.cyan(frames[i++ % frames.length])} ${chalk.dim(text)}${pad}`);
      }, 70);
    }
    return {
      set(t) { text = t; },
      stop(final) {
        if (timer) clearInterval(timer);
        if (tty) process.stderr.write('\r' + pad + '\r');
        if (final) console.log(c.success(`  ${final}`));
      },
    };
  }
  function hint(msg) {
    console.log('\n  ' + c.dim('💡 ') + wrapAnsi(msg, Math.max(16, ttyCols() - 6)).join('\n    ') + '\n');
  }
  function banner() {
    const narrow = ttyCols() < 46;
    if (narrow) {
      console.log('\n' + gradientLines(['  devkit'], '#00c6ff', '#8a2cff'));
      console.log(chalk.dim('   ◆ Boîte à outils dev ◆') + '\n');
    } else {
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
  }

  program
   .name('devkit')
   .description('Boîte à outils pour développeurs')
   .version('1.0.0');

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
      ['doctor', 'Diagnostiquer la santé du système'],
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
      const fg = await loadFg();
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
        fileCount++;
        spinner.set(`Analyse: ${fileCount} fichiers...`);
        totalSize += stat.size;
        if (isBinaryFile(fullPath, stat)) continue;
        const content = fs.readFileSync(fullPath, 'utf-8');
        totalLines += content.split('\n').length;
        if (!stats[ext]) stats[ext] = { count: 0, size: 0 };
        stats[ext].count++; stats[ext].size += stat.size;
        if (content.includes('TODO') || content.includes('FIXME')) todos.push(relPath);
      }
      spinner.stop(`✅ ${fileCount} fichiers analysés`);

      const narrow = ttyCols() < 60;
      const Table = await loadTable();
      const table = new Table({
        head: [c.info('Extension'), c.info('Fichiers'), c.info('Taille')],
        style: { head: [], border: [], 'padding-left': narrow ? 0 : 1, 'padding-right': narrow ? 0 : 1 },
        wordWrap: true,
        chars: { top: '═', 'top-mid': '╤', 'top-left': '╔', 'top-right': '╗', bottom: '═', 'bottom-mid': '╧', 'bottom-left': '╚', 'bottom-right': '╝', left: '║', 'left-mid': '╟', mid: '─', 'mid-mid': '┼', right: '║', 'right-mid': '╢' },
      });
      Object.entries(stats).sort((a, b) => b[1].size - a[1].size).forEach(([ext, data]) => {
        table.push([chalk.white(ext), chalk.white(data.count), c.success(`${(data.size / 1024 / 1024).toFixed(2)} MB`)]);
      });
      console.log('\n' + table.toString() + '\n');

      const bar = '█'.repeat(10);
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
      const execa = await loadExeca();
      await execa('npm', ['create', 'vite@latest', name, '--', '--template', template], { stdio: 'inherit' });
      spinner.stop();
      const projectPath = path.join(process.cwd(), name);
      await installDeps(projectPath, [], { local: true });

      if (options.router) {
        await installDeps(projectPath, ['vue-router@4'], { local: true });
        fs.mkdirSync(path.join(projectPath, 'src/router'), { recursive: true });
        fs.writeFileSync(path.join(projectPath, 'src/router/index.js'), `import { createRouter, createWebHistory } from 'vue-router'\nexport default createRouter({ history: createWebHistory(), routes: [] })`);
      }
      if (options.pinia) await installDeps(projectPath, ['pinia'], { local: true });
      console.log(c.success(`\n  ✅ ${name} prêt !\n`));

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

  // ========== COMMANDE 4 : APPS ==========
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
      const cr = await cryptoMod();
      const tmp = path.join(DK_HOME, 'tmp', `${name}-${cr.randomBytes(4).toString('hex')}`);
      let spinner = null;
      let srcDir = null;
      let stage = null;
      let frontend = null;
      let backend = null;
      const t0 = Date.now();
      try {
        srcDir = await fetchSource(src, tmp);
        let cmds = detectCommands(srcDir);
        stage = srcDir;
        frontend = null;
        backend = null;
        if (hasBuild(srcDir) && looksLikeFrontend(srcDir)) {
          spinner = createSpinner('Installation des dépendances + build (deps temporaires)...');
          const r = await stageBuiltProject(srcDir, name);
          stage = r.stage;
          frontend = r.frontend;
          backend = r.backend;
          cmds = detectCommands(stage);
          spinner.stop();
        }
        spinner = createSpinner('Compression des sources (niveau 9)...');
        const { buffer, header } = await packProject(stage, { name, type: src.type, source: src.type === 'git' ? src.url : src.path, version: cmds.version, frontend, backend }, frontend ? [frontend.split('/')[0]] : undefined);
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        const tmpOut = `${outFile}.part-${cr.randomBytes(3).toString('hex')}`;
        fs.writeFileSync(tmpOut, buffer);
        fs.renameSync(tmpOut, outFile);
        fs.rmSync(tmp, { recursive: true, force: true });
        spinner.stop(`✅ Empaqueté en ${((Date.now() - t0) / 1000).toFixed(2)}s`);

        const ratio = header.usize ? Math.round((1 - header.csize / header.usize) * 100) : 0;
        const breakdown = { brotli: 0, zlib: 0, raw: 0 };
        (header.chunks || []).forEach(ch => breakdown[ch.comp]++);
        const dedup = header.chunkCount ? header.fileCount - header.chunkCount : 0;
        const lines = [
          `  📦 ${c.accent(path.basename(outFile))} ${c.dim('v' + header.version)}`,
          `  🧩 ${chalk.white(header.fileCount)} fichiers  ${c.dim('(' + (header.usize / 1024 / 1024).toFixed(2) + ' MB → ' + (header.csize / 1024 / 1024).toFixed(2) + ' MB)')}`,
          `  🗜️  ${c.success(ratio + '%')} ${c.dim('sha256:' + header.payloadHash.slice(0, 12))}`,
          `  🧬 ${chalk.white(dedup)} fichier(s) dédupliqué(s) (${header.chunkCount} chunks)`,
          `  🧪 ${c.info('brotli:' + breakdown.brotli)} ${c.info('zlib:' + breakdown.zlib)} ${c.dim('raw:' + breakdown.raw)}`,
          `  📦 ${c.dim(header.source)}`,
        ];
        if (frontend) lines.push(`  🌐 ${c.success('front buildé: ' + frontend + '/')}${backend ? c.info(' + backend: ' + shellString(backend)) : c.dim(' → servi par devkit (serveur statique)')}`);
        else if (cmds.run) lines.push(`  ⚙️  ${c.info(cmds.run.cmd + ' ' + cmds.run.args.join(' '))}`);
        console.log(box('✅ Package .dk v2 créé', lines, { color: chalk.green, rounded: true }));
        hint(`Lancer: ${c.accent('devkit run ' + name)}   Détails: ${c.accent('devkit info ' + name)}`);
      } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        if (stage && stage !== srcDir) fs.rmSync(stage, { recursive: true, force: true });
        spinner && spinner.stop('❌ Échec');
        console.log(c.error(`\n  ✗ Erreur: ${e.message}\n`));
      } finally { releaseLock(); }
    });

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
          const type = h.type === 'git' ? c.info('git') : c.dim('local');
          const name = h.name.length > 14 ? h.name.slice(0, 13) + '…' : h.name;
          const size = `${humanSize(h.csize)}/${h.fileCount}f`;
          return `  ${num}  ${chalk.white(name.padEnd(14))} v${String(h.version).slice(0, 10)} ${type} ${size}`;
        } catch { return `  ${c.accent(String(i + 1).padStart(2, '0'))}  ${c.error('✗')} ${c.dim(f)} ${c.warn('corrompu')}`; }
      });
      console.log('\n' + box('🗜️  Apps .dk ' + c.dim(`(${dks.length})`), lines, { color: chalk.cyan, rounded: true }) + '\n');
      hint(`Installer: ${c.accent('devkit add <chemin|url-git>')}   Lancer: ${c.accent('devkit run <nom>')}   Inspecter: ${c.accent('devkit info <nom>')}`);
    });

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
      const codecs = h.chunks ? h.chunks.reduce((a, ch) => (a[ch.comp]++, a), { brotli: 0, zlib: 0, raw: 0 }) : { brotli: 0, zlib: h.fileCount, raw: 0 };
      const lines = [
        `  📛 ${c.accent(h.name)} ${c.dim('v' + h.version)}`,
        `  📦 ${c.dim(path.basename(file))}`,
        `  🧬 ${c.dim(h.source)}`,
        `  🗜️  ${c.info('.dk v' + h.formatVersion)} ${c.dim(h.format)}`,
        `  🧩 ${chalk.white(h.fileCount)} fichiers / ${chalk.white(h.chunkCount || h.fileCount)} chunks ${c.dim('(' + (h.usize / 1024 / 1024).toFixed(2) + ' MB → ' + (h.csize / 1024 / 1024).toFixed(2) + ' MB, ' + ratio + '%)')}`,
        `  🧪 ${c.info('brotli:' + codecs.brotli)} ${c.info('zlib:' + codecs.zlib)} ${c.dim('raw:' + codecs.raw)}`,
        `  🏗️  ${c.dim((h.builder ? h.builder.platform : '?') + ' · node ' + (h.builder ? h.builder.node : '?'))}`,
        `  🔒 ${ok ? c.success('✓ sha256:' + h.payloadHash) : c.error('✗ CORROMPU')}`,
        `  🕒 ${c.dim(new Date(h.createdAt).toLocaleString())}`,
      ];
      if (h.description) lines.push(`  📝 ${c.dim(h.description)}`);
      if (h.license) lines.push(`  ⚖️  ${c.dim(h.license)}`);
      if (h.deps && h.deps.length) lines.push(`  📚 ${c.dim(h.deps.length + ' paquets')}`);
      if (h.frontend) lines.push(`  🌐 ${c.success('front buildé: ' + h.frontend + '/')}${h.backend ? c.info(' + backend: ' + h.backend.run) : c.dim(' → servi par devkit (serveur statique)')}`);
      const top = h.files.slice().sort((a, b) => b.u - a.u).slice(0, 5);
      if (top.length) {
        lines.push('');
        lines.push('  ' + c.dim('Top fichiers:'));
        top.forEach(f => lines.push(`    ${c.info('▸')} ${c.dim(f.p)} ${chalk.white((f.u / 1024).toFixed(1) + ' KB')}`));
      }
      console.log('\n' + box('🔎 Inspection', lines, { color: chalk.magenta, rounded: true }) + '\n');
    });

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
          return `  ${chalk.white(h.name)} ${ok ? c.success('✓ valide (sha256:' + h.payloadHash.slice(0, 12) + ')') : c.error('✗ corrompu')}`;
        } catch { return `  ${c.dim(f)} ${c.error('✗ illisible')}`; }
      });
      console.log('\n' + box('🛡️  Vérification des packages', lines, { color: chalk.green, rounded: true }) + '\n');
    });

  // run : définition conservée pour l'aide (--help) — exécution réelle via chemin rapide
  program
   .command('run')
   .description('Extraire et lancer une app .dk')
   .argument('<name>', 'nom de l\'app')
   .argument('[args...]', 'arguments à passer à l\'app')
   .option('--no-install', 'ne pas installer les dépendances manquantes')
   .action(async (name, args) => { process.exit(await fastRun([name, ...args])); });

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
      const cr = await cryptoMod();
      const tmp = path.join(DK_HOME, 'tmp', `${name}-${cr.randomBytes(4).toString('hex')}`);
      let spinner = null;
      let srcDir = null;
      let stage = null;
      const t0 = Date.now();
      try {
        const srcInfo = old.type === 'git' ? { type: 'git', url: old.source, defaultName: name } : { type: 'local', path: old.source, defaultName: name };
        srcDir = await fetchSource(srcInfo, tmp);
        let cmds = detectCommands(srcDir);
        stage = srcDir;
        let frontend = null;
        let backend = null;
        if (hasBuild(srcDir) && looksLikeFrontend(srcDir)) {
          spinner = createSpinner('Installation + build (deps temporaires)...');
          const r = await stageBuiltProject(srcDir, name);
          stage = r.stage;
          frontend = r.frontend;
          backend = r.backend;
          cmds = detectCommands(stage);
          spinner.stop();
        }
        spinner = createSpinner('Re-compression...');
        const { buffer, header } = await packProject(stage, { name, type: old.type, source: old.source, version: cmds.version, frontend, backend }, frontend ? [frontend.split('/')[0]] : undefined);
        const tmpOut = `${file}.part-${cr.randomBytes(3).toString('hex')}`;
        fs.writeFileSync(tmpOut, buffer);
        fs.renameSync(tmpOut, file);
        fs.rmSync(tmp, { recursive: true, force: true });
        if (stage && stage !== srcDir) fs.rmSync(stage, { recursive: true, force: true });
        spinner.stop(`✅ Reconstruit en ${((Date.now() - t0) / 1000).toFixed(2)}s`);
        const kind = frontend ? ' (front buildé' + (backend ? ' + backend)' : ', servi par devkit)') : '';
        console.log(c.success(`  → ${c.accent(name)} ${c.dim('v' + header.version + kind)} (sha256:${header.payloadHash.slice(0, 12)})\n`));
      } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        if (stage && stage !== srcDir) fs.rmSync(stage, { recursive: true, force: true });
        spinner && spinner.stop('❌ Échec');
        console.log(c.error(`\n  ✗ Erreur: ${e.message}\n`));
      } finally { releaseLock(); }
    });

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
      fs.rmSync(stateFile(name), { force: true });
      console.log(c.success(`\n  🗑️  Package "${c.accent(name + '.dk')}" supprimé\n`));
    });

  // ========== COMMANDE : DOCTOR ==========
  program
   .command('doctor')
   .description('Diagnostiquer la santé de devkit et de vos apps')
   .option('-c, --clean', 'nettoyer les caches temporaires')
   .action(async (options) => {
      const checks = [];
      const ok = (name, det) => checks.push({ name, ok: true, det });
      const bad = (name, det) => checks.push({ name, ok: false, det });
      for (const tool of ['node', 'npm', 'git']) {
        const r = spawnSync(tool, ['--version'], { encoding: 'utf-8' });
        if (!r.error && r.status === 0) ok(tool, (r.stdout || r.stderr || '').trim().split('\n')[0]);
        else bad(tool, 'introuvable');
      }
      try { ensureDirs(); ok('répertoires ~/.devkit', 'créés et accessibles'); }
      catch (e) { bad('répertoires ~/.devkit', e.message); }
      const dks = fs.existsSync(APPS_DIR) ? fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.dk')) : [];
      let corrupted = 0;
      for (const f of dks) {
        try {
          const h = readHeader(path.join(APPS_DIR, f));
          if (!verifyDk(path.join(APPS_DIR, f), h)) corrupted++;
        } catch { corrupted++; }
      }
      if (dks.length === 0) ok('packages .dk', 'aucun package installé');
      else if (corrupted === 0) ok('packages .dk', `${dks.length} valide(s)`);
      else bad('packages .dk', `${corrupted}/${dks.length} corrompu(s)`);
      let cacheBytes = 0;
      const cacheRoot = path.join(DK_HOME, 'cache');
      const fg2 = await loadFg();
      const countDir = (root) => {
        if (!fs.existsSync(root)) return;
        for (const f of fg2.sync(['**/*'], { cwd: root, onlyFiles: true, suppressErrors: true })) {
          try { cacheBytes += fs.statSync(path.join(root, f)).size; } catch { /* ignore */ }
        }
      };
      countDir(cacheRoot);
      countDir(DEPS_DIR);
      ok('cache + deps devkit', cacheBytes > 0 ? humanSize(cacheBytes) : 'vide');
      try {
        const s = fs.statfsSync(DK_HOME);
        const freeMB = Math.floor((s.bavail * s.bsize) / 1048576);
        if (freeMB < 200) bad('espace disque', `${freeMB} Mo libres`);
        else ok('espace disque', `${freeMB} Mo libres`);
      } catch { bad('espace disque', 'non mesurable'); }
      if (options.clean) {
        fs.rmSync(path.join(DK_HOME, 'tmp'), { recursive: true, force: true });
        ok('nettoyage', 'caches temporaires purgés');
      }
      const lines = checks.map(ch => `  ${ch.ok ? c.success('✓') : c.error('✗')}  ${chalk.white(ch.name.padEnd(20))} ${c.dim(ch.det)}`);
      console.log('\n' + box('🩺 Doctor devkit', lines, { color: chalk.cyan, rounded: true }) + '\n');
      const nok = checks.filter(ch => !ch.ok).length;
      if (nok === 0) console.log(c.success('  ✅ Tout va bien !\n'));
      else {
        console.log(c.warn(`  ⚠️  ${nok} problème(s) détecté(s).\n`));
        hint(`Corrigez avec: ${c.accent('devkit run <app>')} (auto-réparation au lancement) ou ${c.accent('devkit doctor -c')} (nettoyage)`);
      }
    });

  program.parse();
}
