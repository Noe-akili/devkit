import fs from 'fs';
import path from 'path';
import { createInterface } from 'node:readline';
import { ttyCols, stripAnsi, wrapAnsi, appEnv, runApp, parseCommandLine, loadState, offlineRequested } from './core.js';
import { dkFileFor, readHeader, ensureExtracted, loadManifest, listApps, resolveAppRef } from './dk.js';
import { sharedNodeModules, installDeps } from './deps.js';
import { findFreePort, runStaticServer } from './static.js';
import { findFrontendDir } from './build.js';
import { diagnose, applyFix } from './repair.js';

// CHEMIN ULTRA-RAPIDE : devkit run (aucune dépendance externe)
export async function fastRun(rest) {
  const noInstall = rest.includes('--no-install');
  const offline = offlineRequested();
  const args = rest.filter(a => a != null && !String(a).startsWith('-'));
  const nameArg = args[0] || '';
  const extra = args.slice(1);
  const R = '\x1b[31m', C = '\x1b[36m', G = '\x1b[32m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';
  if (offline && !noInstall) console.log(`${D}⚡ Mode offline : aucune installation réseau ne sera tentée.${X}`);

  let name = '';
  if (nameArg) {
    const resolved = resolveAppRef(nameArg);
    if (resolved === null) {
      console.log(`${R}✗ Aucune app numéro ${nameArg}.${X}`);
      const apps = listApps();
      if (apps.length) console.log(`  ${D}Disponibles:${X} ${apps.map(a => `${C}${a.index}${X} ${B}${a.name}${X}`).join(', ')}`);
      console.log('');
      return 1;
    }
    name = resolved;
  } else if (process.stdin.isTTY) {
    const apps = listApps();
    if (apps.length === 0) { console.log(`${R}✗ Aucune app .dk. Utilise: ${B}devkit add <chemin|url-git>${X}\n`); return 1; }
    console.log(`${C}${B}🗂️${X} ${D}Choisissez une app à lancer :${X}`);
    for (const a of apps) console.log(`  ${C}${String(a.index).padStart(2, '0')}${X}  ${B}${a.name}${X}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise(res => rl.question(`\n${C}${B}▸${X} ${D}Numéro :${X} `, res));
    rl.close();
    const resolved = resolveAppRef(ans.trim());
    if (!resolved) { console.log(`${R}✗ Choix invalide.${X}\n`); return 1; }
    name = resolved;
  } else {
    console.log(`${R}✗ Nom d'app manquant. Utilise: ${B}devkit run <nom|numéro>${X}\n`); return 1;
  }

  const file = dkFileFor(name);
  if (!fs.existsSync(file)) { console.log(`${R}✗ App "${name}" introuvable. Utilise: ${B}devkit list${X}\n`); return 1; }

  let h;
  try { h = readHeader(file); } catch (e) { console.log(`${R}✗ ${e.message}${X}\n`); return 1; }

  const dir = await ensureExtracted(file, h, null);
  try {
    const manifest = loadManifest(dir);
    const st = loadState(h.name);
    manifest.env = { ...(manifest.env || {}), ...(st.env || {}) };
    if (manifest.run && !noInstall && manifest.needDeps && !sharedNodeModules(dir) && !offline) {
      await installDeps(dir);
    }

    if (!manifest.run) {
      let fe = (typeof h.frontend === 'string' && h.frontend) ? h.frontend : null;
      if (fe && !fs.existsSync(path.join(dir, fe, 'index.html'))) fe = null;
      if (!fe) fe = findFrontendDir(dir);
      if (!fe && fs.existsSync(path.join(dir, 'index.html'))) fe = '';
      if (fe !== null) {
        const port = await findFreePort(parseInt(process.env.PORT, 10) || 8080);
        const webroot = path.join(dir, fe);
        const url = `http://localhost:${port}`;
        const t = `${B}${h.name}${X} ${D}v${h.version}${X} ${D}(frontend statique)${X}`;
        const cw = Math.min(ttyCols(), Math.max(10, stripAnsi(t).length + 4, url.length + 8));
        const inner = cw - 2;
        const textW = inner - 1;
        const fill = (s) => `${C}│${X} ${s}${' '.repeat(Math.max(1, textW - stripAnsi(s).length))}${C}│${X}`;
        console.log(`${C}╭${'─'.repeat(inner)}╮`);
        console.log(fill(t));
        for (const seg of wrapAnsi(`${B}${url}${X}`, textW)) console.log(fill(seg));
        console.log(`${C}╰${'─'.repeat(inner)}╯`);
        console.log(`${D}Ctrl+C pour arrêter.${X}\n`);
        return (await runStaticServer(webroot, port)).status;
      }
      console.log(`${R}✗ Aucune commande de lancement ni de frontend détecté dans "${h.name}"${X}\n`);
      return 1;
    }

    const full = [manifest.run, ...extra].join(' ');
    const t = `${B}${h.name}${X} ${D}v${h.version}${X}`;
    const cw = Math.min(ttyCols(), Math.max(10, stripAnsi(t).length + 4, full.length + 4));
    const inner = cw - 2;
    const textW = inner - 1;
    const fill = (s) => `${C}│${X} ${s}${' '.repeat(Math.max(1, textW - stripAnsi(s).length))}${C}│${X}`;
    console.log(`${C}╭${'─'.repeat(inner)}╮`);
    console.log(fill(t));
    for (const seg of wrapAnsi(`${B}${full}${X}`, textW)) console.log(fill(seg));
    console.log(`${C}╰${'─'.repeat(inner)}╯`);

    const res = await runApp(parseCommandLine([manifest.run, ...extra]), dir, appEnv(manifest));
    if (res.error) { console.log(`${R}✗ ${res.error.message}${X}\n`); return 1; }
    let repairs = 0;
    const MAX_REPAIRS = 5;
    const ctx = { dir, manifest, extra, name: h.name };
    while (res.status !== 0 && repairs < MAX_REPAIRS) {
      const diag = diagnose(res.log);
      if (!diag) break;
      console.log(`\n${C}${B}⚕️${X} ${D}Auto-diagnostic${X} ${C}(${repairs + 1}/${MAX_REPAIRS})${X}${D}:${X} ${diag.msg}`);
      if (diag.hard) {
        console.log(`${R}✗ ${diag.msg}${X} ${D}(non réparable automatiquement)${X}\n`);
        return 1;
      }
      if ((noInstall || offline) && diag.needsInstall) {
        console.log(`${R}✗ Réparation impossible en mode ${B}${noInstall ? '--no-install' : 'offline'}${X}${R}. Réessayez avec le réseau, ou empaquetez avec ${B}devkit pack --bundle${X}${R}.${X}\n`);
        return 1;
      }
      console.log(`${C}${B}🛠️${X} ${D}Réparation automatique en cours…${X}`);
      const ok = await applyFix(diag, ctx);
      if (!ok) {
        console.log(`${R}✗ La réparation "${diag.id}" a échoué.${X}`);
        if (diag.id === 'port-in-use') {
          console.log(`${D}💡 Le processus occupant le port n'est pas identifiable (permissions /proc restreintes). À la main:${X}`);
          console.log(`${D}   ${C}lsof -iTCP:<port>${X}${D} puis ${C}kill <pid>${X}`);
        }
        console.log(`\n`);
        return 1;
      }
      repairs++;
      console.log(`${G}${B}✅${X} ${D}Réparation "${diag.id}" appliquée, relance de l'app…${X}\n`);
      res.status = (await runApp(parseCommandLine([manifest.run, ...extra]), dir, appEnv(manifest))).status;
    }
    if (res.status !== 0 && repairs >= MAX_REPAIRS) {
      console.log(`${R}✗ ${MAX_REPAIRS} réparations tentées sans succès.${X} ${D}Relancez pour réinitialiser, ou lancez ${C}devkit info ${name}${X}${D} pour inspecter le package.${X}\n`);
    }
    return res.status;
  } finally {
  }
}
