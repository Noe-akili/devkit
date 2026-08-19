import { loadExeca, ttyCols, clearLine, offlineRequested } from './core.js';

export async function gitClone(url, dest) {
  if (offlineRequested()) {
    console.error(`\x1b[33m⚠  Mode offline : clone git désactivé (${url})\x1b[0m\n`);
    throw new Error('mode offline (clone git désactivé)');
  }
  const execa = await loadExeca();
  const t0 = Date.now();
  const tty = !!process.stderr.isTTY;
  let i = 0;
  let recv = 0;
  let delta = 0;
  let timer = null;
  if (tty) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const barCells = Math.max(6, Math.min(14, Math.floor((ttyCols() - 24) / 2)));
    timer = setInterval(() => {
      i++;
      const el = ((Date.now() - t0) / 1000).toFixed(1) + 's';
      const pct = recv || delta;
      const fill = Math.round((pct / 100) * barCells);
      const bar = '█'.repeat(fill) + '░'.repeat(Math.max(0, barCells - fill));
      process.stderr.write(`\r\x1b[K\x1b[36m${frames[i % frames.length]}\x1b[0m \x1b[2m${el}\x1b[0m \x1b[36m${bar}\x1b[0m \x1b[1m${pct}%\x1b[0m \x1b[2m${url.split(/[/:]/).pop()}\x1b[0m`);
    }, 90);
  } else {
    console.error(`\x1b[2mClone git…\x1b[0m`);
  }
  try {
    const p = execa('git', ['clone', '--depth', '1', '--no-tags', '--progress', url, dest], { stderr: 'pipe', stdout: 'ignore', reject: false });
    let buf = '';
    p.stderr.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r\n?|\n/);
      buf = lines.pop();
      for (const line of lines) {
        const r = line.match(/Receiving objects:\s*(\d+)%/);
        if (r) recv = parseInt(r[1], 10);
        const d2 = line.match(/Resolving deltas:\s*(\d+)%/);
        if (d2) delta = parseInt(d2[1], 10);
      }
    });
    await p;
    if (p.exitCode !== 0) throw new Error(`git clone a échoué (code ${p.exitCode})`);
  } catch (e) {
    if (timer) clearInterval(timer);
    if (tty) clearLine();
    console.error(`\x1b[31m✗ Clone échoué: ${e.message}\x1b[0m\n`);
    throw e;
  }
  if (timer) clearInterval(timer);
  if (tty) clearLine();
  console.error(`\x1b[32m✓\x1b[0m \x1b[2mCloné\x1b[0m \x1b[1m${url}\x1b[0m en ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

export async function fetchSource(src, tmp) {
  if (src.type === 'git') {
    await gitClone(src.url, tmp);
    return tmp;
  }
  return src.path;
}
