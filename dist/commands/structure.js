import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalPath } from '../domain/paths.js';
import { Git } from '../execution/git.js';
import { loadConfig } from '../config/load.js';
import { structureSettings } from '../structure/config.js';
import { analyzeStructure } from '../structure/analyze.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv structure check [--path <dossier>]... [--repo <chemin>] [--json]

Analyse l'arborescence des fichiers de code suivis par Git (jamais les fichiers ignorés) et signale :
  flat-folder      un dossier qui a plus de N fichiers de code directement (défaut 12 ; tests et
                   fichiers compagnons comptés à part) ;
  repeated-prefix  plusieurs fichiers qui partagent un préfixe de domaine (singulier et pluriel rapprochés) ;
  mixed-roles      un dossier qui mêle des rôles (actions, dépôts de données, clients, utilitaires HTTP...)
                   pour plusieurs domaines ;
  stray-file       un fichier dont le préfixe est le nom d'un dossier voisin.
Chaque constat a sa proposition ; le plan de rangement (ancien -> nouveau) n'est jamais appliqué.
--path limite l'analyse à un dossier (relatif à la racine du dépôt) et à ses sous-dossiers ; répétable.
Configuration facultative :
section « structure » de .apv/config.json (roots, maxFlatFiles, roles, domains, ignore, severity).
Sortie : 0 aucun constat de gravité error (par défaut tout est warning), 1 au moins un, 2 appel incorrect.`;
const LABEL = { warning: 'avertissement', error: 'erreur' };
const short = (dir, path) => (dir === '.' ? path : path.slice(dir.length + 1));
/** Tracked files of the repository, as Git lists them (never ignored or untracked files). */
export async function trackedFiles(git, repo) {
    return (await git.exec(repo, ['ls-files', '--cached', '--deduplicate', '-z'])).split('\0').filter(Boolean);
}
export function formatReport(report, scope) {
    const errors = report.findings.filter(f => f.severity === 'error').length;
    const lines = [`Arborescence : ${report.analyzedFiles} fichier(s) de code suivis analysés${scope.length ? ` (dans ${scope.join(', ')})` : ''}, ${report.findings.length} constat(s), dont ${errors} de gravité error.`];
    if (!report.findings.length) {
        lines.push('Aucun constat.');
        return `${lines.join('\n')}\n`;
    }
    for (const folder of report.folders) {
        const dir = folder.folder;
        lines.push('', `${dir}/ : ${folder.code} fichier(s) de code, ${folder.tests} test(s), ${folder.companions} compagnon(s)`);
        for (const f of report.findings.filter(x => x.folder === dir)) {
            lines.push(`  [${LABEL[f.severity]}] ${f.code} : ${f.proposal}${f.code === 'flat-folder' ? '' : ` Fichiers : ${f.files.map(p => short(dir, p)).join(', ')}.`}`);
        }
        // One line per main file; its tests and companion files follow it.
        const moves = report.plan.filter(m => m.from.startsWith(dir === '.' ? '' : `${dir}/`) && !m.from.slice(dir === '.' ? 0 : dir.length + 1).includes('/'));
        const mains = report.findings.filter(f => f.folder === dir).flatMap(f => f.moves);
        const seen = new Set();
        if (mains.length)
            lines.push('  Plan :');
        for (const m of mains) {
            if (seen.has(m.from))
                continue;
            seen.add(m.from);
            const stem = m.from.slice(m.from.lastIndexOf('/') + 1).split('.')[0];
            const others = moves.filter(x => x.from !== m.from && x.from.slice(x.from.lastIndexOf('/') + 1).split('.')[0] === stem);
            lines.push(`    ${short(dir, m.from)} -> ${short(dir, m.to)}${others.length ? ` (avec ${others.map(x => short(dir, x.from)).join(', ')})` : ''}`);
        }
        if (mains.length && folder.unplaced.length)
            lines.push(`  Restent en place, à décider avec l'opérateur : ${folder.unplaced.map(p => short(dir, p)).join(', ')}`);
    }
    lines.push('', report.plan.length
        ? `Plan de rangement : ${report.plan.length} déplacement(s), tests et fichiers compagnons compris (liste complète : --json). Jamais appliqué par apv : à valider avec l'opérateur, puis git mv et imports mis à jour.`
        : 'Aucun déplacement proposé.');
    return `${lines.join('\n')}\n`;
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, {
            path: { type: 'string', multiple: true }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (action !== 'check')
            throw new UsageError(action ? `sous-commande inconnue : structure ${action}` : 'sous-commande manquante');
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        const git = new Git();
        const repo = await git.root(repoPath(io, values.repo));
        const scope = (values.path ?? []).map(p => {
            const rel = relative(repo, canonicalPath(resolve(repo, p))).split('\\').join('/');
            if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
                throw new UsageError(`--path hors du dépôt : ${p}`);
            return rel || '.';
        });
        const settings = structureSettings(loadConfig(repo).config.structure);
        const report = analyzeStructure(await trackedFiles(git, repo), settings, { paths: scope });
        if (values.json)
            json(io, { ...report, repo, paths: scope });
        else
            io.stdout(formatReport(report, scope));
        return report.ok ? EXIT.ok : EXIT.failed;
    });
}
//# sourceMappingURL=structure.js.map