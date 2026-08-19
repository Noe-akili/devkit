#!/usr/bin/env node
// devkit — point d'entrée
// Chemin ultra-rapide pour `run` (aucune dépendance externe chargée),
// CLI complète (commander/chalk) chargée uniquement pour les autres commandes.

const _args = process.argv.slice(2);
const _flags = [];
while (_args[0] === '--offline') { _flags.push(_args.shift()); }
if (_args[0] === 'run' && !_args.some(a => ['-h', '--help', '-V', '--version'].includes(a))) {
  const { fastRun } = await import('./lib/fastrun.js');
  process.exit(await fastRun(_args.slice(1)));
}

const { main } = await import('./lib/cli.js');
await main();
