import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { DK_HOME, loadState, saveState, appEnv, runApp, parseCommandLine } from './core.js';
import { installDeps, tryReinstall } from './deps.js';

export function extractPort(t) {
  const m = t.match(/(?:EADDRINUSE|already in use)[^\n]*?:(\d{2,5})/)
    || t.match(/port[^\n]*(\d{2,5})[^\n]*already in use/i);
  return m ? parseInt(m[1], 10) : null;
}
function listenTable() {
  const out = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    for (const line of txt.split('\n').slice(1)) {
      const m = line.trim().split(/\s+/);
      if (m.length < 10 || m[3] !== '0A') continue;
      const local = (m[1] || '').split(':');
      if (local.length !== 2) continue;
      out.push({ port: parseInt(local[1], 16), inode: m[9] });
    }
  }
  return out;
}
function pidForSocket(inode) {
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let fds;
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        try {
          if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return pid;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return null;
}
function killProcess(pid) {
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function probeOutput(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(out); } };
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return finish(); }
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } finish(); }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', finish);
    p.on('close', () => { clearTimeout(timer); finish(); });
  });
}
export async function findPidsOnPort(port) {
  const pids = new Set();
  const addFrom = (out, filter, pidRe) => {
    for (const line of out.split('\n')) {
      if (filter && !filter(line)) continue;
      for (const m of line.matchAll(pidRe)) {
        const p = parseInt(m[1], 10);
        if (p > 1 && pidAlive(p)) pids.add(p);
      }
    }
  };
  const probes = [
    ['ss', ['-ltnp'], (l) => l.includes(`:${port}`), /pid=(\d+)/g],
    ['netstat', ['-ltnp'], (l) => l.includes(`:${port}`) && /LISTEN/.test(l), /(\d+)\/[^\s]*$/gm],
    ['lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], null, /^\S+\s+(\d+)\s+/gm],
  ];
  const outs = await Promise.all(probes.map(([c, a]) => probeOutput(c, a)));
  outs.forEach((o, i) => addFrom(o, probes[i][2], probes[i][3]));
  const fuserOut = await probeOutput('fuser', ['-n', 'tcp', String(port)]);
  for (const m of (fuserOut).split(':').pop().matchAll(/(\d+)/g)) {
    const p = parseInt(m[1], 10);
    if (p > 1 && pidAlive(p)) pids.add(p);
  }
  for (const l of listenTable().filter(x => x.port === port)) {
    const pid = pidForSocket(l.inode);
    if (pid && pidAlive(Number(pid))) pids.add(Number(pid));
  }
  return [...pids];
}

export async function runBuildIfNeeded(dir, manifest) {
  if (!manifest.build) return false;
  const [cmd, ...args] = parseCommandLine([manifest.build]);
  const { status } = await runApp([cmd, args], dir, appEnv(manifest));
  return status === 0;
}

export function diagnose(log) {
  const t = log || '';
  if (/Cannot find module @rollup\/rollup|rollup[^\n]*(native|\.node|ERR_DLOPEN)/i.test(t)) {
    return { id: 'rollup-native', needsInstall: true, msg: 'Le binding natif de rollup ne se charge pas → bascule sur le build WASM (npm:@rollup/wasm-node).' };
  }
  if (/ERR_DLOPEN_FAILED|did not self-register|cannot open shared object file|cannot load native file/i.test(t)) {
    return { id: 'native-binding', needsInstall: true, msg: 'Un module natif (.node) ne se charge pas sur cet appareil → réinstallation + reconstruction.' };
  }
  const mm = t.match(/Cannot find module '([^']+)'/);
  if (mm) return { id: 'missing-module', needsInstall: true, module: mm[1], msg: `Module introuvable: ${mm[1]} → réinstallation des dépendances.` };
  if (/EADDRINUSE|address already in use|port[^\n]*already in use/i.test(t)) {
    const port = extractPort(t);
    return { id: 'port-in-use', port, msg: port ? `Le port ${port} est déjà occupé → libération automatique du port.` : 'Un port est déjà occupé → libération automatique.' };
  }
  if (/ENOSPC|no space left on device/i.test(t)) {
    return { id: 'disk-full', needsInstall: true, msg: 'Espace disque insuffisant → nettoyage des caches devkit et npm.' };
  }
  if (/EACCES|EPERM|permission denied/i.test(t)) {
    return { id: 'permissions', msg: "Permissions insuffisantes → réparation des droits d'écriture sur le projet." };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network is unreachable|getaddrinfo/i.test(t)) {
    return { id: 'network', needsInstall: true, msg: "Erreur réseau (peut-être transitoire) → nouvel essai d'installation." };
  }
  if (/ERR_OSSL_EVP_UNSUPPORTED|error:0308010C|digital envelope routines/i.test(t)) {
    return { id: 'openssl', msg: 'OpenSSL moderne incompatible avec le build → activation du mode legacy.' };
  }
  if (/ERESOLVE|conflicting peer dependency|EINTEGRITY/i.test(t)) {
    return { id: 'peer-conflict', needsInstall: true, msg: 'Conflit de dépendances → réinstallation en mode legacy-peer-deps.' };
  }
  if (/EBADENGINE|engine[^\n]*node[^\n]*not compatible/i.test(t)) {
    return { id: 'engine', hard: true, msg: 'Version de Node.js incompatible avec les exigences du projet.' };
  }
  return null;
}
export async function fixRollupNative(dir) {
  const p = path.join(dir, 'package.json');
  let pkg = { overrides: {} };
  try { pkg = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* ignore */ }
  let ver = null;
  try { ver = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'rollup', 'package.json'), 'utf-8')).version; } catch { /* ignore */ }
  if (!ver) ver = '4.62.4';
  pkg.overrides = pkg.overrides || {};
  pkg.overrides.rollup = `npm:@rollup/wasm-node@${ver}`;
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  return tryReinstall(dir);
}
function isPkgName(name) {
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name || '');
}
export async function fixMissingModule(diag, ctx) {
  if (diag.module && diag.module.startsWith('.')) return runBuildIfNeeded(ctx.dir, ctx.manifest);
  ctx.attempts = ctx.attempts || {};
  ctx.attempts.missingModule = (ctx.attempts.missingModule || 0) + 1;
  if (ctx.attempts.missingModule > 1 && isPkgName(diag.module)) {
    try { await installDeps(ctx.dir, [diag.module]); return true; } catch { return false; }
  }
  return tryReinstall(ctx.dir);
}
export async function fixPortInUse(diag) {
  const pids = diag.port ? await findPidsOnPort(diag.port) : [];
  for (const pid of pids) {
    if (killProcess(pid)) {
      let waited = 0;
      while (pidAlive(pid) && waited < 2000) { await new Promise(r => setTimeout(r, 100)); waited += 100; }
      if (!pidAlive(pid)) return true;
    }
  }
  return false;
}
function fixPermissions(dir) {
  const r = spawnSync('chmod', ['-R', 'u+rwX,go+rX', dir], { stdio: 'ignore' });
  return !r.error;
}
export async function fixDiskFull(ctx) {
  for (const c of [path.join(DK_HOME, 'tmp'), path.join(DK_HOME, 'cache')]) fs.rmSync(c, { recursive: true, force: true });
  fs.mkdirSync(path.join(DK_HOME, 'tmp'), { recursive: true });
  spawnSync('npm', ['cache', 'clean', '--force'], { stdio: 'ignore' });
  return tryReinstall(ctx.dir);
}
export async function fixOpenSSL(ctx) {
  const st = loadState(ctx.name);
  const opt = (st.env && st.env.NODE_OPTIONS) || process.env.NODE_OPTIONS || '';
  if (!/openssl-legacy-provider/.test(opt)) {
    st.env = { ...(st.env || {}), NODE_OPTIONS: (opt ? opt + ' ' : '') + '--openssl-legacy-provider' };
    saveState(ctx.name, st);
    ctx.manifest.env = { ...(ctx.manifest.env || {}), ...st.env };
  }
  return true;
}
export async function applyFix(diag, ctx) {
  switch (diag.id) {
    case 'rollup-native': return fixRollupNative(ctx.dir);
    case 'missing-module': return fixMissingModule(diag, ctx);
    case 'native-binding': return tryReinstall(ctx.dir);
    case 'port-in-use': return fixPortInUse(diag);
    case 'permissions': return fixPermissions(ctx.dir);
    case 'disk-full': return fixDiskFull(ctx);
    case 'network': return tryReinstall(ctx.dir);
    case 'openssl': return fixOpenSSL(ctx);
    case 'peer-conflict': return tryReinstall(ctx.dir, ['--legacy-peer-deps']);
    default: return false;
  }
}
