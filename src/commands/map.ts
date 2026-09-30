import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { PipelineError } from '../domain/errors.js';
import { loadConfig } from '../config/load.js';
import { gitRoot } from '../run/git-probe.js';
import { buildCodeMap, codeMapMarkdown, type CodeMap } from '../knowledge/code-map.js';
import { mapSettings, reuseSettings, type MapSection, type ReuseSection } from '../reuse/config.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv map [--check] [--repo <chemin>] [--json]

Écrit la carte du code (.apv/code-map.md, ou map.file) : composants partagés (rôle, props, variantes, où ils
sont utilisés), modules partagés (exports, utilisateurs), routes, et ce qui est propre à une fonctionnalité,
avec les doublons possibles. Construite depuis les fichiers du dépôt (suivis et non suivis, jamais les
ignorés), sans modèle, bornée pour rester lisible par un agent. À commiter avec le code qu'elle décrit.
--check ne l'écrit pas : il la compare à celle qui serait écrite (contrôle de tâche « code-map »).
Configuration facultative : section « map » (file, ignore, maxEntries) ; dossiers partagés : reuse.shared.
Sortie : 0 écrite ou à jour, 1 périmée ou absente (--check) ou configuration invalide, 2 appel incorrect.`;

export interface MapResult { file: string; status: 'written' | 'unchanged' | 'up-to-date' | 'stale' | 'missing'; difference: { onlyInFile: string[]; onlyExpected: string[] } | null }

/** The map of the repository as its configuration describes it, and its Markdown. */
export async function currentMap(repo: string, config: { reuse?: ReuseSection | undefined; map?: MapSection | undefined }): Promise<{ file: string; map: CodeMap; text: string }> {
  const settings = mapSettings(config.map);
  const map = await buildCodeMap(repo, reuseSettings(config.reuse), settings);
  return { file: settings.file, map, text: codeMapMarkdown(map, settings) };
}

/** Lines present on one side only (10 at most each): enough to see what went stale. */
function difference(actual: string, expected: string): { onlyInFile: string[]; onlyExpected: string[] } {
  const a = new Set(actual.split('\n')); const e = new Set(expected.split('\n'));
  return { onlyInFile: [...a].filter(l => l && !e.has(l)).slice(0, 10), onlyExpected: [...e].filter(l => l && !a.has(l)).slice(0, 10) };
}

/**
 * The map file, checked before any read or write: no component of its path (from the repository root) may be a symbolic
 * link, it must stay inside the repository once resolved, and an existing file must be a regular file. A map linked to a
 * file outside the repository is never read into the output or the receipts, nor overwritten.
 */
export function mapPath(repo: string, file: string): string {
  const root = realpathSync(repo);
  let current = repo;
  for (const part of file.split('/')) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch { break; }
    if (stat.isSymbolicLink()) throw new PipelineError('MAP_PATH', `${file} : ${relative(repo, current) || part} est un lien symbolique ; la carte du code s'écrit dans le dépôt, jamais à travers un lien. Retirez le lien (ou changez map.file), puis relancez apv map.`);
  }
  const full = join(repo, file);
  let parent = dirname(full);
  while (!existsSync(parent)) parent = dirname(parent);
  const real = realpathSync(parent);
  if (real !== root && !real.startsWith(`${root}${sep}`)) throw new PipelineError('MAP_PATH', `${file} sort du dépôt une fois résolu (${real}).`);
  if (existsSync(full) && !lstatSync(full).isFile()) throw new PipelineError('MAP_PATH', `${file} n'est pas un fichier ordinaire.`);
  return full;
}

/** Writes the map when it changed, atomically (temporary file created exclusively, then renamed); with `check`, compares only. */
export async function writeMap(repo: string, config: { reuse?: ReuseSection | undefined; map?: MapSection | undefined }, check: boolean): Promise<MapResult & { map: CodeMap }> {
  const { file, map, text } = await currentMap(repo, config);
  const full = mapPath(repo, file);
  const actual = existsSync(full) ? readFileSync(full, 'utf8') : null;
  if (check) {
    if (actual === null) return { file, status: 'missing', difference: null, map };
    return actual === text ? { file, status: 'up-to-date', difference: null, map } : { file, status: 'stale', difference: difference(actual, text), map };
  }
  if (actual === text) return { file, status: 'unchanged', difference: null, map };
  mkdirSync(dirname(full), { recursive: true });
  mapPath(repo, file);
  const temporary = `${full}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, full);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { file, status: 'written', difference: null, map };
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, { check: { type: 'boolean' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    if (positionals.length) throw new UsageError(`argument inattendu : ${positionals.join(' ')}`);
    const repo = gitRoot(repoPath(io, values.repo));
    const { config } = loadConfig(repo);
    const result = await writeMap(repo, config, values.check === true);
    const failed = result.status === 'stale' || result.status === 'missing';
    if (values.json) { json(io, { ...result, repo }); return failed ? EXIT.failed : EXIT.ok; }
    const m = result.map;
    const counts = `${m.components.filter(c => c.shared).length} composant(s) partagé(s), ${m.modules.filter(x => !x.feature).length} module(s) partagé(s), ${m.routes.length} route(s), ${m.components.filter(c => !c.shared).length + m.modules.filter(x => x.feature).length} élément(s) propre(s) à une fonctionnalité`;
    const lines: string[] = [];
    if (result.status === 'written') lines.push(`Carte du code écrite : ${result.file} (${counts}). À commiter avec le code qu'elle décrit.`);
    else if (result.status === 'unchanged' || result.status === 'up-to-date') lines.push(`Carte du code à jour : ${result.file} (${counts}).`);
    else if (result.status === 'missing') lines.push(`Carte du code absente : ${result.file}. Lancez apv map, puis commitez ${result.file}.`);
    else {
      lines.push(`Carte du code périmée : ${result.file} ne correspond plus au code. Lancez apv map, relisez-la, puis commitez ${result.file} avec le changement.`);
      if (result.difference?.onlyExpected.length) lines.push('  Attendu, absent de la carte :', ...result.difference.onlyExpected.map(l => `    ${l}`));
      if (result.difference?.onlyInFile.length) lines.push('  Dans la carte, plus attendu :', ...result.difference.onlyInFile.map(l => `    ${l}`));
    }
    const clashes = m.components.flatMap(c => c.clashes);
    if (clashes.length && !failed) lines.push(`Doublons possibles signalés dans la carte : ${clashes.length} (${clashes.slice(0, 3).map(c => `${c.path} ~ ${c.with}`).join(', ')}${clashes.length > 3 ? ', …' : ''}).`);
    io.stdout(`${lines.join('\n')}\n`);
    return failed ? EXIT.failed : EXIT.ok;
  });
}
