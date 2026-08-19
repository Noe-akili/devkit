import fs from 'fs';
import path from 'path';
import os from 'os';
import { DK_HOME, loadExeca } from './core.js';
import { pkgStubSource } from './dk.js';

// BINAIRE AUTONOME via pkg (@yao-pkg/pkg)
// Le payload .dk est appendé au binaire : à l'exécution, le stub lit process.execPath,
// repère le magic DKPK et extrait/lance l'app. Node est embarqué → aucun prérequis.
function isAndroid() {
  return fs.existsSync('/system/build.prop')
    || !!(process.env.TERMUX_VERSION && process.env.PREFIX)
    || (typeof os.homedir === 'function' && os.homedir().startsWith('/data/data/com.termux'));
}

export async function buildPkgExe(buffer, out) {
  if (isAndroid()) {
    return { ok: false, error: 'Android (Termux) : pkg ne peut pas produire un binaire exécutable ici (pas de runtime node Android). Binaire standard généré.' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-pkg-'));
  try {
    fs.writeFileSync(path.join(tmp, 'main.js'), pkgStubSource());
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'devkit-exe',
      version: '1.0.0',
      private: true,
      bin: { 'devkit-app': 'main.js' },
    }, null, 2) + '\n');
    const target = `node${process.versions.node.split('.')[0]}-${process.platform}-${process.arch}`;
    const exeTmp = path.join(tmp, 'out');
    fs.mkdirSync(path.join(DK_HOME, 'pkg-cache'), { recursive: true });
    const env = { ...process.env, PKG_CACHE_PATH: path.join(DK_HOME, 'pkg-cache') };
    const execa = await loadExeca();
    const p = execa('npx', ['--yes', '@yao-pkg/pkg', '.', '--targets', target, '--output', exeTmp], {
      cwd: tmp, env, stdout: 'ignore', stderr: 'pipe', reject: false, timeout: 600000, killSignal: 'SIGKILL',
    });
    let errLog = '';
    p.stderr.on('data', (d) => { errLog += d.toString(); });
    const res = await p;
    if (res.exitCode !== 0) {
      const lines = errLog.split('\n').map(l => l.replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(Boolean);
      const meaningful = lines.filter(l => !/^npm notice|^> \u001b|Fetching base|^npm error run/i.test(l));
      const lastErr = (meaningful.filter(l => /Error!|Error:|Failed|Not found|not able|unsupported|404/i.test(l)).pop() || meaningful.pop() || 'téléchargement du runtime Node impossible sur cette plateforme').slice(0, 120);
      return { ok: false, error: lastErr };
    }
    if (!fs.existsSync(exeTmp)) return { ok: false, error: 'pkg n\'a pas produit de binaire' };
    const data = fs.readFileSync(exeTmp);
    fs.writeFileSync(out, Buffer.concat([data, buffer]));
    fs.chmodSync(out, 0o755);
    return { ok: true, size: fs.statSync(out).size, target };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
