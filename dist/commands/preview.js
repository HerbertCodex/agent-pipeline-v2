import { parseDuration } from '../lock/store.js';
import { DEFAULT_BRANCH, loadPreview, previewLogs, previewStatus, stopPreview, updatePreview, withPreviewLock, } from '../preview/service.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import { localTime } from '../domain/time.js';
export const usage = `Utilisation :
  apv preview update [branche] [--wait 30m] [--repo <chemin>] [--json]
  apv preview status [--repo <chemin>] [--json]
  apv preview stop [--wait 30m] [--repo <chemin>] [--json]
  apv preview logs [--lines 50] [--update] [--repo <chemin>]

Aperçu vivant du projet (section « preview » de .apv/config.json, voir docs/PREVIEW.md).
  update  arrête le serveur d'aperçu, copie la branche (git archive, jamais l'arbre de travail) dans
          un dossier neuf, lance install, migrate, build et seed, démarre le serveur détaché et attend
          sa réponse. Branche par défaut : « preview.branch », sinon ${DEFAULT_BRANCH}. Sous le verrou « preview:<projet> ».
  status  en marche ou non (processus vivant et réponse du contrôle de santé), adresse, branche, commit, durée.
  stop    arrête le serveur d'aperçu (tout son groupe de processus). Sous le verrou « preview:<projet> ».
  logs    dernières lignes du journal du serveur (--update : journal de la dernière mise à jour),
          valeurs du fichier d'environnement masquées.
Un port occupé par un processus qui n'est pas l'aperçu n'est jamais libéré de force : update refuse.
Sortie : 0 succès (status : aperçu en marche), 1 échec ou aperçu arrêté, 2 appel incorrect.`;
function short(commit) { return commit ? commit.slice(0, 7) : '?'; }
function duration(seconds) {
    if (seconds < 60)
        return `${seconds} s`;
    const m = Math.floor(seconds / 60);
    if (m < 60)
        return `${m} min`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} j ${h % 24} h`;
}
function waitSeconds(value) {
    if (value === undefined)
        return 1800;
    try {
        return parseDuration(value, '--wait');
    }
    catch (error) {
        throw new UsageError(error.message);
    }
}
function updateText(result) {
    if (!result.ok) {
        const lines = [`Échec de l'étape « ${result.step} » (branche ${result.branch}${result.commit ? `, commit ${short(result.commit)}` : ''}) : ${result.message}`];
        if (result.excerpt)
            lines.push('', 'Dernières lignes :', result.excerpt, '');
        lines.push(`Journal de la mise à jour : ${result.updateLog}`);
        if (result.step === 'health' || result.step === 'serve')
            lines.push(`Journal du serveur : ${result.logFile}`);
        return { out: '', err: `${lines.join('\n')}\n` };
    }
    const lines = [`aperçu prêt : ${result.url} (branche ${result.branch}, commit ${short(result.commit)})`];
    if (!result.previousCommit)
        lines.push('Premier aperçu enregistré pour ce projet.');
    else if (result.previousCommit === result.commit)
        lines.push(`Aucun nouveau commit depuis l'aperçu précédent (${short(result.previousCommit)}).`);
    else if (!result.changes)
        lines.push(`Changements depuis ${short(result.previousCommit)} : historique indisponible (commit précédent inconnu du dépôt).`);
    else {
        const from = result.previousBranch && result.previousBranch !== result.branch ? `${short(result.previousCommit)}, branche ${result.previousBranch}` : short(result.previousCommit);
        const { total, removed } = result.changes;
        if (total) {
            lines.push(`Changements depuis ${from} : ${total} commit${total > 1 ? 's' : ''}`);
            lines.push(...result.changes.lines.map(l => `  ${l}`));
            if (total > result.changes.lines.length)
                lines.push(`  ... et ${total - result.changes.lines.length} de plus`);
        }
        else
            lines.push(`Aucun nouveau commit depuis ${from}.`);
        if (removed)
            lines.push(`Retour en arrière : ${removed} commit${removed > 1 ? 's' : ''} de l'aperçu précédent (${short(result.previousCommit)}) retiré${removed > 1 ? 's' : ''} de l'aperçu.`);
    }
    lines.push(`Journal du serveur : ${result.logFile}`);
    return { out: `${lines.join('\n')}\n`, err: '' };
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, {
            repo: { type: 'string' }, json: { type: 'boolean' }, wait: { type: 'string' }, lines: { type: 'string' },
            update: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        });
        const [sub, ...rest] = positionals;
        if (values.help || !sub) {
            io.stdout(`${usage}\n`);
            return values.help ? EXIT.ok : EXIT.usage;
        }
        const repo = repoPath(io, values.repo);
        const ctx = { repo, env: io.env, progress: (s) => { if (!values.json)
                io.stderr(s); } };
        const only = (allowed) => {
            for (const name of ['wait', 'lines', 'update']) {
                if (values[name] !== undefined && !allowed.includes(name))
                    throw new UsageError(`option --${name} inattendue pour « ${sub} »`);
            }
        };
        if (sub === 'update') {
            only(['wait']);
            if (rest.length > 1)
                throw new UsageError(`argument inattendu : ${rest.slice(1).join(' ')}`);
            const loaded = loadPreview(repo, io.env);
            const branch = rest[0] ?? loaded.config.branch ?? DEFAULT_BRANCH;
            const result = await withPreviewLock(ctx, waitSeconds(values.wait), `apv preview update ${branch}`, (env) => updatePreview(ctx, loaded, branch, env));
            if (values.json)
                json(io, result);
            else {
                const text = updateText(result);
                if (text.out)
                    io.stdout(text.out);
                if (text.err)
                    io.stderr(text.err);
            }
            return result.ok ? EXIT.ok : EXIT.failed;
        }
        if (sub === 'stop') {
            only(['wait']);
            if (rest.length)
                throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
            const result = await withPreviewLock(ctx, waitSeconds(values.wait), 'apv preview stop', () => stopPreview(repo));
            if (values.json)
                json(io, result);
            else
                io.stdout(result.stopped ? `Aperçu arrêté (groupe de processus ${result.pid}).\n`
                    : result.pid !== null ? `Aucun aperçu en marche (le processus ${result.pid} n'existait plus).\n` : 'Aucun aperçu en marche.\n');
            return EXIT.ok;
        }
        if (sub === 'status') {
            only([]);
            if (rest.length)
                throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
            const status = await previewStatus(repo);
            if (values.json) {
                json(io, status);
                return status.running ? EXIT.ok : EXIT.failed;
            }
            const st = status.state;
            const lines = [];
            if (!st)
                lines.push('Aucun aperçu enregistré pour ce projet (apv preview update pour en créer un).');
            else if (status.running)
                lines.push(`Aperçu en marche : ${st.url} (branche ${st.branch}, commit ${short(st.commit)}), depuis ${duration(status.uptimeSeconds ?? 0)}, pid ${st.pid}.`);
            else if (status.alive)
                lines.push(`Aperçu lancé mais sans réponse sur ${st.healthUrl} : ${st.url} (branche ${st.branch}, commit ${short(st.commit)}), pid ${st.pid}.`);
            else
                lines.push(`Aperçu arrêté. Dernier aperçu : branche ${st.branch}, commit ${short(st.commit)}, démarré le ${localTime(st.startedAt)}${st.stoppedAt ? `, arrêté le ${localTime(st.stoppedAt)}` : ''}.`);
            if (st?.lastFailure)
                lines.push(`Dernier échec : étape « ${st.lastFailure.step} » le ${localTime(st.lastFailure.at)} (branche ${st.lastFailure.branch}) : ${st.lastFailure.message}`);
            io.stdout(`${lines.join('\n')}\n`);
            return status.running ? EXIT.ok : EXIT.failed;
        }
        if (sub === 'logs') {
            only(['lines', 'update']);
            if (values.json)
                throw new UsageError('« logs » n\'a pas de sortie JSON');
            if (rest.length)
                throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
            const count = values.lines === undefined ? 50 : Number(values.lines);
            if (!Number.isSafeInteger(count) || count < 1 || count > 100_000)
                throw new UsageError('--lines attend un entier entre 1 et 100000');
            // No fallback without masking: an unreadable configuration is an error, never an unmasked log.
            const { redactor } = loadPreview(repo, io.env, false);
            const { file, text } = previewLogs(repo, redactor, count, values.update ? 'update' : 'server');
            if (text === null) {
                io.stderr(`Aucun journal : ${file}\n`);
                return EXIT.failed;
            }
            io.stdout(`${text}\n`);
            return EXIT.ok;
        }
        throw new UsageError(`sous-commande inconnue : ${sub}`);
    });
}
//# sourceMappingURL=preview.js.map