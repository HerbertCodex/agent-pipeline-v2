import { relative } from 'node:path';
import { loadConfig } from '../config/load.js';
import { gateStages } from '../domain/contracts.js';
import { runGates } from '../gates/run.js';
import { verifyGates } from '../gates/verify.js';
import { Git } from '../execution/git.js';
import { EXIT, UsageError, guard, json, list, parse, repoPath, table } from './common.js';
export const usage = `Utilisation :
  apv gates run [--stage task|full] [--only a,b] [--config <fichier>] [--base <ref>]
                [--concurrency N] [--keep-going] [--skip-proven] [--repo <chemin>] [--json]
  apv gates verify --commit <sha> [--stage full|task] [--base <ref>] [--config <fichier>]
                   [--repo <chemin>] [--json]

run : exécute les contrôles déclarés (.apv/config.json, sinon pipeline.v2.json) dans le dépôt :
dépendances, ressources, variables transmises, délais et masquage des secrets respectés.
Écrit un reçu JSON par contrôle dans .apv/receipts/<exécution>/ et affiche un tableau.
--stage task n'exécute que les contrôles de stage task (champ absent : task) ; un contrôle
de stage full qui déclare affected y lance cette commande ciblée à sa place (tests concernés
par les changements, marqués « ciblé », jamais une preuve du contrôle complet) ; les autres
contrôles de stage full sont listés comme réservés à la suite complète, jamais comptés comme
réussis. --stage full (défaut) exécute tout, jamais en ciblé ; si la suite complète est déjà
prouvée sur ce commit exact (apv gates verify à 0, arbre propre), elle le signale avant de la
relancer ; avec --skip-proven, elle ne relance rien dans ce cas et sort en 0 (la preuve reste
celle que vérifie apv gates verify).
Sortie : 0 si tous les contrôles exécutés passent, 1 sinon, 2 appel incorrect.

verify : vérifie dans les reçus que chaque contrôle exigé a réussi sur ce commit exact, arbre
propre, avec la configuration actuelle ; pour chaque contrôle, seul son reçu le plus récent
compte. --stage full (défaut) : tous les contrôles, les reçus ciblés ne comptent jamais.
--stage task : ceux de stage task, plus les contrôles full qui déclarent affected, prouvés par
leur reçu ciblé (ou complet) ; --base <ref> est alors obligatoire (le dernier commit prouvé par
la suite complète) : un reçu ciblé ne compte que si la base de son exécution est ce commit ou
l'un de ses ancêtres.
Sortie : 0 preuve complète, 1 sinon (ce qui manque est listé), 2 appel incorrect.`;
const STATUS = { passed: 'réussi', failed: 'échec', timed_out: 'délai dépassé', cancelled: 'annulé',
    spawn_error: 'non lancé', blocked: 'bloqué', cached: 'réutilisé' };
const RESERVED = 'réservé à la suite complète';
const TARGETED = 'ciblé';
const EVIDENCE = { passed: 'réussi', failed: 'échec', dirty: 'arbre modifié', missing: 'aucun reçu' };
/** Human lines of `apv gates verify`. */
function verifyLines(result) {
    const what = result.stage === 'full' ? 'suite complète' : result.targeted.length ? 'contrôles de tâche et ciblés' : 'contrôles de tâche';
    const state = (g) => {
        const text = g.state === 'failed' ? `${EVIDENCE.failed} (${STATUS[g.status] ?? g.status})` : EVIDENCE[g.state];
        return g.proof === 'targeted' ? `${text} (${TARGETED})` : text;
    };
    const lines = [`Vérification (${what}) au commit ${result.commit.slice(0, 12)}${result.base ? ` ; tests ciblés depuis ${result.base.slice(0, 12)}` : ''}`, '',
        table(['contrôle', 'état', 'reçu'], result.gates.map(g => [g.viaTargeted ? `${g.gateId} (${TARGETED})` : g.gateId, state(g),
            g.receipt ? `${g.runId}/${g.gateId}.json` : '-']))];
    const other = result.gates.filter(g => g.otherConfig > 0 && g.state !== 'passed');
    if (other.length)
        lines.push('', `Reçus ignorés (configuration des contrôles différente) : ${other.map(g => g.gateId).join(', ')}`);
    const targeted = result.gates.filter(g => !g.viaTargeted && g.targeted > 0 && g.state !== 'passed');
    if (targeted.length)
        lines.push('', `Reçus ciblés ignorés (seule la suite complète prouve ces contrôles) : ${targeted.map(g => g.gateId).join(', ')}`);
    const otherBase = result.gates.filter(g => g.otherBase > 0 && g.state !== 'passed');
    if (otherBase.length)
        lines.push('', `Reçus ciblés ignorés (leur base ne couvre pas les changements depuis ${result.base?.slice(0, 12)}) : ${otherBase.map(g => g.gateId).join(', ')}`);
    if (result.unreadable.length)
        lines.push('', `Reçus illisibles ignorés : ${result.unreadable.join(', ')}`);
    const missing = result.gates.filter(g => g.state !== 'passed');
    const rerun = result.stage === 'task' && result.base ? `apv gates run --stage task --base ${result.base.slice(0, 12)}` : `apv gates run --stage ${result.stage}`;
    lines.push('', result.ok
        ? `Preuve complète : ${result.required.length} contrôle(s) réussi(s) sur ce commit, arbre propre${result.stage === 'task' && (result.targeted.length || result.reserved.length) ? ' (niveau tâche : la suite complète reste à passer)' : ''}.`
        : `Preuve incomplète. Manque : ${missing.map(g => `${g.gateId} (${EVIDENCE[g.state]})`).join(', ')}. ` +
            `Relancer : ${rerun} sur ce commit, arbre propre.`);
    return lines;
}
/** The full proof of HEAD when it exists on a clean tree, else null (any refusal of verify counts as « not proven »). */
async function provenFull(repo, config) {
    try {
        const git = new Git();
        const root = await git.root(repo);
        if ((await git.exec(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) !== '')
            return null;
        const result = await verifyGates({ repo: root, config, commit: 'HEAD', stage: 'full' });
        return result.ok ? result : null;
    }
    catch {
        return null;
    }
}
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
            stage: { type: 'string' }, commit: { type: 'string' }, 'skip-proven': { type: 'boolean' },
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
            const extra = ['only', 'concurrency', 'keep-going', 'skip-proven'].filter(k => values[k] !== undefined);
            if (extra.length)
                throw new UsageError(`option de gates run seulement : --${extra.join(', --')}`);
            if (!values.commit)
                throw new UsageError('gates verify attend --commit <sha>');
            if (values.base !== undefined && stage !== 'task')
                throw new UsageError('gates verify : --base va avec --stage task (base des tests ciblés)');
            const repo = repoPath(io, values.repo);
            const loaded = loadConfig(repo, values.config);
            const result = await verifyGates({ repo, config: loaded.config, commit: values.commit, ...(stage ? { stage } : {}), ...(values.base ? { base: values.base } : {}) });
            if (values.json) {
                json(io, { ok: result.ok, commit: result.commit, stage: result.stage, base: result.base, config: loaded.file, configHash: result.configHash,
                    required: result.required, targeted: result.targeted, reserved: result.reserved, gates: result.gates, unreadable: result.unreadable,
                    missing: result.gates.filter(g => g.state !== 'passed').map(g => g.gateId) });
            }
            else {
                io.stdout(`${verifyLines(result).join('\n')}\n`);
            }
            return result.ok ? EXIT.ok : EXIT.failed;
        }
        if (values.commit !== undefined)
            throw new UsageError('--commit est une option de gates verify');
        const skipProven = values['skip-proven'] === true;
        if (skipProven && (stage === 'task' || values.only !== undefined))
            throw new UsageError('--skip-proven va avec la suite complète entière (--stage full, sans --only)');
        const concurrency = values.concurrency === undefined ? 3 : Number(values.concurrency);
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
            throw new UsageError('--concurrency attend un entier entre 1 et 16');
        const repo = repoPath(io, values.repo);
        const loaded = loadConfig(repo, values.config);
        // The full suite already proven on this exact commit, clean tree: said before a run of several minutes, and
        // with --skip-proven, not run again. The proof is the one `apv gates verify` checks, nothing weaker.
        const proven = stage !== 'task' && values.only === undefined ? await provenFull(repo, loaded.config) : null;
        if (proven && skipProven) {
            if (values.json)
                json(io, { ok: true, skipped: true, candidateSha: proven.commit, stage: 'full', config: loaded.file, required: proven.required,
                    gates: proven.gates.map(g => ({ gate: g.gateId, receipt: `${g.runId}/${g.gateId}.json` })) });
            else
                io.stdout(`Suite complète déjà prouvée au commit ${proven.commit.slice(0, 12)} (apv gates verify à 0, arbre propre) : ${proven.required.length} contrôle(s), rien n'est relancé (--skip-proven).\n`);
            return EXIT.ok;
        }
        if (proven && !values.json) {
            io.stdout(`Note : la suite complète est déjà prouvée au commit ${proven.commit.slice(0, 12)} (apv gates verify à 0, arbre propre) ; --skip-proven évite de la relancer.\n`);
        }
        const result = await runGates({ repo, config: loaded.config, only: list(values.only), concurrency, failFast: !values['keep-going'], env: io.env,
            ...(values.base ? { base: values.base } : {}), ...(stage ? { stage } : {}) });
        const rows = result.receipts.map(r => ({ gate: r.gateId, targeted: r.targeted === true, status: r.status, exitCode: r.exitCode,
            durationMs: Math.round(r.durationMs), receipt: r.id, diagnostic: r.diagnostic }));
        const name = (r) => r.targeted ? `${r.gate} (${TARGETED})` : r.gate;
        if (values.json) {
            json(io, { ok: result.ok, runId: result.runId, candidateSha: result.candidateSha, baseSha: result.baseSha, dirty: result.dirty, alreadyProven: proven !== null,
                stage: result.stage, config: loaded.file, legacyConfig: loaded.legacy, ignoredSections: loaded.ignored, added: result.added,
                reserved: result.reserved, targeted: result.targeted, receiptsDirectory: result.directory, gates: rows });
        }
        else {
            const lines = [`${result.stage === 'task' ? 'Contrôles de tâche (--stage task)' : 'Contrôles'} à ${result.candidateSha.slice(0, 12)} (configuration : ${loaded.file ? relative(result.repo, loaded.file) || loaded.file : 'aucune'}${loaded.legacy ? ', format V2' : ''})`];
            if (result.added.length)
                lines.push(`Dépendances ajoutées : ${result.added.join(', ')}`);
            if (result.dirty)
                lines.push('Attention : modifications non commitées présentes ; les reçus décrivent plus que le commit.');
            lines.push('', table(['contrôle', 'statut', 'code', 'durée'], [
                ...rows.map(r => [name(r), STATUS[r.status] ?? r.status, r.exitCode === null ? '-' : String(r.exitCode), `${(r.durationMs / 1000).toFixed(1)} s`]),
                ...result.reserved.map(id => [id, RESERVED, '-', '-'])
            ]));
            for (const r of rows.filter(r => r.diagnostic && r.status !== 'blocked'))
                lines.push('', `--- ${name(r)} (${STATUS[r.status] ?? r.status}) ---`, r.diagnostic.trimEnd());
            const verdict = !result.ok ? 'Des contrôles échouent.'
                : result.stage === 'task' && !rows.length ? 'Aucun contrôle de tâche à exécuter.'
                    : result.stage === 'task' ? 'Tous les contrôles de tâche passent.' : 'Tous les contrôles passent.';
            const reserved = result.reserved.length
                ? ` ${result.reserved.length} contrôle(s) ${RESERVED}, non exécuté(s) : la suite complète (apv gates run --stage full) les vérifie.` : '';
            const targeted = result.targeted.length
                ? ` ${result.targeted.length} contrôle(s) ${TARGETED}(s) (${result.targeted.join(', ')}) : seuls les tests concernés par les changements ont tourné ; la suite complète (apv gates run --stage full) les exécute en entier.` : '';
            lines.push('', `${verdict}${targeted}${reserved} Reçus : ${relative(io.cwd, result.directory) || result.directory}`);
            io.stdout(`${lines.join('\n')}\n`);
        }
        return result.ok ? EXIT.ok : EXIT.failed;
    });
}
//# sourceMappingURL=gates.js.map