import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { PipelineError } from '../domain/errors.js';
import { loadConfig } from '../config/load.js';
import { gitRoot } from '../run/git-probe.js';
import { buildCodeMap, codeMapMarkdown } from '../knowledge/code-map.js';
import { mapSettings, reuseSettings } from '../reuse/config.js';
import { worktreeFiles } from '../knowledge/inventory.js';
import { structureSettings } from '../structure/config.js';
import { analyzeStructure } from '../structure/analyze.js';
import { usageFromMap } from '../structure/split.js';
import { architectureMap } from '../structure/map-file.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv map [--check] [--repo <chemin>] [--json]

Écrit la carte du code (.apv/code-map.md, ou map.file) : composants partagés (rôle, props, variantes, où ils
sont utilisés), modules partagés (exports, utilisateurs), routes, et ce qui est propre à une fonctionnalité,
avec les doublons possibles. Construite depuis les fichiers du dépôt (suivis et non suivis, jamais les
ignorés), sans modèle, bornée pour rester lisible par un agent. À commiter avec le code qu'elle décrit.
--check ne l'écrit pas : il la compare à celle qui serait écrite (contrôle de tâche « code-map ») ; les comptes
« Laissés de côté » (tests, fichiers ignorés, modules muets) ne sont pas comparés. L'implementer la régénère
et la commite dans son commit ; un conflit de fusion sur elle se résout par apv map, jamais à la main.
La carte de l'architecture (structure.architectureMap, par défaut docs/carte-architecture.md), quand elle
existe, suit : ses parties générées sont réécrites (ou comparées avec --check), ses parties écrites jamais.
La carte du code nomme aussi les dossiers à plat et les sous-dossiers proposés pour chacun.
Configuration facultative : section « map » (file, ignore, maxEntries) ; dossiers partagés : reuse.shared.
Sortie : 0 écrite ou à jour, 1 périmée ou absente (--check) ou configuration invalide, 2 appel incorrect.`;
/** The clause of the summary line that counts what the map leaves out (tests, ignored files, silent modules). */
const SKIPPED_CLAUSE = /Laissés de côté : \d+ test\(s\), \d+ fichier\(s\) ignoré\(s\), \d+ module\(s\) sans export ni import\./g;
/**
 * The text of a map as `--check` compares it: the counts « Laissés de côté » are left out. They count what the map does
 * not describe (tests, ignored files, modules without export nor import): a test file added or removed changed them and
 * made a correct map « stale » (pilot project, 3 October 2026), for a line that says nothing of the architecture.
 */
export function comparableMap(text) {
    return text.replace(SKIPPED_CLAUSE, 'Laissés de côté : non comparés.');
}
/**
 * The map of the repository as its configuration describes it, and its Markdown, with the analysis of the tree it
 * reflects (flat folders and their proposed subfolders, from the import graph of the map).
 */
export async function currentMap(repo, config) {
    const settings = mapSettings(config.map);
    const map = await buildCodeMap(repo, reuseSettings(config.reuse), settings);
    const files = await worktreeFiles(repo);
    const structure = structureSettings(config.structure);
    const usage = usageFromMap(map);
    const tree = analyzeStructure(files, structure, { usage });
    const crowded = tree.findings.filter(f => f.code === 'flat-folder').map(f => ({ folder: f.folder, code: f.files.length, groups: (f.groups ?? []).map(g => g.dir) }));
    return { file: settings.file, map, files, tree, usage, text: codeMapMarkdown(map, settings, { architectureMap: structure.architectureMap, maxFlatFiles: structure.maxFlatFiles, crowded }) };
}
/** Lines present on one side only (10 at most each): enough to see what went stale. */
function difference(actual, expected) {
    const a = new Set(actual.split('\n'));
    const e = new Set(expected.split('\n'));
    return { onlyInFile: [...a].filter(l => l && !e.has(l)).slice(0, 10), onlyExpected: [...e].filter(l => l && !a.has(l)).slice(0, 10) };
}
/**
 * The map file, checked before any read or write: no component of its path (from the repository root) may be a symbolic
 * link, it must stay inside the repository once resolved, and an existing file must be a regular file. A map linked to a
 * file outside the repository is never read into the output or the receipts, nor overwritten.
 */
export function mapPath(repo, file) {
    const root = realpathSync(repo);
    let current = repo;
    for (const part of file.split('/')) {
        current = join(current, part);
        let stat;
        try {
            stat = lstatSync(current);
        }
        catch {
            break;
        }
        if (stat.isSymbolicLink())
            throw new PipelineError('MAP_PATH', `${file} : ${relative(repo, current) || part} est un lien symbolique ; la carte du code s'écrit dans le dépôt, jamais à travers un lien. Retirez le lien (ou changez map.file), puis relancez apv map.`);
    }
    const full = join(repo, file);
    let parent = dirname(full);
    while (!existsSync(parent))
        parent = dirname(parent);
    const real = realpathSync(parent);
    if (real !== root && !real.startsWith(`${root}${sep}`))
        throw new PipelineError('MAP_PATH', `${file} sort du dépôt une fois résolu (${real}).`);
    if (existsSync(full) && !lstatSync(full).isFile())
        throw new PipelineError('MAP_PATH', `${file} n'est pas un fichier ordinaire.`);
    return full;
}
/** Writes the map when it changed, atomically (temporary file created exclusively, then renamed); with `check`, compares only. */
export async function writeMap(repo, config, check) {
    const current = await currentMap(repo, config);
    const { file, map, text } = current;
    // The architecture map, when the project has one: its generated parts follow the code as the code map does.
    const architecture = await architectureMap(repo, config, { check, create: false, current });
    const done = (result) => ({ ...result, map, architecture });
    const full = mapPath(repo, file);
    const actual = existsSync(full) ? readFileSync(full, 'utf8') : null;
    if (check) {
        if (actual === null)
            return done({ file, status: 'missing', difference: null });
        if (actual === text)
            return done({ file, status: 'up-to-date', difference: null });
        if (comparableMap(actual) === comparableMap(text))
            return done({ file, status: 'up-to-date', difference: null, skippedOnly: true });
        // No « Dossiers » section: a map written before 3.0.0-alpha.11, stale by the update of APV itself (whatever else changed).
        return done({ file, status: 'stale', difference: difference(actual, text), ...(!/\n## Dossiers\n/.test(actual) && /\n## Dossiers\n/.test(text) ? { migration: true } : {}) });
    }
    if (actual === text)
        return done({ file, status: 'unchanged', difference: null });
    writeAtomically(repo, file, text);
    return done({ file, status: 'written', difference: null });
}
/** Writes a file of the repository atomically (temporary file created exclusively, then renamed), never through a link. */
export function writeAtomically(repo, file, text) {
    const full = mapPath(repo, file);
    mkdirSync(dirname(full), { recursive: true });
    mapPath(repo, file);
    const temporary = `${full}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        writeFileSync(temporary, text, { flag: 'wx' });
        renameSync(temporary, full);
    }
    catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
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
        const architectureFailed = result.architecture.status === 'stale';
        const failed = result.status === 'stale' || result.status === 'missing' || architectureFailed;
        if (values.json) {
            json(io, { ...result, repo });
            return failed ? EXIT.failed : EXIT.ok;
        }
        const m = result.map;
        const counts = `${m.components.filter(c => c.shared).length} composant(s) partagé(s), ${m.modules.filter(x => !x.feature).length} module(s) partagé(s), ${m.routes.length} route(s), ${m.components.filter(c => !c.shared).length + m.modules.filter(x => x.feature).length} élément(s) propre(s) à une fonctionnalité`;
        const lines = [];
        if (result.status === 'written')
            lines.push(`Carte du code écrite : ${result.file} (${counts}). À commiter avec le code qu'elle décrit.`);
        else if (result.status === 'unchanged' || result.status === 'up-to-date') {
            lines.push(`Carte du code à jour : ${result.file} (${counts})${result.skippedOnly ? ' ; seuls les comptes « Laissés de côté » diffèrent, non comparés (apv map les actualise)' : ''}.`);
        }
        else if (result.status === 'missing')
            lines.push(`Carte du code absente : ${result.file}. Lancez apv map, puis commitez ${result.file}.`);
        else if (result.migration) {
            lines.push(`Carte du code périmée par la mise à jour d'APV (3.0.0-alpha.11 : nouvelle section « Dossiers », dossiers à plat et sous-dossiers proposés), pas par le code : lancez apv map une fois après la mise à jour, puis commitez ${result.file} (PR à part).`);
        }
        else {
            lines.push(`Carte du code périmée : ${result.file} ne correspond plus au code. Lancez apv map, relisez-la, puis commitez ${result.file} avec le changement.`);
            if (result.difference?.onlyExpected.length)
                lines.push('  Attendu, absent de la carte :', ...result.difference.onlyExpected.map(l => `    ${l}`));
            if (result.difference?.onlyInFile.length)
                lines.push('  Dans la carte, plus attendu :', ...result.difference.onlyInFile.map(l => `    ${l}`));
        }
        const a = result.architecture;
        if (a.status === 'written')
            lines.push(`Carte de l'architecture mise à jour (parties générées) : ${a.file}. À commiter avec le code.`);
        else if (a.status === 'unchanged' || a.status === 'up-to-date')
            lines.push(`Carte de l'architecture à jour : ${a.file}.`);
        else if (a.status === 'stale') {
            lines.push(`Carte de l'architecture périmée : ses parties générées ne correspondent plus au code (${a.file}). Lancez apv map, puis commitez-la.`);
            if (a.difference?.onlyExpected.length)
                lines.push('  Attendu, absent de la carte :', ...a.difference.onlyExpected.map(l => `    ${l}`));
        }
        const clashes = m.components.flatMap(c => c.clashes);
        if (clashes.length && !failed)
            lines.push(`Doublons possibles signalés dans la carte : ${clashes.length} (${clashes.slice(0, 3).map(c => `${c.path} ~ ${c.with}`).join(', ')}${clashes.length > 3 ? ', …' : ''}).`);
        io.stdout(`${lines.join('\n')}\n`);
        return failed ? EXIT.failed : EXIT.ok;
    });
}
//# sourceMappingURL=map.js.map