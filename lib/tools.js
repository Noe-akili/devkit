import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { spawnSync } from 'child_process';
import { createInterface } from 'node:readline';
import { createHash, randomBytes, randomInt, randomUUID } from 'crypto';
import { DK_HOME, humanSize } from './core.js';
import { findPidsOnPort } from './repair.js';
import { runStaticServer, findFreePort } from './static.js';

const HASH_ALGOS = ['md5', 'sha1', 'sha256', 'sha512'];
const ARTIFACT_DIRS = ['node_modules', 'dist', 'build', '.next', '.nuxt', '.output', '.svelte-kit', 'coverage', '.cache', '.parcel-cache', 'target', '__pycache__', '.venv', 'vendor', '.turbo', 'out', 'bower_components'];
const TREE_IGNORE = ['node_modules', '.git'];

function confirmYes(msg) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(true);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, (ans) => { rl.close(); resolve(/^(y|o|oui|yes)$/i.test(ans.trim()) || ans.trim() === ''); });
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.on('data', (c) => { d += c; });
    process.stdin.on('end', () => resolve(d));
    if (process.stdin.isTTY) { process.stdin.pause(); resolve(null); }
  });
}

function lanIP() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function isIP(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /^[0-9a-f:]+$/i.test(s) && s.includes(':'); }

function probePort(n) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', (e) => resolve(e.code === 'EADDRINUSE' ? false : null));
    srv.listen(n, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
}

function dirSize(root) {  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch { /* ignore */ }
    }
  }
  return total;
}

function genPassword(length, charset) {
  const bytes = randomBytes(length + 8);
  const pool = (i, start) => charset.slice(start).split('').filter(ch => charset.includes(ch));
  const cats = [
    ['A-Z', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    ['a-z', 'abcdefghijklmnopqrstuvwxyz'],
    ['0-9', '0123456789'],
    ['sym', '!@#$%^&*-_=+?'],
  ];
  const out = [];
  for (let i = 0; i < length; i++) out.push(charset[bytes[i] % charset.length]);
  for (let c = 0; c < cats.length; c++) {
    const ok = out.some(ch => /[A-Z]/.test(ch) && c === 0 || /[a-z]/.test(ch) && c === 1 || /[0-9]/.test(ch) && c === 2 || /[^A-Za-z0-9]/.test(ch) && c === 3);
    if (!ok) {
      const p = cats[c][1].split('').filter(ch => charset.includes(ch));
      if (p.length) out[bytes[length + c] % length] = p[bytes[c] % p.length];
    }
  }
  return out.join('');
}

function parseEnv(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx < 0) continue;
    const key = t.slice(0, idx).trim();
    let val = t.slice(idx + 1).trim();
    const q = val.match(/^(['"])([\s\S]*)\1$/);
    if (q) val = q[2];
    out.push({ key, val });
  }
  return out;
}

function maskValue(v, c) {
  if (!v) return c.dim('(vide)');
  if (v.length <= 4) return '••••';
  return v.slice(0, 3) + '•••••' + c.dim('(' + v.length + ' car.)');
}

export function registerTools(program, ctx) {
  const { c, chalk, box, createSpinner, hint } = ctx;

  program
   .command('init')
   .description('Créer un nouveau projet (package.json, .gitignore, README, .editorconfig)')
   .argument('[dir]', 'dossier du projet (défaut: dossier courant)', '.')
   .option('-n, --name <name>', 'nom du projet (défaut: nom du dossier)')
   .option('-t, --type <type>', 'type de module: module|commonjs (défaut: module)', 'module')
   .option('--no-git', 'ne pas initialiser git (défaut: oui)')
   .option('-f, --force', 'écraser les fichiers existants')
   .action((dir, options) => {
      const dest = path.resolve(dir);
      fs.mkdirSync(dest, { recursive: true });
      const name = (options.name || path.basename(dest)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'mon-projet';
      const files = {
        'package.json': JSON.stringify({
          name, version: '0.0.0', description: '', private: true,
          type: options.type, main: 'index.js',
          scripts: { start: 'node index.js', test: 'echo "aucun test" && exit 0' },
        }, null, 2) + '\n',
        'index.js': options.type === 'commonjs'
          ? 'console.log("Salut depuis ' + name + ' !");\n'
          : "console.log('Salut depuis " + name + " !');\n",
        '.gitignore': ['node_modules/', 'dist/', 'build/', '*.log', '.DS_Store', '.env', '.env.*.local', 'coverage/'].join('\n') + '\n',
        'README.md': '# ' + name + '\n\nProjet créé avec **devkit init**. Démarrer :\n\n```bash\nnpm start\n```\n',
        '.editorconfig': 'root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\ninsert_final_newline = true\nindent_style = space\nindent_size = 2\n',
      };
      const existing = Object.keys(files).filter(f => fs.existsSync(path.join(dest, f)));
      if (existing.length && !options.force) {
        console.log(c.error('\n  ✗ Fichiers déjà présents: ' + existing.join(', ') + '. Utilise: ' + c.accent('-f') + ' pour écraser.\n'));
        return;
      }
      const spinner = createSpinner('Création du projet...');
      for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dest, f), content);
      if (options.git) {
        const r = spawnSync('git', ['init', '-q'], { cwd: dest, encoding: 'utf-8' });
        if (!r.error && r.status === 0) {
          fs.writeFileSync(path.join(dest, '.gitignore'), files['.gitignore']);
        } else {
          spinner.set('git indisponible, dépôt non initialisé');
        }
      }
      spinner.stop(`✅ Projet "${name}" créé`);
      console.log('\n' + box('🚀 Nouveau projet', [
        `  📂 ${c.accent(dest)}`,
        `  📦 ${chalk.white('package.json')} (${c.info(options.type)})`,
        `  🚪 ${chalk.white('index.js')}   ${chalk.white('.gitignore')}   ${chalk.white('README.md')}   ${chalk.white('.editorconfig')}`,
        `  🌿 ${options.git ? c.success('git initialisé') : c.dim('git non initialisé')}`,
      ], { color: chalk.green, rounded: true }) + '\n');
      hint(`Lancer: ${c.accent('devkit run ' + name)}   Lancer manuellement: ${c.accent('npm start')}`);
    });

  program
   .command('serve')
   .description('Servir un dossier via HTTP local (0.0.0.0)')
   .argument('[dir]', 'dossier à servir (défaut: dossier courant)', '.')
   .option('-p, --port <port>', 'port de départ (défaut: 8080)', '8080')
   .action(async (dir, options) => {
      const webroot = path.resolve(dir);
      if (!fs.existsSync(webroot) || !fs.statSync(webroot).isDirectory()) return console.log(c.error(`\n  ✗ Dossier introuvable: ${c.dim(dir)}\n`));
      const port = await findFreePort(parseInt(options.port, 10) || 8080);
      const ip = lanIP();
      const lines = [`  ${c.accent('http://localhost:' + port)}`];
      if (ip) lines.push(`  ${c.dim('réseau local:')} ${c.accent('http://' + ip + ':' + port)}`);
      lines.push(`  ${c.dim(path.basename(webroot))} → ${c.dim(webroot)}`);
      console.log('\n' + box('🌐 Serveur statique', lines, { color: chalk.cyan, rounded: true }) + '\n');
      console.log(c.dim('  Ctrl+C pour arrêter.\n'));
      const res = await runStaticServer(webroot, port);
      return res.status;
    });

  program
   .command('clean')
   .description('Nettoyer artefacts de build et caches (rapport d\'espace libéré)')
   .argument('[dir]', 'dossier du projet (défaut: dossier courant)', '.')
   .option('-a, --all', 'supprimer sans demander confirmation')
   .option('--cache', 'inclure les caches devkit et npm')
   .option('--dry', 'afficher seulement, ne rien supprimer')
   .action(async (dir, options) => {
      const root = path.resolve(dir);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return console.log(c.error(`\n  ✗ Dossier introuvable: ${c.dim(dir)}\n`));
      const spinner = createSpinner('Analyse des artefacts...');
      const found = [];
      const walk = (dir, rel, d) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (!e.isDirectory() || e.isSymbolicLink()) continue;
          const r = rel ? rel + '/' + e.name : e.name;
          const p = path.join(dir, e.name);
          if (ARTIFACT_DIRS.includes(e.name)) {
            found.push({ rel: r, full: p });
          } else if (d < 3) {
            walk(p, r, d + 1);
          }
        }
      };
      walk(root, '', 1);
      for (const f of found) f.size = dirSize(f.full);
      found.sort((a, b) => b.size - a.size);
      let devkitBytes = 0;
      const devkitTmp = path.join(DK_HOME, 'tmp');
      const devkitCache = path.join(DK_HOME, 'cache');
      if (options.cache) {
        for (const d of [devkitTmp, devkitCache]) if (fs.existsSync(d)) devkitBytes += dirSize(d);
      }
      spinner.stop();
      const lines = [];
      if (!found.length && !devkitBytes) return console.log(c.warn('\n  🧹 Rien à nettoyer — tout est propre !\n'));
      const targets = found.slice(0, 30);
      for (const f of targets) {
        const pct = f.size > 0 ? ' ' + c.dim(humanSize(f.size)) : c.dim('vide');
        lines.push(`  ${c.warn('▸')} ${chalk.white(f.rel)}${pct}`);
      }
      if (found.length > targets.length) lines.push(`  ${c.dim('… et ' + (found.length - targets.length) + ' autre(s)')}`);
      if (options.cache) lines.push(`  ${c.warn('▸')} ${chalk.white('devkit cache+tmp')} ${c.dim(humanSize(devkitBytes))}`);
      const total = found.reduce((a, f) => a + f.size, 0) + devkitBytes;
      console.log('\n' + box('🧹 Nettoyage ' + c.dim('(' + humanSize(total) + ' récupérables)'), lines, { color: chalk.yellow, rounded: true }) + '\n');
      if (options.dry) return console.log(c.dim('  Mode --dry : rien n\'a été supprimé.\n'));
      const yes = options.all || await confirmYes(`  ${c.accent('Supprimer ' + found.length + ' artefact(s) (' + humanSize(total) + ') ?')} ${c.dim('[Y/n]')} `);
      console.log('');
      if (!yes) return console.log(c.dim('  Annulé.\n'));
      let freed = 0;
      const spinner2 = createSpinner('Suppression en cours...');
      for (const f of targets) {
        fs.rmSync(f.full, { recursive: true, force: true });
        freed += f.size;
      }
      if (options.cache) {
        for (const d of [devkitTmp, devkitCache]) { fs.rmSync(d, { recursive: true, force: true }); freed += devkitBytes; }
      }
      spinner2.stop(`✅ ${humanSize(freed)} libérés`);
      console.log(c.success(`  → ${chalk.white(found.length)} artefact(s) supprimé(s)\n`));
    });

  program
   .command('tree')
   .description('Afficher l\'arborescence d\'un dossier')
   .argument('[dir]', 'dossier (défaut: dossier courant)', '.')
   .option('-d, --depth <n>', 'profondeur max (défaut: 3)', '3')
   .option('-a, --all', 'inclure les fichiers cachés')
   .option('-s, --size', 'afficher la taille des fichiers')
   .action((dir, options) => {
      const root = path.resolve(dir);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return console.log(c.error(`\n  ✗ Dossier introuvable: ${c.dim(dir)}\n`));
      const depth = Math.max(1, parseInt(options.depth, 10) || 3);
      const lines = [];
      let files = 0, dirs = 0;
      const walk = (cur, prefix, d) => {
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
        entries = entries.filter(e => {
          if (e.name.startsWith('.') && !options.all) return false;
          return !TREE_IGNORE.includes(e.name);
        }).sort((a, b) => {
          const ad = a.isDirectory() ? 0 : 1, bd = b.isDirectory() ? 0 : 1;
          return ad - bd || a.name.localeCompare(b.name);
        });
        const total = entries.length;
        entries.forEach((e, i) => {
          const last = i === total - 1;
          const branch = last ? '└── ' : '├── ';
          const isDir = e.isDirectory();
          if (isDir) {
            dirs++;
            lines.push(`  ${prefix}${branch}${c.info(e.name)}/`);
            if (d < depth) walk(path.join(cur, e.name), prefix + (last ? '    ' : '│   '), d + 1);
          } else {
            files++;
            let sz = '';
            if (options.size) {
              try { sz = ' ' + c.dim(humanSize(fs.statSync(path.join(cur, e.name)).size)); } catch { sz = ' ' + c.dim('?'); }
            }
            lines.push(`  ${prefix}${branch}${chalk.white(e.name)}${sz}`);
          }
        });
      };
      lines.push(`  ${c.accent(path.basename(root))}/`);
      walk(root, '', 1);
      lines.push('');
      lines.push(`  ${c.dim('—')} ${chalk.white(dirs)} dossiers · ${chalk.white(files)} fichiers · profondeur ${c.info(String(depth))}`);
      console.log('\n' + box('🌳 Arborescence', lines, { color: chalk.cyan, rounded: true }) + '\n');
    });

  program
   .command('port')
   .description('Trouver les processus qui occupent un port (et les tuer)')
   .argument('<port>', 'numéro de port')
   .option('-k, --kill', 'tuer les processus trouvés')
   .action(async (port, options) => {
      const n = parseInt(port, 10);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return console.log(c.error(`\n  ✗ Port invalide: ${c.dim(port)}\n`));
      const spinner = createSpinner(`Recherche des processus sur le port ${n}...`);
      const pids = await findPidsOnPort(n);
      spinner.stop();
      if (!pids.length) {
        const free = await probePort(n);
        if (free === false) {
          console.log(c.warn(`\n  ⚠️  Le port ${c.accent(n)} est occupé, mais le processus n'est pas identifiable (permissions /proc restreintes).`));
          return console.log(c.dim(`  À la main: ${c.accent('sudo lsof -iTCP:' + n + ' -sTCP:LISTEN')} puis ${c.accent('sudo kill <pid>')}\n`));
        }
        console.log(c.success(`\n  ✅ Le port ${c.accent(n)} est libre.\n`));
        return;
      }
      const lines = [];
      for (const pid of pids) {
        let comm = '';
        try { comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim(); } catch { comm = '?'; }
        let cmdline = '';
        try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim(); } catch { /* ignore */ }
        lines.push(`  ${c.warn('▸')} PID ${c.accent(String(pid))} ${chalk.white(comm)} ${c.dim(cmdline)}`);
      }
      console.log('\n' + box(`🔌 Port ${n} occupé`, lines, { color: chalk.yellow, rounded: true }) + '\n');
      if (options.kill) {
        let killed = 0;
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGTERM');
            let waited = 0;
            while (waited < 1500) { try { process.kill(pid, 0); } catch { killed++; break; } await new Promise(r => setTimeout(r, 100)); waited += 100; }
            if (waited >= 1500) { try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* ignore */ } }
          } catch { /* ignore */ }
        }
        console.log(c.success(`  🔪 ${killed} processus terminé(s)\n`));
      } else {
        hint(`Tuer: ${c.accent('devkit port ' + n + ' --kill')}`);
      }
    });

  program
   .command('rand')
   .description('Générer mots de passe, tokens, UUID, hex ou numériques')
   .option('-t, --type <type>', 'password|token|uuid|hex|num (défaut: password)', 'password')
   .option('-l, --length <n>', 'longueur (défaut: 24)', '24')
   .option('-n, --count <n>', 'nombre de valeurs (défaut: 1)', '1')
   .option('-c, --chars <chars>', 'jeu de caractères personnalisé (password)')
   .action((options) => {
      const type = String(options.type).toLowerCase();
      const len = Math.max(1, Math.min(4096, parseInt(options.length, 10) || 24));
      const count = Math.max(1, Math.min(100, parseInt(options.count, 10) || 1));
      const gen = {
        password: () => genPassword(len, options.chars || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+?'),
        token: () => randomBytes(Math.ceil(len / 1.34)).toString('base64url').slice(0, len),
        uuid: () => randomUUID(),
        hex: () => randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len),
        num: () => Array.from({ length: len }, () => randomInt(0, 10)).join(''),
      };
      if (!gen[type]) return console.log(c.error(`\n  ✗ Type inconnu: ${c.dim(type)}. Types: ${c.accent(Object.keys(gen).join(', '))}\n`));
      const out = [];
      for (let i = 0; i < count; i++) out.push(`  ${c.info('▸')} ${chalk.white(gen[type]())}`);
      console.log('\n' + box(`🔐 ${c.accent(type)} × ${count}`, out, { color: chalk.magenta, rounded: true }) + '\n');
    });

  program
   .command('hash')
   .description('Hacher un texte, un stdin ou un fichier')
   .argument('[input]', 'texte à hacher')
   .option('-f, --file <path>', 'hacher un fichier')
   .option('-a, --algo <algo>', 'md5|sha1|sha256|sha512 (défaut: sha256)', 'sha256')
   .option('--base64', 'sortie en base64')
   .action(async (input, options) => {
      const algo = String(options.algo).toLowerCase();
      if (!HASH_ALGOS.includes(algo)) return console.log(c.error(`\n  ✗ Algo inconnu: ${c.dim(algo)}. Disponibles: ${c.accent(HASH_ALGOS.join(', '))}\n`));
      const hash = createHash(algo);
      let label = '';
      if (options.file) {
        const fp = path.resolve(options.file);
        if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return console.log(c.error(`\n  ✗ Fichier introuvable: ${c.dim(options.file)}\n`));
        const spinner = createSpinner('Hachage du fichier...');
        try {
          await new Promise((res, rej) => {
            const st = fs.createReadStream(fp);
            st.on('data', (d) => hash.update(d));
            st.on('end', res);
            st.on('error', rej);
          });
        } catch (e) {
          spinner.stop('❌ Échec');
          return console.log(c.error(`\n  ✗ Lecture impossible: ${e.message}\n`));
        }
        spinner.stop(`✅ ${path.basename(fp)} (${humanSize(fs.statSync(fp).size)})`);
        label = path.basename(fp);
      } else {
        let data = input;
        if (data == null) data = await readStdin();
        if (data == null) return console.log(c.error('\n  ✗ Rien à hacher. Passez du texte ou utilisez ' + c.accent('--file') + '.\n'));
        hash.update(String(data));
        label = 'texte';
      }
      const digest = options.base64 ? hash.digest('base64') : hash.digest('hex');
      const bytes = options.base64 ? Buffer.from(digest, 'base64') : Buffer.from(digest, 'hex');
      console.log('\n' + box(`🔒 ${c.accent(algo)} ${c.dim('· ' + label)}`, [
        `  ${c.info('▸')} ${chalk.white(digest)}`,
        `  ${c.dim('—')} ${humanSize(bytes.length)} ${options.base64 ? c.dim('(base64)') : c.dim('(hex)')}`,
      ], { color: chalk.green, rounded: true }) + '\n');
    });

  program
   .command('base64')
   .description('Encoder / décoder en base64')
   .argument('[data]', 'texte ou base64')
   .option('-d, --decode', 'décoder')
   .option('-f, --file <path>', 'opérer sur un fichier')
   .action(async (data, options) => {
      let input = data;
      if (options.file) {
        const fp = path.resolve(options.file);
        if (!fs.existsSync(fp)) return console.log(c.error(`\n  ✗ Fichier introuvable: ${c.dim(options.file)}\n`));
        input = fs.readFileSync(fp);
      } else if (input == null) {
        const s = await readStdin();
        if (s == null) return console.log(c.error('\n  ✗ Rien à traiter. Passez du texte ou utilisez ' + c.accent('--file') + '.\n'));
        input = s.replace(/\n$/, '');
      }
      try {
        const out = options.decode
          ? Buffer.from(String(input), 'base64').toString('utf-8')
          : Buffer.from(String(input), 'utf-8').toString('base64');
        const title = options.decode ? '🔓 Décodage base64' : '🔐 Encodage base64';
        const srcLabel = options.file ? path.basename(options.file) : 'texte';
        console.log('\n' + box(`${title} ${c.dim('· ' + srcLabel)}`, [`  ${c.info('▸')} ${chalk.white(out)}`], { color: chalk.cyan, rounded: true }) + '\n');
      } catch (e) {
        console.log(c.error(`\n  ✗ Base64 invalide: ${e.message}\n`));
      }
    });

  program
   .command('json')
   .description('Formater ou valider du JSON (fichier ou stdin)')
   .argument('[file]', 'fichier JSON')
   .option('-s, --sort', 'trier les clés')
   .option('-i, --indent <n>', 'indentation (défaut: 2)', '2')
   .option('-c, --compact', 'une seule ligne')
   .option('--validate', 'valider seulement')
   .action(async (file, options) => {
      let text = null;
      if (file) {
        const fp = path.resolve(file);
        if (!fs.existsSync(fp)) return console.log(c.error(`\n  ✗ Fichier introuvable: ${c.dim(file)}\n`));
        text = fs.readFileSync(fp, 'utf-8');
      } else {
        text = await readStdin();
        if (text == null) return console.log(c.error('\n  ✗ Rien à traiter. Passez un fichier ou du JSON via stdin.\n'));
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        const m = String(e.message).match(/position (\d+)/);
        let pos = null;
        if (m) pos = parseInt(m[1], 10);
        const before = text.slice(0, pos ?? 0);
        const line = (before.match(/\n/g) || []).length + 1;
        const col = pos != null ? pos - before.lastIndexOf('\n') : null;
        console.log(c.error(`\n  ✗ JSON invalide: ${e.message}`));
        if (pos != null) console.log(`  ${c.dim('ligne ' + line + (col != null ? ', colonne ' + col : '') + ' →')} ${c.dim(text.slice(Math.max(0, pos - 20), pos + 20))}`);
        if (options.validate) { console.log(c.error('  → INVALIDÉ\n')); return; }
        console.log('');
        return;
      }
      if (options.validate) {
        const kind = Array.isArray(parsed) ? `tableau de ${parsed.length} élément(s)` : parsed === null ? 'null' : typeof parsed === 'object' ? `objet (${Object.keys(parsed).length} clés)` : `valeur ${typeof parsed}`;
        return console.log(c.success(`\n  ✅ JSON valide — ${c.accent(kind)}\n`));
      }
      const indent = options.compact ? 0 : Math.max(0, Math.min(8, parseInt(options.indent, 10) || 2));
      const pretty = JSON.stringify(parsed, options.sort ? (k, v) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v).sort().reduce((o, kk) => { o[kk] = v[kk]; return o; }, {});
        return v;
      } : null, indent || undefined);
      if (options.compact) { console.log('\n' + pretty + '\n'); return; }
      const lines = pretty.split('\n').map(l => `  ${l}`);
      console.log('\n' + box('🧾 JSON ' + (file ? c.dim('· ' + path.basename(file)) : ''), lines, { color: chalk.green, rounded: true }) + '\n');
    });

  program
   .command('env')
   .description('Outils .env : lister, générer .env.example, get/set')
   .argument('[file]', 'fichier (défaut: .env)', '.env')
   .option('--example', 'générer .env.example depuis ce fichier')
   .option('-s, --show', 'afficher les valeurs complètes')
   .option('--get <key>', 'afficher la valeur d\'une clé')
   .option('--set <key=value>', 'définir une clé (ex: --set DEBUG=true)')
   .option('-f, --force', 'écraser .env.example s\'il existe')
   .action((file, options) => {
      const fp = path.resolve(file);
      if (options.set) {
        const eq = options.set.indexOf('=');
        if (eq < 0) return console.log(c.error('\n  ✗ Format attendu: ' + c.accent('--set CLE=valeur') + '\n'));
        const setKey = options.set.slice(0, eq).trim();
        const value = options.set.slice(eq + 1);
        if (!setKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(setKey)) return console.log(c.error('\n  ✗ Clé invalide (lettres, chiffres, _)\n'));
        let lines = [];
        if (fs.existsSync(fp)) lines = fs.readFileSync(fp, 'utf-8').split('\n');
        const idx = lines.findIndex(l => new RegExp('^\\s*' + setKey + '=').test(l));
        const line = setKey + '=' + value;
        if (idx >= 0) lines[idx] = line;
        else lines.push(line);
        fs.writeFileSync(fp, lines.join('\n') + '\n');
        console.log(c.success(`\n  ✅ ${c.accent(setKey)} définie dans ${c.dim(fp)}\n`));
        return;
      }
      if (!fs.existsSync(fp)) return console.log(c.error(`\n  ✗ Fichier introuvable: ${c.dim(fp)}\n`));
      const entries = parseEnv(fs.readFileSync(fp, 'utf-8'));
      if (options.get) {
        const hit = entries.find(e => e.key === options.get);
        if (!hit) return console.log(c.error(`\n  ✗ Clé "${options.get}" absente de ${c.dim(fp)}\n`));
        return console.log(`\n  ${c.accent(options.get)} = ${chalk.white(hit.val)}\n`);
      }
      if (options.example) {
        const ex = path.join(path.dirname(fp), '.env.example');
        if (fs.existsSync(ex) && !options.force) return console.log(c.error(`\n  ✗ "${ex}" existe déjà. Utilise: ${c.accent('-f')}\n`));
        const seen = new Set();
        const lines = [];
        for (const e of entries) {
          if (seen.has(e.key)) continue;
          seen.add(e.key);
          lines.push(e.key + '=');
        }
        fs.writeFileSync(ex, lines.join('\n') + '\n');
        console.log(c.success(`\n  ✅ ${c.accent('.env.example')} généré (${chalk.white(entries.length)} clés, valeurs vidées)\n`));
        return;
      }
      if (!entries.length) return console.log(c.warn(`\n  📭 ${c.dim(fp)} est vide (ou ne contient que des commentaires)\n`));
      const lines = entries.map((e, i) => `  ${c.accent(String(i + 1).padStart(2, '0'))}  ${chalk.white(e.key.padEnd(28))} ${options.show ? chalk.white(e.val) : maskValue(e.val, c)}`);
      lines.push(`  ${c.dim('—')} ${chalk.white(entries.length)} clé(s) dans ${c.dim(path.basename(fp))}`);
      console.log('\n' + box('🔑 Fichier .env', lines, { color: chalk.cyan, rounded: true }) + '\n');
      hint(`Générer: ${c.accent('devkit env --example')}   Lire: ${c.accent('devkit env --get MA_CLE')}   Écrire: ${c.accent('devkit env --set MA_CLE=valeur')}`);
    });

  program
   .command('http')
   .description('Client HTTP en ligne de commande (comme curl, sortie en joli)')
   .argument('<url>', 'URL')
   .option('-m, --method <method>', 'méthode HTTP (défaut: GET)', 'GET')
   .option('-H, --header <header>', 'en-tête "Nom: valeur" (répétable)')
   .option('-d, --data <data>', 'corps de requête')
   .option('-j, --json', 'envoyer --data en tant que JSON')
   .option('--status', 'afficher seulement le code de statut')
   .option('-t, --timeout <ms>', 'timeout en ms (défaut: 10000)', '10000')
   .option('-o, --out <file>', 'enregistrer le corps dans un fichier')
   .action(async (url, options) => {
      const headers = {};
      const hdrs = Array.isArray(options.header) ? options.header : options.header ? [options.header] : [];
      for (const h of hdrs) {
        const i = h.indexOf(':');
        if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
      }
      let body = options.data;
      try {
        if (options.json) {
          headers['Content-Type'] = headers['Content-Type'] || 'application/json';
          body = JSON.stringify(JSON.parse(body));
        }
      } catch (e) {
        return console.log(c.error(`\n  ✗ JSON invalide dans --data: ${e.message}\n`));
      }
      const spinner = createSpinner(`${options.method} ${url}...`);
      let res;
      try {
        res = await fetch(url, {
          method: options.method, headers, body: body ?? undefined,
          signal: AbortSignal.timeout(parseInt(options.timeout, 10) || 10000),
          redirect: 'follow',
        });
      } catch (e) {
        spinner.stop('❌ Échec');
        return console.log(c.error(`\n  ✗ ${e.message}\n`));
      }
      spinner.stop();
      const code = res.status;
      const color = code < 300 ? c.success : code < 400 ? c.warn : c.error;
      if (options.status) return console.log(color(`\n  ${code} ${res.statusText}\n`));
      const raw = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get('content-type') || '';
      const lines = [
        `  ${color(String(code) + ' ' + res.statusText)} ${c.dim(url)}`,
        `  ${c.dim('Date:')} ${chalk.white(res.headers.get('date') || '—')}`,
        `  ${c.dim('Type:')} ${chalk.white(ct.split(';')[0] || '—')}  ${c.dim('Taille:')} ${chalk.white(humanSize(raw.length))}`,
      ];
      if (options.out) {
        fs.writeFileSync(path.resolve(options.out), raw);
        lines.push(`  📁 ${c.success('corps enregistré dans ' + options.out)}`);
        return console.log('\n' + box('🌍 Réponse HTTP', lines, { color: chalk.green, rounded: true }) + '\n');
      }
      const text = raw.toString('utf-8');
      const maxLen = 50000;
      const shown = text.length > maxLen ? text.slice(0, maxLen) + c.dim('\n… (' + (text.length - maxLen) + ' caractères masqués)') : text;
      let pretty = shown;
      if (/json/i.test(ct)) {
        try { pretty = JSON.stringify(JSON.parse(shown), null, 2); } catch { /* garde le brut */ }
      }
      console.log('\n' + box('🌍 Réponse HTTP', lines, { color: chalk.green, rounded: true }) + '\n');
      console.log('  ' + pretty.replace(/\n/g, '\n  ') + '\n');
    });

  program
   .command('ip')
   .description('Afficher les adresses IP locales (+ IP publique)')
   .option('-p, --public', 'tenter de récupérer l\'IP publique')
   .option('-j, --json', 'sortie JSON')
   .action(async (options) => {
      const lines = [];
      for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) {
          const fam = typeof a.family === 'number' ? (a.family === 4 ? 'IPv4' : 'IPv6') : a.family;
          const tag = a.internal ? c.dim('(interne)') : fam === 'IPv4' ? c.success('IPv4') : c.info('IPv6');
          lines.push(`  ${c.accent(name.padEnd(10))} ${chalk.white(a.address.padEnd(18))} ${tag}`);
        }
      }
      if (options.public) {
        const spinner = createSpinner('Récupération de l\'IP publique...');
        let pub = null;
        try {
          const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
          if (r.ok) pub = (await r.json()).ip;
        } catch { /* ignore */ }
        spinner.stop();
        if (pub) lines.push(`  ${c.accent('public     ')} ${chalk.white(pub)} ${c.success('🌐')}`);
        else lines.push(`  ${c.dim('public     — indisponible (hors ligne ?)')}`);
      }
      if (options.json) {
        const data = {};
        for (const [name, addrs] of Object.entries(os.networkInterfaces())) data[name] = (addrs || []).map(a => ({ address: a.address, family: typeof a.family === 'number' ? a.family : a.family === 'IPv4' ? 4 : 6, internal: a.internal }));
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log('\n' + box('🌐 Adresses IP', lines, { color: chalk.cyan, rounded: true }) + '\n');
    });

  program
   .command('cert')
   .description('Générer un certificat SSL auto-signé pour le dev local')
   .argument('[dir]', 'dossier de sortie (défaut: ./certs)', 'certs')
   .option('--hosts <hosts>', 'hôtes (défaut: localhost,127.0.0.1)', 'localhost,127.0.0.1')
   .option('--days <n>', 'validité en jours (défaut: 365)', '365')
   .option('--rsa', 'clé RSA 2048 (lente) au lieu de ed25519 (instantanée)')
   .option('-k, --key <name>', 'fichier clé (défaut: key.pem)', 'key.pem')
   .option('-c, --cert <name>', 'fichier certificat (défaut: cert.pem)', 'cert.pem')
   .action((dir, options) => {
      const check = spawnSync('openssl', ['version'], { encoding: 'utf-8' });
      if (check.error || check.status !== 0) {
        console.log(c.error('\n  ✗ openssl introuvable.'));
        return console.log(c.dim('  Installez-le (ex: apt install openssl) puis réessayez.\n'));
      }
      const dest = path.resolve(dir);
      fs.mkdirSync(dest, { recursive: true });
      const hosts = String(options.hosts).split(',').map(s => s.trim()).filter(Boolean);
      const san = hosts.map(h => isIP(h) ? 'IP:' + h : 'DNS:' + h).join(',');
      const keyPath = path.join(dest, options.key);
      const certPath = path.join(dest, options.cert);
      if (fs.existsSync(keyPath) || fs.existsSync(certPath)) {
        console.log(c.error(`\n  ✗ ${path.basename(keyPath)} ou ${path.basename(certPath)} existe déjà. Utilisez un autre dossier (${c.accent('devkit cert ./autre')}) ou supprimez-les.\n`));
        return;
      }
      const spinner = createSpinner('Génération de la clé + certificat...');
      const keyArgs = options.rsa
        ? ['-x509', '-newkey', 'rsa:2048', '-nodes']
        : ['-x509', '-newkey', 'ed25519', '-nodes'];
      const r = spawnSync('openssl', [
        'req', ...keyArgs,
        '-keyout', keyPath, '-out', certPath,
        '-days', String(parseInt(options.days, 10) || 365),
        '-subj', '/CN=' + hosts[0],
        '-addext', 'subjectAltName=' + san,
      ], { stdio: 'ignore' });
      if (r.status !== 0) {
        fs.rmSync(keyPath, { force: true });
        fs.rmSync(certPath, { force: true });
        spinner.stop('❌ Échec');
        return console.log(c.error(`\n  ✗ openssl a échoué (code ${r.status}). Vérifiez la commande.\n`));
      }
      spinner.stop(`✅ Certificat généré (${check.stdout.trim().split('\n')[0]})`);
      console.log('\n' + box('🔐 Certificat SSL de dev', [
        `  🗝️  ${c.accent(keyPath)} ${c.dim('(clé privée)')}`,
        `  📜 ${c.accent(certPath)} ${c.dim('(certificat)')}`,
        `  🏷️  ${chalk.white('SAN: ' + san)}  ${c.dim(parseInt(options.days, 10) || 365 + ' jours')}`,
      ], { color: chalk.magenta, rounded: true }) + '\n');
      hint(`HTTPS local: ${c.accent('NODE_EXTRA_CA_CERTS=' + certPath + ' node server.js')}   (pour Node seulement) sinon ajoutez le certificat aux autorités de confiance du système.`);
    });

  program
   .command('bench')
   .description('Mesurer le temps d\'exécution d\'une commande')
   .argument('<cmd...>', 'commande à mesurer')
   .option('-r, --runs <n>', 'nombre d\'exécutions (défaut: 1)', '1')
   .option('--no-shell', 'exécuter sans passer par le shell')
   .action((cmd, options) => {
      const runs = Math.max(1, Math.min(50, parseInt(options.runs, 10) || 1));
      const argv = cmd.join(' ');
      const times = [];
      const spinner = createSpinner(`Benchmark: ${argv}`);
      for (let i = 0; i < runs; i++) {
        spinner.set(`Benchmark ${i + 1}/${runs}: ${argv}`);
        const t0 = performance.now();
        const r = options.shell === false
          ? spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' })
          : spawnSync(argv, { shell: true, stdio: 'inherit' });
        times.push((performance.now() - t0) / 1000);
        if (r.status !== 0 && r.status != null) {
          spinner.stop('❌ Échec');
          return console.log(c.error(`\n  ✗ La commande a échoué (code ${r.status})\n`));
        }
      }
      spinner.stop(`✅ ${runs} exécution(s)`);
      const fmt = (s) => s.toFixed(3) + 's';
      const lines = [
        `  ⚙️  ${c.accent(argv)}`,
        runs === 1
          ? `  ⏱️  ${c.success(fmt(times[0]))}`
          : `  ⏱️  min ${c.success(fmt(Math.min(...times)))}  moy ${c.success(fmt(times.reduce((a, b) => a + b, 0) / runs))}  max ${c.success(fmt(Math.max(...times)))}`,
      ];
      if (runs > 1) lines.push(`  📊 ${c.dim(times.map(fmt).join('  '))}`);
      console.log('\n' + box('⏱️  Benchmark', lines, { color: chalk.green, rounded: true }) + '\n');
    });
}
