import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { gitRoot } from '../run/git-probe.js';
import { buildCodeMap, codeMapMarkdown } from '../knowledge/code-map.js';
import { mapSettings, reuseSettings } from '../reuse/config.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv map [--check] [--repo <chemin>] [--json]

Écrit la carte du code (.apv/code-map.md, ou map.file) : composants partagés (rôle, props, variantes, où ils
sont utilisés), modules partagés (exports, utilisateurs), routes, et ce qui est propre à une fonctionnalité,
avec les doublons possibles. Construite depuis les fichiers du dépôt (suivis et non suivis, jamais les
ignorés), sans modèle, bornée pour rester lisible par un agent. À commiter avec le code qu'elle décrit.
--check ne l'écrit pas : il la compare à celle qui serait écrite (contrôle de tâche « code-map »).
Configuration facultative : section « map » (file, ignore, maxEntries) ; dossiers partagés : reuse.shared.
Sortie : 0 écrite ou à jour, 1 périmée ou absente (--check) ou configuration invalide, 2 appel incorrect.`;
/** The map of the repository as its configuration describes it, and its Markdown. */
export async function currentMap(repo, config) {
    const settings = mapSettings(config.map);
    const map = await buildCodeMap(repo, reuseSettings(config.reuse), settings);
    return { file: settings.file, map, text: codeMapMarkdown(map, settings) };
}
/** Lines present on one side only (10 at most each): enough to see what went stale. */
function difference(actual, expected) {
    const a = new Set(actual.split('\n'));
    const e = new Set(expected.split('\n'));
    return { onlyInFile: [...a].filter(l => l && !e.has(l)).slice(0, 10), onlyExpected: [...e].filter(l => l && !a.has(l)).slice(0, 10) };
}
/** Writes the map when it changed; with `check`, compares only. */
export async function writeMap(repo, config, check) {
    const { file, map, text } = await currentMap(repo, config);
    const full = join(repo, file);
    const actual = existsSync(full) ? readFileSync(full, 'utf8') : null;
    if (check) {
        if (actual === null)
            return { file, status: 'missing', difference: null, map };
        return actual === text ? { file, status: 'up-to-date', difference: null, map } : { file, status: 'stale', difference: difference(actual, text), map };
    }
    if (actual === text)
        return { file, status: 'unchanged', difference: null, map };
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    return { file, status: 'written', difference: null, map };
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, { check: { type: 'boolean' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        if (positionals.length)
            throw new UsageError(`argument inattendu : ${positionals.join(' ')}`);
        const repo = gitRoot(repoPath(io, values.repo));
        const { config } = loadConfig(repo);
        const result = await writeMap(repo, config, values.check === true);
        const failed = result.status === 'stale' || result.status === 'missing';
        if (values.json) {
            json(io, { ...result, repo });
            return failed ? EXIT.failed : EXIT.ok;
        }
        const m = result.map;
        const counts = `${m.components.filter(c => c.shared).length} composant(s) partagé(s), ${m.modules.filter(x => !x.feature).length} module(s) partagé(s), ${m.routes.length} route(s), ${m.components.filter(c => !c.shared).length + m.modules.filter(x => x.feature).length} élément(s) propre(s) à une fonctionnalité`;
        const lines = [];
        if (result.status === 'written')
            lines.push(`Carte du code écrite : ${result.file} (${counts}). À commiter avec le code qu'elle décrit.`);
        else if (result.status === 'unchanged' || result.status === 'up-to-date')
            lines.push(`Carte du code à jour : ${result.file} (${counts}).`);
        else if (result.status === 'missing')
            lines.push(`Carte du code absente : ${result.file}. Lancez apv map, puis commitez ${result.file}.`);
        else {
            lines.push(`Carte du code périmée : ${result.file} ne correspond plus au code. Lancez apv map, relisez-la, puis commitez ${result.file} avec le changement.`);
            if (result.difference?.onlyExpected.length)
                lines.push('  Attendu, absent de la carte :', ...result.difference.onlyExpected.map(l => `    ${l}`));
            if (result.difference?.onlyInFile.length)
                lines.push('  Dans la carte, plus attendu :', ...result.difference.onlyInFile.map(l => `    ${l}`));
        }
        const clashes = m.components.flatMap(c => c.clashes);
        if (clashes.length && !failed)
            lines.push(`Doublons possibles signalés dans la carte : ${clashes.length} (${clashes.slice(0, 3).map(c => `${c.path} ~ ${c.with}`).join(', ')}${clashes.length > 3 ? ', …' : ''}).`);
        io.stdout(`${lines.join('\n')}\n`);
        return failed ? EXIT.failed : EXIT.ok;
    });
}
//# sourceMappingURL=map.js.map