import { resolve } from 'node:path';
import { PipelineError } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { specSchema } from '../lifecycle/contracts.js';
import { scopeReport } from '../policy/policy.js';
import { readSpecDocument } from '../spec/check.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv scope check --spec <fichier> --task <id> [--base <ref>] [--repo <chemin>] [--json]

Compare les fichiers modifiés depuis la base (point de divergence entre <ref> et HEAD, main ou
master par défaut) aux chemins autorisés de la tâche. Les modifications non commitées ne sont
pas vérifiées : elles sont signalées. Sortie : 0 dans le périmètre, 1 hors périmètre, 2 appel incorrect.`;
/** Paths of `git status --porcelain=v1 -z`; a rename or copy entry is followed by its source path. */
export function porcelainPaths(output) {
    const entries = output.split('\0').filter(Boolean);
    const paths = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        paths.push(entry.slice(3));
        if (/^[RC]/.test(entry))
            i++;
    }
    return paths;
}
/** Default base: the first integration branch that exists. */
async function defaultBase(git, repo) {
    for (const ref of ['main', 'master']) {
        try {
            await git.sha(repo, ref);
            return ref;
        }
        catch { /* try the next one */ }
    }
    throw new UsageError('aucune branche main ni master : précisez --base <ref>');
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, {
            spec: { type: 'string' }, task: { type: 'string' }, base: { type: 'string' }, repo: { type: 'string' },
            json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (action !== 'check')
            throw new UsageError(action ? `sous-commande inconnue : scope ${action}` : 'sous-commande manquante');
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        if (!values.spec)
            throw new UsageError('--spec manquant');
        if (!values.task)
            throw new UsageError('--task manquant');
        let spec;
        try {
            spec = specSchema.parse(readSpecDocument(resolve(io.cwd, values.spec)).spec);
        }
        catch (error) {
            if (error instanceof PipelineError)
                throw new UsageError(`spec illisible (${error.code}) : ${error.message}. Vérifiez-la avec apv spec validate.`);
            throw error;
        }
        const task = spec.tasks.find(t => t.id === values.task);
        if (!task)
            throw new UsageError(`tâche inconnue : ${values.task} (tâches : ${spec.tasks.map(t => t.id).join(', ') || 'aucune'})`);
        const git = new Git();
        const repo = await git.root(repoPath(io, values.repo));
        const base = values.base ?? await defaultBase(git, repo);
        const head = await git.sha(repo);
        const mergeBase = (await git.exec(repo, ['merge-base', await git.sha(repo, base), head])).trim();
        const changes = await git.changes(repo, mergeBase, head);
        const report = scopeReport(changes, task);
        const uncommitted = porcelainPaths(await git.exec(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
        const ok = report.rejected.length === 0 && !report.tooManyNew;
        if (values.json) {
            json(io, { ok, task: task.id, base, mergeBase, head, allowedPaths: task.allowedPaths, files: changes.files, outOfScope: report.rejected, uncommitted });
        }
        else {
            const lines = [`Tâche ${task.id} : ${changes.files.length} fichier(s) modifié(s) entre ${base} (${mergeBase.slice(0, 12)}) et HEAD (${head.slice(0, 12)})`,
                `Chemins autorisés : ${task.allowedPaths.join(', ')}`];
            lines.push(ok ? 'Dans le périmètre.' : `Hors périmètre (${report.rejected.length}) :`, ...report.rejected.map(f => `- ${f}`));
            if (uncommitted.length)
                lines.push(`Attention : ${uncommitted.length} modification(s) non commitée(s) non vérifiée(s) : ${uncommitted.slice(0, 10).join(', ')}${uncommitted.length > 10 ? ', ...' : ''}`);
            io.stdout(`${lines.join('\n')}\n`);
        }
        return ok ? EXIT.ok : EXIT.failed;
    });
}
//# sourceMappingURL=scope.js.map