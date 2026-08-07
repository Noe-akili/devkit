import fs from 'fs';
import path from 'path';
import os from 'os';
import { readPackage, loadFg, runApp, parseCommandLine } from './core.js';
import { installDeps } from './deps.js';
import { shellString } from './dk.js';

export function hasBuild(dir) {
  const p = readPackage(dir);
  return !!(p && p.scripts && p.scripts.build);
}
export function looksLikeFrontend(dir) {
  for (const f of ['index.html', path.join('src', 'index.html'), path.join('src', 'app.html'), 'angular.json', 'next.config.js', 'next.config.mjs', 'nuxt.config.js', 'nuxt.config.ts', 'svelte.config.js']) {
    if (fs.existsSync(path.join(dir, f))) return true;
  }
  return false;
}
export function detectBuildOut(dir) {
  const readConf = (files) => {
    for (const f of files) {
      try { return fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { /* ignore */ }
    }
    return null;
  };
  const viteLike = readConf(['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vue.config.js', 'svelte.config.js']);
  if (viteLike) {
    const m = viteLike.match(/outDir\s*:\s*['"]([^'"]+)['"]/);
    if (m) return m[1].replace(/^\.\//, '').replace(/\/+$/, '');
  }
  try {
    const ang = JSON.parse(fs.readFileSync(path.join(dir, 'angular.json'), 'utf-8'));
    const proj = ang.projects && Object.values(ang.projects)[0];
    const op = proj && proj.architect && proj.architect.build && proj.architect.build.options && proj.architect.build.options.outputPath;
    if (typeof op === 'string' && op) return op.replace(/^\.\//, '').replace(/\/+$/, '');
  } catch { /* ignore */ }
  for (const d of ['dist', 'build', 'out']) if (fs.existsSync(path.join(dir, d))) return d;
  return 'dist';
}
export function detectBackend(dir) {
  const pkg = readPackage(dir);
  const cands = [];
  if (pkg && pkg.scripts) {
    for (const k of ['start', 'serve', 'server']) {
      const s = pkg.scripts[k];
      if (!s) continue;
      const m = s.trim().match(/^node\s+(.+)$/);
      if (m) {
        const file = m[1].trim().split(/\s+/)[0].replace(/["']/g, '');
        if (fs.existsSync(path.join(dir, file))) cands.push({ cmd: 'node', args: m[1].trim().split(/\s+/), entry: file });
      }
    }
  }
  if (pkg && pkg.main && fs.existsSync(path.join(dir, pkg.main))) cands.push({ cmd: 'node', args: [pkg.main], entry: pkg.main });
  for (const rel of ['server.js', 'app.js', 'src/server.js', 'src/main.server.js', 'backend/index.js', 'backend/server.js', 'server/index.js']) {
    if (fs.existsSync(path.join(dir, rel))) cands.push({ cmd: 'node', args: [rel], entry: rel });
  }
  return cands[0] || null;
}
export function locateFrontend(dir, outName) {
  const tried = new Set();
  const probe = (rel) => {
    if (!rel || tried.has(rel)) return null;
    tried.add(rel);
    return fs.existsSync(path.join(dir, rel, 'index.html')) ? rel : null;
  };
  if (probe(outName)) return outName;
  for (const d of ['dist', 'build', 'out']) if (probe(d)) return d;
  for (const top of ['dist', 'build', 'out']) {
    const base = path.join(dir, top);
    if (!fs.existsSync(base)) continue;
    let subs;
    try { subs = fs.readdirSync(base); } catch { continue; }
    for (const sub of subs) {
      const p = path.join(base, sub);
      try {
        if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'index.html'))) return `${top}/${sub}`;
      } catch { /* ignore */ }
    }
  }
  return probe('public');
}
export function findFrontendDir(dir) { return locateFrontend(dir, null); }

export async function stageBuiltProject(srcDir, name) {
  const pkg = readPackage(srcDir) || {};
  if (!hasBuild(srcDir) || !looksLikeFrontend(srcDir)) {
    return { stage: srcDir, frontend: null, backend: detectBackend(srcDir) };
  }
  await installDeps(srcDir);
  const b = await runApp(parseCommandLine(['npm', 'run', 'build']), srcDir, process.env);
  if (b.status !== 0) throw new Error(`Le build a échoué (code ${b.status}). Vérifiez le log ci-dessus.`);
  const outName = detectBuildOut(srcDir);
  const feRel = locateFrontend(srcDir, outName);
  if (!feRel) {
    return { stage: srcDir, frontend: null, backend: detectBackend(srcDir) };
  }
  const backend = detectBackend(srcDir);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-stage-'));
  fs.mkdirSync(path.join(stage, feRel), { recursive: true });
  fs.cpSync(path.join(srcDir, feRel), path.join(stage, feRel), { recursive: true });
  const baseOut = feRel.split('/')[0];
  const exclusions = ['node_modules/**', '.git/**', `${baseOut}/**`, 'public/**', 'src/**', '.cache/**', 'dist/**', 'build/**', 'out/**', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
  if (backend && backend.entry.startsWith('src/')) exclusions.splice(exclusions.indexOf('src/**'), 1);
  const fg = await loadFg();
  const files = fg.sync(['**/*'], { cwd: srcDir, dot: true, onlyFiles: true, ignore: exclusions, suppressErrors: true });
  for (const rel of files) {
    const to = path.join(stage, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(srcDir, rel), to);
  }
  const rt = { name, version: pkg.version || '0.0.0', private: true };
  if (backend) {
    rt.scripts = { start: shellString(backend) };
    rt.main = backend.entry;
    rt.dependencies = { ...(pkg.dependencies || {}) };
  }
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(rt, null, 2) + '\n');
  return { stage, frontend: outName, backend };
}
