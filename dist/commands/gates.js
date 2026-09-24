import { relative } from 'node:path';
import { loadConfig } from '../config/load.js';
import { gateStages } from '../domain/contracts.js';
import { runGates } from '../gates/run.js';
import { verifyGates } from '../gates/verify.js';
import { EXIT, UsageError, guard, json, list, parse, repoPath, table } from './common.js';
export const usage = `Utilisation :
  apv gates run [--stage task|full] [--only a,b] [--config <fichier>] [--base <ref>]
                [--concurrency N] [--keep-going] [--repo <chemin>] [--json]
  apv gates verify --commit <sha> [--stage full|task] [--config <fichier>] [--repo <chemin>] [--json]

run : exécute les contrôles déclarés (.apv/config.json, sinon pipeline.v2.json) dans le dépôt :
dépendances, ressources, variables transmises, délais et masquage des secrets respectés.
Écrit un reçu JSON par contrôle dans .apv/receipts/<exécution>/ et affiche un tableau.
--stage task n'exécute que les contrôles de stage task (champ absent : task) ; les contrôles
de stage full sont listés comme réservés à la suite complète, jamais comptés comme réussis.
--stage full (défaut) exécute tout.
Sortie : 0 si tous les contrôles exécutés passent, 1 sinon, 2 appel incorrect.

verify : vérifie dans les reçus que chaque contrôle exigé (tous avec --stage full, le défaut ;
ceux de stage task avec --stage task) a réussi sur ce commit exact, arbre propre, avec la
configuration actuelle ; pour chaque contrôle, seul son reçu le plus récent compte.
Sortie : 0 preuve complète, 1 sinon (ce qui manque est listé), 2 appel incorrect.`;
const STATUS = { passed: 'réussi', failed: 'échec', timed_out: 'délai dépassé', cancelled: 'annulé',
    spawn_error: 'non lancé', blocked: 'bloqué', cached: 'réutilisé' };
const RESERVED = 'réservé à la suite complète';
const EVIDENCE = { passed: 'réussi', failed: 'échec', dirty: 'arbre modifié', missing: 'aucun reçu' };
function stageOf(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || !gateStages.includes(value))
        throw new UsageError(`--stage attend ${gateStages.join(' ou ')}`);
    return value;
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, {
            only: { type: 'string' }, config: { type: 'string' }, base: { type: 'string' }, concurrency: { type: 'string' },
            stage: { type: 'string' }, commit: { type: 'string' },
            'keep-going': { type: 'boolean' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (action !== 'run' && action !== 'verify')
            throw new UsageError(action ? `sous-commande inconnue : gates ${action}` : 'sous-commande manquante');
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        const stage = stageOf(values.stage);
        if (action === 'verify') {
            const extra = ['only', 'base', 'concurrency', 'keep-going'].filter(k => values[k] !== undefined);
            if (extra.length)
                throw new UsageError(`option de gates run seulement : --${extra.join(', --')}`);
            if (!values.commit)
                throw new UsageError('gates verify attend --commit <sha>');
            const repo = repoPath(io, values.repo);
            const loaded = loadConfig(repo, values.config);
            const result = await verifyGates({ repo, config: loaded.config, commit: values.commit, ...(stage ? { stage } : {}) });
            if (values.json) {
                json(io, { ok: result.ok, commit: result.commit, stage: result.stage, config: loaded.file, configHash: result.configHash,
                    required: result.required, gates: result.gates, unreadable: result.unreadable,
                    missing: result.gates.filter(g => g.state !== 'passed').map(g => g.gateId) });
            }
            else {
                const what = result.stage === 'full' ? 'suite complète' : 'contrôles de tâche';
                const lines = [`Vérification (${what}) au commit ${result.commit.slice(0, 12)}`, '',
                    table(['contrôle', 'état', 'reçu'], result.gates.map(g => [g.gateId,
                        g.state === 'failed' ? `${EVIDENCE.failed} (${STATUS[g.status] ?? g.status})` : EVIDENCE[g.state],
                        g.receipt ? `${g.runId}/${g.gateId}.json` : '-']))];
                const other = result.gates.filter(g => g.otherConfig > 0 && g.state !== 'passed');
                if (other.length)
                    lines.push('', `Reçus ignorés (configuration des contrôles différente) : ${other.map(g => g.gateId).join(', ')}`);
                if (result.unreadable.length)
                    lines.push('', `Reçus illisibles ignorés : ${result.unreadable.join(', ')}`);
                const missing = result.gates.filter(g => g.state !== 'passed');
                lines.push('', result.ok
                    ? `Preuve complète : ${result.required.length} contrôle(s) réussi(s) sur ce commit, arbre propre.`
                    : `Preuve incomplète. Manque : ${missing.map(g => `${g.gateId} (${EVIDENCE[g.state]})`).join(', ')}. ` +
                        `Relancer : apv gates run --stage ${result.stage} sur ce commit, arbre propre.`);
                io.stdout(`${lines.join('\n')}\n`);
            }
            return result.ok ? EXIT.ok : EXIT.failed;
        }
        if (values.commit !== undefined)
            throw new UsageError('--commit est une option de gates verify');
        const concurrency = values.concurrency === undefined ? 3 : Number(values.concurrency);
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
            throw new UsageError('--concurrency attend un entier entre 1 et 16');
        const repo = repoPath(io, values.repo);
        const loaded = loadConfig(repo, values.config);
        const result = await runGates({ repo, config: loaded.config, only: list(values.only), concurrency, failFast: !values['keep-going'], env: io.env,
            ...(values.base ? { base: values.base } : {}), ...(stage ? { stage } : {}) });
        const rows = result.receipts.map(r => ({ gate: r.gateId, status: r.status, exitCode: r.exitCode, durationMs: Math.round(r.durationMs), receipt: r.id,
            diagnostic: r.diagnostic }));
        if (values.json) {
            json(io, { ok: result.ok, runId: result.runId, candidateSha: result.candidateSha, baseSha: result.baseSha, dirty: result.dirty,
                stage: result.stage, config: loaded.file, legacyConfig: loaded.legacy, ignoredSections: loaded.ignored, added: result.added,
                reserved: result.reserved, receiptsDirectory: result.directory, gates: rows });
        }
        else {
            const lines = [`${result.stage === 'task' ? 'Contrôles de tâche (--stage task)' : 'Contrôles'} à ${result.candidateSha.slice(0, 12)} (configuration : ${loaded.file ? relative(result.repo, loaded.file) || loaded.file : 'aucune'}${loaded.legacy ? ', format V2' : ''})`];
            if (result.added.length)
                lines.push(`Dépendances ajoutées : ${result.added.join(', ')}`);
            if (result.dirty)
                lines.push('Attention : modifications non commitées présentes ; les reçus décrivent plus que le commit.');
            lines.push('', table(['contrôle', 'statut', 'code', 'durée'], [
                ...rows.map(r => [r.gate, STATUS[r.status] ?? r.status, r.exitCode === null ? '-' : String(r.exitCode), `${(r.durationMs / 1000).toFixed(1)} s`]),
                ...result.reserved.map(id => [id, RESERVED, '-', '-'])
            ]));
            for (const r of rows.filter(r => r.diagnostic && r.status !== 'blocked'))
                lines.push('', `--- ${r.gate} (${STATUS[r.status] ?? r.status}) ---`, r.diagnostic.trimEnd());
            const verdict = !result.ok ? 'Des contrôles échouent.'
                : result.stage === 'task' && !rows.length ? 'Aucun contrôle de tâche à exécuter.'
                    : result.stage === 'task' ? 'Tous les contrôles de tâche passent.' : 'Tous les contrôles passent.';
            const reserved = result.reserved.length
                ? ` ${result.reserved.length} contrôle(s) ${RESERVED}, non exécuté(s) : la suite complète (apv gates run --stage full) les vérifie.` : '';
            lines.push('', `${verdict}${reserved} Reçus : ${relative(io.cwd, result.directory) || result.directory}`);
            io.stdout(`${lines.join('\n')}\n`);
        }
        return result.ok ? EXIT.ok : EXIT.failed;
    });
}
//# sourceMappingURL=gates.js.map