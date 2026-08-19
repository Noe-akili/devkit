import fs from 'fs';
import path from 'path';
import { DEPS_DIR, DEPS_FILE, DEPS_NM, readPackage, loadExeca, ttyCols, clearLine, offlineRequested } from './core.js';

export async function runNpm(cwd, args) {
  if (offlineRequested()) {
    console.error('\x1b[33m⚠  Mode offline : installation des dépendances désactivée.\x1b[0m\n');
    throw new Error('mode offline (réseau indisponible/désactivé)');
  }
  const execa = await loadExeca();
  const t0 = Date.now();
  const tty = !!process.stderr.isTTY;
  let i = 0;
  let fetched = 0;
  let cur = '';
  let added = null;
  let err = '';
  let timer = null;
  if (tty) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const barCells = Math.max(6, Math.min(14, Math.floor((ttyCols() - 26) / 2)));
    timer = setInterval(() => {
      i++;
      const el = ((Date.now() - t0) / 1000).toFixed(1) + 's';
      const fill = i % (barCells + 1);
      const bar = '█'.repeat(fill) + '░'.repeat(Math.max(0, barCells - fill));
      const name = cur ? ` \x1b[2m📦 ${cur}\x1b[0m` : '';
      process.stderr.write(`\r\x1b[K\x1b[36m${frames[i % frames.length]}\x1b[0m \x1b[2m${el}\x1b[0m \x1b[36m${bar}\x1b[0m \x1b[1m${fetched || '…'}\x1b[0m \x1b[2mpaquets\x1b[0m${name}`);
    }, 90);
  } else {
    console.error(`\x1b[2mInstallation des dépendances…\x1b[0m`);
  }
  try {
    const p = execa('npm', ['install', ...args, '--no-audit', '--no-fund', '--no-color', '--no-progress', '--loglevel=http'], { cwd, stderr: 'pipe', stdout: 'ignore', reject: false });
    let buf = '';
    p.stderr.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r\n?|\n/);
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/fetch GET \d+ (https?:\/\/\S+\.tgz)\b/);
        if (m) {
          const url = m[1];
          const scope = url.match(/\/@([^/]+)\//);
          let base = url.split('/').pop().replace(/\.tgz$/, '');
          base = base.replace(/-\d+\.\d+\.\d+[^/]*$/, '');
          cur = (scope ? '@' + scope[1] + '/' : '') + base;
          fetched++;
          continue;
        }
        const a = line.match(/added (\d+) packages/);
        if (a) added = parseInt(a[1], 10);
        else if (line.includes('up to date')) added = 0;
        const e = line.match(/npm error (.+)/);
        if (e) err = e[1];
      }
    });
    await p;
    if (p.exitCode !== 0) throw new Error(err || `npm install a échoué (code ${p.exitCode})`);
  } catch (e) {
    if (timer) clearInterval(timer);
    if (tty) clearLine();
    console.error(`\x1b[31m✗ Installation des dépendances échouée: ${e.message}\x1b[0m\n`);
    throw e;
  }
  if (timer) clearInterval(timer);
  if (tty) clearLine();
  const n = added ?? fetched;
  console.error(`\x1b[32m✓\x1b[0m \x1b[2mDépendances installées\x1b[0m — \x1b[1m${n}\x1b[0m paquets en ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

export function migrateResolutions(dir) {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return false;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return false; }
  const res = pkg.resolutions;
  if (!res || pkg.overrides) return false;
  const ov = {};
  for (const [k, v] of Object.entries(res)) {
    if (!k || k.includes('/') || k.includes('*') || typeof v !== 'string') continue;
    ov[k] = v;
  }
  if (!Object.keys(ov).length) return false;
  pkg.overrides = { ...(pkg.overrides || {}), ...ov };
  delete pkg.resolutions;
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  fs.rmSync(path.join(dir, 'package-lock.json'), { force: true });
  return true;
}

export function sharedNodeModules(dir) {
  try {
    const l = path.join(dir, 'node_modules');
    return fs.lstatSync(l).isSymbolicLink() && fs.realpathSync(l) === DEPS_NM;
  } catch { return false; }
}

export async function installShared(dir, extra = [], force = false) {
  const appPkg = readPackage(dir) || {};
  const flags = [];
  const specs = [];
  for (const s of extra) (s.startsWith('-') ? flags : specs).push(s);
  const merged = { ...(appPkg.dependencies || {}), ...(appPkg.devDependencies || {}) };
  for (const s of specs) {
    const m = s.match(/^((?:@[^/]+\/)?[^@]+)(?:@(.*))?$/);
    if (m) merged[m[1]] = m[2] || '*';
  }
  fs.mkdirSync(DEPS_DIR, { recursive: true });
  let shared = { dependencies: {} };
  try { shared = JSON.parse(fs.readFileSync(DEPS_FILE, 'utf-8')); } catch { /* ignore */ }
  shared.dependencies = shared.dependencies || {};
  let changed = false;
  for (const [n, v] of Object.entries(merged)) {
    if (shared.dependencies[n] !== v) { shared.dependencies[n] = v; changed = true; }
  }
  if (changed) fs.writeFileSync(DEPS_FILE, JSON.stringify(shared, null, 2) + '\n');
  if (force || changed || !fs.existsSync(DEPS_NM)) await runNpm(DEPS_DIR, flags);
  const link = path.join(dir, 'node_modules');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(DEPS_NM, link, 'dir');
}

export async function installDeps(dir, extra = [], opts = {}) {
  migrateResolutions(dir);
  if (opts.local) return runNpm(dir, extra);
  return installShared(dir, extra, opts.force);
}

export async function tryReinstall(dir, extra = []) {
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'package-lock.json'), { force: true });
  try { await installDeps(dir, extra, { force: true }); return true; } catch { return false; }
}
