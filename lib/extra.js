import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { humanSize, readPackage, ttyCols } from './core.js';

function globToRegex(glob) {
  const pattern = String(glob).split('**').map((part, i) => {
    part = part.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.');
    return i ? '(?:.*)' + part : part;
  }).join('');
  return new RegExp('^' + pattern + '$', 'i');
}

function parseSize(str) {
  if (str == null) return null;
  const m = String(str).trim().match(/^([<>]=?)?\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!m) return null;
  const op = m[1] || '=';
  const mult = { b: 1, kb: 1024, mb: 1048576, gb: 1073741824 }[(m[3] || 'b').toLowerCase()];
  return { op, bytes: parseFloat(m[2]) * mult };
}

function shq(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

function watchTree(root, { ignore, ignoreRe, onChange }) {
  const watchers = [];
  const visit = (dir) => {
    if (watchers.some(w => w.dir === dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (ignore(e.name)) continue;
      if (e.isDirectory() && !e.isSymbolicLink()) visit(path.join(dir, e.name));
    }
    let w;
    try {
      w = fs.watch(dir, (ev, fname) => {
        if (!fname) return;
        const name = String(fname);
        if (ignore(name)) return;
        onChange(path.join(dir, name), ev);
      });
    } catch { return; }
    w.dir = dir;
    w.on('error', () => {});
    watchers.push(w);
  };
  visit(root);
  return {
    add(dir) { if (!watchers.some(w => w.dir === dir)) visit(dir); },
    close() { for (const w of watchers) { try { w.close(); } catch { /* ignore */ } } },
  };
}

function runCmd(cmdStr, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmdStr, { cwd, stdio: 'inherit', shell: true });
    p.on('error', () => resolve(1));
    p.on('close', (code) => resolve(typeof code === 'number' ? code : 1));
  });
}

export function registerExtra(program, ctx) {
  const { c, chalk, box, createSpinner, hint } = ctx;

  // ========== COMMANDE : FIND ==========
  program
   .command('find')
   .description('Rechercher fichiers/dossiers par nom, type ou taille')
   .argument('[dir]', 'dossier de départ (défaut: dossier courant)', '.')
   .option('-n, --name <glob>', 'motif de nom (ex: *.js, *test*, src/**)')
   .option('-t, --type <type>', 'type: file|dir|<extension> (ex: js, json)')
   .option('-s, --size <size>', 'taille (ex: >1MB, <10KB, =512B)')
   .option('-d, --depth <n>', 'profondeur max (défaut: 5)', '5')
   .option('-a, --all', 'inclure les fichiers/dossiers cachés')
   .option('-i, --ignore <dirs>', 'dossiers à ignorer, séparés par des virgules (défaut: node_modules,.git)', 'node_modules,.git,dist,build')
   .option('-c, --count', 'afficher seulement le nombre de résultats')
   .action((dir, options) => {
      const root = path.resolve(dir);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return console.log(c.error(`\n  ✗ Dossier introuvable: ${c.dim(dir)}\n`));
      const ignoreNames = String(options.ignore).split(',').map(s => s.trim()).filter(Boolean);
      const ignoreRe = ignoreNames.filter(p => /[?*]/.test(p)).map(globToRegex);
      const ignore = (name) => {
        if (ignoreNames.includes(name)) return true;
        return ignoreRe.some(re => re.test(name));
      };
      const nameRe = options.name ? globToRegex(options.name) : null;
      const typeArg = options.type ? String(options.type).toLowerCase() : null;
      const sizeQ = parseSize(options.size);
      const maxDepth = Math.max(1, parseInt(options.depth, 10) || 5);
      const out = [];
      let total = 0;
      const walk = (cur, rel, d) => {
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          if (!options.all && e.name.startsWith('.')) continue;
          if (ignore(e.name)) continue;
          const full = path.join(cur, e.name);
          const r = rel ? rel + '/' + e.name : e.name;
          const isDir = e.isDirectory();
          if (typeArg) {
            if (typeArg === 'dir' && !isDir) continue;
            if (typeArg === 'file' && isDir) continue;
            if (typeArg !== 'dir' && typeArg !== 'file') {
              const ext = path.extname(e.name).replace(/^\./, '').toLowerCase();
              if (ext !== typeArg.replace(/^\./, '')) continue;
            }
          }
          if (nameRe && !nameRe.test(e.name) && !nameRe.test(r)) continue;
          let sz = null;
          if (!isDir) { try { sz = fs.statSync(full).size; } catch { sz = 0; } }
          if (sizeQ && !isDir) {
            const ok = sizeQ.op.startsWith('>') ? sz > sizeQ.bytes : sizeQ.op.startsWith('<') ? sz < sizeQ.bytes : Math.abs(sz - sizeQ.bytes) < 1;
            if (!ok) continue;
          }
          total++;
          if (!options.count) {
            const vis = isDir ? c.info(e.name) + '/' : chalk.white(e.name);
            out.push(`  ${c.accent('▸').padEnd(0)} ${vis}${sz != null ? ' ' + c.dim(humanSize(sz)) : ''}`);
          }
          if (isDir && !e.isSymbolicLink() && d < maxDepth) walk(full, r, d + 1);
        }
      };
      const spinner = createSpinner('Recherche en cours...');
      walk(root, '', 1);
      spinner.stop(`✅ ${total} résultat(s)`);
      const shown = out.slice(0, 200);
      if (options.count) {
        return console.log(c.success(`\n  🔢 ${chalk.white(total)} résultat(s) dans ${c.accent(root)}\n`));
      }
      if (shown.length === 0) return console.log(c.warn(`\n  📭 Aucun résultat pour ces critères dans ${c.dim(root)}\n`));
      if (out.length > shown.length) shown.push(`  ${c.dim('… et ' + (out.length - shown.length) + ' autre(s)')}`);
      shown.push(`  ${c.dim('—')} ${chalk.white(total)} résultat(s) · profondeur max ${c.info(String(maxDepth))}`);
      console.log('\n' + box('🔎 Recherche', shown, { color: chalk.cyan, rounded: true }) + '\n');
      hint(`Affiner: ${c.accent('devkit find ' + dir + ' --help')}`);
    });

  // ========== COMMANDE : WATCH ==========
  program
   .command('watch')
   .description('Surveiller un dossier et relancer une commande à chaque changement')
   .argument('[dir]', 'dossier (défaut: dossier courant)', '.')
   .argument('[cmd...]', 'commande à exécuter (défaut: script dev/start du package.json)')
   .option('--debounce <ms>', 'délai avant exécution (défaut: 300)', '300')
   .option('-i, --ignore <globs>', 'dossier/glob à ignorer, séparés par des virgules (défaut: node_modules,.git)', 'node_modules,.git')
   .option('--once', 'exécuter une seule fois puis quitter')
   .option('--no-clear', 'ne pas effacer l\'écran entre les exécutions')
   .action(async (dir, cmd, options) => {
      const root = path.resolve(dir);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return console.log(c.error(`\n  ✗ Dossier introuvable: ${c.dim(dir)}\n`));
      const pkg = readPackage(root);
      const scripts = (pkg && pkg.scripts) || {};
      let cmdStr = null;
      if (cmd && cmd.length) cmdStr = cmd.join(' ');
      else if (scripts.dev) cmdStr = 'npm run dev';
      else if (scripts.start) cmdStr = 'npm run start';
      else if (fs.existsSync(path.join(root, 'index.js'))) cmdStr = 'node index.js';
      if (!cmdStr) return console.log(c.error(`\n  ✗ Aucune commande: ${c.accent('devkit watch <dossier> "<commande>"')}\n`));
      const debounce = Math.max(30, parseInt(options.debounce, 10) || 300);
      const ignoreNames = String(options.ignore).split(',').map(s => s.trim()).filter(Boolean);
      const ignoreRe = ignoreNames.filter(p => /[?*]/.test(p)).map(globToRegex);
      const ignore = (name) => {
        if (ignoreNames.includes(name)) return true;
        return ignoreRe.some(re => re.test(name));
      };
      let running = false;
      let pending = false;
      let timer = null;
      const run = async () => {
        pending = false;
        if (running) return;
        running = true;
        if (options.clear) process.stdout.write('\x1b[2J\x1b[H');
        console.log(`\n  ${c.info('⚙️  ' + new Date().toLocaleTimeString())} ─ Exécution: ${c.accent(cmdStr)}\n`);
        const t0 = Date.now();
        const code = await runCmd(cmdStr, root);
        const el = ((Date.now() - t0) / 1000).toFixed(2);
        console.log('');
        console.log(code === 0
          ? `  ${c.success('✓ Terminé')} ${c.dim('(' + el + 's)')} ${c.dim('— en attente de changements... (Ctrl+C pour arrêter)')}`
          : `  ${c.error('✗ Échec')} ${c.dim('(code ' + code + ', ' + el + 's)')} ${c.dim('— en attente de changements...')}`);
        running = false;
        if (pending) setTimeout(run, 100);
      };
      const watcher = watchTree(root, {
        ignore,
        ignoreRe,
        onChange: (full) => {
          let isDir = false;
          try { isDir = fs.statSync(full).isDirectory(); } catch { /* ignore */ }
          if (isDir) watcher.add(full);
          else {
            if (options.once) { console.log(`\n  ${c.info('👁️  ' + new Date().toLocaleTimeString())} ${c.warn('→')} ${chalk.white(path.relative(root, full))}`); }
            pending = true;
            clearTimeout(timer);
            timer = setTimeout(run, debounce);
          }
        },
      });
      console.log('\n' + box('👁️  Watch', [
        `  📂 ${c.dim(root)}`,
        `  ⚙️  ${c.accent(cmdStr)}`,
        `  ⏱️  debounce ${c.info(String(debounce))}ms  exclusions: ${c.dim(ignoreNames.join(', ') || '—')}`,
        `  ${c.dim('Ctrl+C pour arrêter.')}`,
      ], { color: chalk.cyan, rounded: true }) + '\n');
      if (options.once) {
        await run();
        watcher.close();
        return console.log(c.dim('\n  Mode --once : une exécution, terminé.\n'));
      }
      await run();
      process.on('SIGINT', () => { watcher.close(); process.exit(0); });
      process.on('SIGTERM', () => { watcher.close(); process.exit(0); });
    });

  // ========== COMMANDE : DOWNLOAD ==========
  program
   .command('dl')
   .alias('download')
   .description('Télécharger un fichier avec barre de progression')
   .argument('<url>', 'URL du fichier')
   .option('-o, --out <file>', 'fichier de sortie (défaut: nom dérivé de l\'URL)')
   .option('-f, --force', 'écraser si le fichier existe')
   .option('-t, --timeout <ms>', 'timeout en ms (défaut: 60000)', '60000')
   .option('--no-progress', 'désactiver la barre de progression')
   .action(async (url, options) => {
      let u;
      try { u = new URL(url); } catch { return console.log(c.error(`\n  ✗ URL invalide: ${c.dim(url)}\n`)); }
      const out = options.out || path.basename(u.pathname) || 'telechargement';
      const target = path.resolve(out);
      if (fs.existsSync(target) && !options.force) return console.log(c.error(`\n  ✗ "${out}" existe déjà. Utilise: ${c.accent('-f')}\n`));
      let res;
      const spinner = createSpinner(`Connexion à ${u.host}...`);
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(parseInt(options.timeout, 10) || 60000), redirect: 'follow' });
      } catch (e) {
        spinner.stop('❌ Échec');
        return console.log(c.error(`\n  ✗ ${e.message}\n`));
      }
      if (!res.ok || !res.body) {
        spinner.stop('❌ ' + res.status);
        return console.log(c.error(`\n  ✗ HTTP ${res.status} ${res.statusText}\n`));
      }
      const total = parseInt(res.headers.get('content-length') || '0', 10);
      spinner.stop(total ? `⬇️  ${humanSize(total)} à télécharger` : '⬇️  téléchargement');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.part';
      const ws = fs.createWriteStream(tmp);
      const reader = res.body.getReader();
      const tty = !!process.stderr.isTTY && options.progress !== false;
      const t0 = Date.now();
      const hash = createHash('sha256');
      let received = 0;
      const render = () => {
        const pct = total ? Math.floor((received / total) * 100) : 0;
        const el = (Date.now() - t0) / 1000 || 1;
        const cols = Math.max(12, Math.min(40, ttyCols() - 42));
        const fill = Math.min(cols, Math.round((pct / 100) * cols));
        const bar = '█'.repeat(fill) + '░'.repeat(Math.max(0, cols - fill));
        const sizeTxt = total ? `${humanSize(received)}/${humanSize(total)}` : humanSize(received);
        process.stderr.write(`\r\x1b[K\x1b[36m${bar}\x1b[0m \x1b[1m${pct}%\x1b[0m \x1b[2m${sizeTxt} ${humanSize(received / el)}/s\x1b[0m`);
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          ws.write(buf);
          hash.update(buf);
          received += value.length;
          if (tty) render();
        }
        await new Promise((resolve, reject) => {
          ws.end((err) => (err ? reject(err) : resolve()));
        });
        fs.renameSync(tmp, target);
      } catch (e) {
        try { ws.destroy(); } catch { /* ignore */ }
        fs.rmSync(tmp, { force: true });
        if (tty) process.stderr.write('\r\x1b[K');
        return console.log(c.error(`\n  ✗ Échec du téléchargement: ${e.message}\n`));
      }
      if (tty) process.stderr.write('\r\x1b[K');
      console.log('\n' + box('⬇️  Téléchargement terminé', [
        `  📦 ${c.accent(target)}`,
        `  💾 ${c.dim(humanSize(received))} ${c.dim('en ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')}`,
        `  🔐 ${c.dim('sha256:' + hash.digest('hex').slice(0, 16))}`,
      ], { color: chalk.green, rounded: true }) + '\n');
    });

  // ========== COMMANDE : TMUX ==========
  program
   .command('tmux')
   .description('Panneaux de dev tmux: serveur + watch + logs')
   .argument('[dir]', 'dossier (défaut: dossier courant)', '.')
   .option('-n, --name <name>', 'nom de session (défaut: nom du dossier)')
   .option('-c, --cmd <cmd>', 'commande serveur (défaut: script dev/start détecté)')
   .option('-w, --watch <cmd>', 'commande watch (défaut: script build détecté)')
   .option('-l, --logs <file>', 'suivre un fichier de logs (tail -f)')
   .option('--vertical', 'panneaux empilés verticalement')
   .action((dir, options) => {
      const root = path.resolve(dir);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return console.log(c.error(`\n  ✗ Dossier introuvable: ${c.dim(dir)}\n`));
      const check = spawnSync('tmux', ['-V'], { encoding: 'utf-8' });
      if (check.error || check.status !== 0) {
        console.log(c.error('\n  ✗ tmux est introuvable.'));
        return console.log(c.dim('  Installez-le (ex: apt install tmux / pkg install tmux) puis réessayez.\n'));
      }
      const pkg = readPackage(root);
      const scripts = (pkg && pkg.scripts) || {};
      let server = options.cmd || scripts.dev || scripts.start;
      let watch = options.watch || scripts.build;
      if (!server) {
        if (fs.existsSync(path.join(root, 'index.js'))) server = 'node index.js';
        else return console.log(c.error(`\n  ✗ Aucune commande serveur trouvée. Utilise: ${c.accent('devkit tmux -c "<commande>"')}\n`));
      }
      const session = String(options.name || path.basename(root)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'dev';
      spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
      spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', root, '-n', 'dev', server], { stdio: 'ignore' });
      if (watch) spawnSync('tmux', ['split-window', options.vertical ? '-h' : '-v', '-c', root, watch], { stdio: 'ignore' });
      if (options.logs) {
        const lp = path.resolve(options.logs);
        spawnSync('tmux', ['split-window', '-h', '-c', root, 'tail -f ' + shq(lp)], { stdio: 'ignore' });
      }
      if (options.logs && watch) {
        spawnSync('tmux', ['select-layout', options.vertical ? 'main-vertical' : 'main-horizontal'], { stdio: 'ignore' });
      } else if (watch) {
        spawnSync('tmux', ['select-layout', options.vertical ? 'main-horizontal' : 'main-vertical'], { stdio: 'ignore' });
      }
      spawnSync('tmux', ['select-pane', '-t', session + '.0'], { stdio: 'ignore' });
      const lines = [
        `  📂 ${c.dim(root)}`,
        `  🖥️  ${c.accent('serveur:')} ${chalk.white(server)}`,
      ];
      if (watch) lines.push(`  👁️  ${c.accent('watch:')}   ${chalk.white(watch)}`);
      if (options.logs) lines.push(`  📜 ${c.accent('logs:')}    ${chalk.white(path.resolve(options.logs))}`);
      lines.push(`  ${c.dim('quitter sans tuer: Ctrl+b d — tout détruire: devkit tmux ' + dir + ' puis Ctrl+c')}`);
      console.log('\n' + box('🖥️  Session tmux ' + c.accent(session), lines, { color: chalk.green, rounded: true }) + '\n');
      const att = spawnSync('tmux', ['attach', '-t', session], { stdio: 'inherit' });
      return att.status ?? 0;
    });
}