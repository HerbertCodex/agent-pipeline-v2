import { realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadConfig, loadConfigAtCommit } from '../config/load.js';
import { applyBaseGates, baseGatesLines } from '../gates/base-gates.js';
import { gateStages } from '../domain/contracts.js';
import { PipelineError } from '../domain/errors.js';
import { RECEIPTS_DIR, dirtyRefusal, isFullSuite, runGates, selectGates, stageGates } from '../gates/run.js';
import { exportRun, listRuns, pruneStore, receiptRetention, sharedStore } from '../gates/store.js';
import { expectedLevel, findRun } from '../run/rhythm.js';
import { resolveCommit, gitRoot } from '../run/git-probe.js';
import { MAX_OVERRIDE_REASON, RUN_ID, applyFullSuiteOverride, readRunState, withRunLock, writeRunState } from '../run/state.js';
import { cleanLine } from '../run/summary.js';
import { verifyGates } from '../gates/verify.js';
import { referenceMissing, resolveReference } from '../gates/repeat.js';
import { scopeReferenceMissing } from '../gates/proof-scope.js';
import { Git } from '../execution/git.js';
import { signalExitCode } from '../lock/run.js';
import { EXIT, UsageError, guard, json, list, parse, repoPath, table } from './common.js';
export const usage = `Utilisation :
  apv gates run [--stage task|full] [--only a,b] [--config <fichier>] [--base <ref>] [--against <ref>]
                [--concurrency N] [--keep-going] [--skip-proven] [--run <spec-id>]
                [--reason <texte>] [--allow-dirty] [--stacks <pile>,<pile>] [--repo <chemin>] [--json]
  apv gates verify --commit <sha> [--stage full|task] [--base <ref>] [--against <ref>] [--offline]
                   [--config <fichier> | --commit-config] [--repo <chemin>] [--json]
  apv gates receipts list [--commit <ref>] [--limit N] [--repo <chemin>] [--json]
  apv gates receipts export <exécution> --out <dossier> [--repo <chemin>] [--json]
  apv gates receipts prune [--keep-days N] [--keep-runs N] [--config <fichier>]
                         [--repo <chemin>] [--json]

Contrôles de la base : run et verify lisent aussi la configuration de la base commune de --against (sinon
--base, sinon la branche par défaut du dépôt distant ; référence complète, vérifiée auprès du dépôt distant
quand le réseau le permet) ; tout contrôle de la base, obligatoire ou non, retiré, rendu facultatif ou modifié
par le candidat reste exigé avec sa définition de base, et la différence est dite. Le candidat peut seulement
ajouter ou durcir des contrôles ; les changer passe par une PR de configuration seule. Dépôt distant illisible :
run avertit, verify refuse sauf --offline (accepté avec un avertissement).

run : exécute les contrôles déclarés (.apv/config.json, sinon pipeline.v2.json) dans le dépôt :
dépendances, ressources, variables transmises, délais et masquage des secrets respectés.
Écrit un reçu JSON par contrôle dans .apv/receipts/<exécution>/ et affiche un tableau ; copie
l'exécution dans le magasin partagé du dépôt (<répertoire git commun>/apv/receipts/<exécution>/,
commun à tous les worktrees, jamais versionné, avec les empreintes de ses fichiers), où elle
survit au retrait du worktree, puis y applique la rétention (section receipts de la configuration :
30 jours et 1000 exécutions par défaut).
--stage task n'exécute que les contrôles de stage task (champ absent : task) ; un contrôle
de stage full qui déclare affected y lance cette commande ciblée à sa place (tests concernés
par les changements, marqués « ciblé », jamais une preuve du contrôle complet) ; les autres
contrôles de stage full sont listés comme réservés à la suite complète, jamais comptés comme
réussis. --stage full (défaut) exécute tout, jamais en ciblé ; si la suite complète est déjà
prouvée sur ce commit exact (apv gates verify à 0, arbre propre), elle le signale avant de la
relancer ; avec --skip-proven, elle ne relance rien dans ce cas et sort en 0 (la preuve reste
celle que vérifie apv gates verify).
Rythme d'une exécution (/apv:run) : dans le cadre d'une exécution, la suite complète (--stage full,
avec au moins un contrôle de stage full) est refusée quand l'étape courante n'attend que les
contrôles de tâche et ciblés (même calcul que apv run next : intégration intermédiaire ou
corrections avec run.fullSuite = final) ; le message donne la commande à lancer à la place.
L'exécution : --run <spec-id>, sinon celle de la branche courante (apv/<id> ou apv/<id>-<suffixe>)
quand un worktree du dépôt a son état .apv/state/run-<id>.json (plusieurs : celui sur apv/<id>,
sinon le checkout principal, sinon refus qui liste les emplacements) ; aucune : rien ne change.
--reason <texte> (1 à ${MAX_OVERRIDE_REASON} caractères) laisse passer la suite complète : la raison est journalisée
dans l'état de l'exécution et écrite dans les reçus (override).
Suite complète (au moins un contrôle de stage full exécuté en entier) : refusée sur un arbre modifié
(fichiers suivis modifiés ou non suivis hors ignorés, listés) sauf --allow-dirty (reçus non prouvants) ;
puis file des suites complètes (section suite.queue, active par défaut : un verrou à bail commun aux
worktrees, et si suite.queue.maxLoad est posé, attente d'une charge sur 1 min sous ce seuil) ; puis arrêt
des orphelins de cette copie sur suite.ports (jamais une autre copie ni le checkout principal). Les
délais des contrôles ne commencent qu'après. Un contrôle avec lock attend son verrou (bail apv lock ou
flock) avant que son délai commence ; un contrôle avec retryFailed qui échoue relance une fois ses tests
en échec, même commit et même arbre : « réussi après relance » (instable), compté comme réussi et
signalé à part. Un contrôle avec repeatChanged relance ensuite, avec --base, les seuls fichiers de test
ajoutés ou modifiés depuis la base (motifs repeatChanged.paths) repeatChanged.times fois, sous le même
verrou (un test dont seuls les chemins d'import changent, ou renommé sans autre changement, est listé
« tests dont seuls les imports changent : non répétés », jamais répété ni compté dans maxFiles) : tout échec le rend rouge (« échoue X fois sur N »), jamais masqué par retryFailed ; plus de
fichiers que repeatChanged.maxFiles, ou une attente à durée fixe avec fixedWaits = refuse : refus avant
toute attente. Sans --base, un tel contrôle ne se lance pas (appel incorrect) ; une suite complète compare
aussi à repeatChanged.reference (obligatoire ; introuvable : appel incorrect).
Portée (skipWhenOnly, suite complète, --base obligatoire) : un contrôle dont chaque fichier changé depuis
la base et depuis skipWhenOnly.reference répond aux chemins sans effet lus à la référence (jamais dans le
changement), hors fichiers toujours requis (configuration, dépendances, CI, build, tests, scripts,
migrations, mode ou type changé), n'est pas lancé : reçu « non requis » (not_required) avec la portée. À la fin d'une suite complète (réussite, échec, ou SIGINT, SIGTERM, SIGHUP : contrôles
annulés, sortie 128 + signal), les processus qu'elle a lancés encore vivants et les orphelins de cette
copie sur suite.ports sont arrêtés (jamais la session, une autre copie ni le checkout principal).
--stacks 1,2 (suite complète, deux piles déclarées au moins, section stacks) : les contrôles d'une pile
(lock égal au verrou d'une pile déclarée) sont répartis sur ces piles, tour à tour dans l'ordre de la
configuration ; sur la première dans cette copie, sur une autre dans une copie détachée du même commit
(préparée par batch.setup, retirée à la fin), avec les variables de sa pile et sous son verrou. Un
contrôle qui a des dépendances, ou dont d'autres dépendent, reste dans cette copie.
Sortie : 0 si tous les contrôles exécutés passent, 1 sinon (ou suite complète refusée par le
rythme, l'arbre modifié ou la file, ou répétition refusée), 2 appel incorrect.

verify : vérifie dans les reçus que chaque contrôle exigé a réussi sur ce commit exact, arbre
propre, avec la configuration actuelle ; pour chaque contrôle, seul son reçu le plus récent
compte. --stage full (défaut) : tous les contrôles, les reçus ciblés ne comptent jamais.
--stage task : ceux de stage task, plus les contrôles full qui déclarent affected, prouvés par
leur reçu ciblé (ou complet) ; --base <ref> est alors obligatoire (le dernier commit prouvé par
la suite complète) : un reçu ciblé ne compte que si la base de son exécution est ce commit ou
l'un de ses ancêtres. Un contrôle qui déclare repeatChanged n'est prouvé que si son reçu montre la
répétition de chaque fichier de test que le commit ajoute ou modifie (recalculé depuis la base enregistrée
et la référence) : sinon « tests modifiés non répétés ». Un reçu « non requis » (skipWhenOnly) ne compte
que si la portée, recalculée depuis le commit, la base enregistrée et la liste lue à la référence, le dit
non requis : sinon « requis (dispense non prouvée) ». Un reçu dont le relevé de apv web audit dit
« audit non requis » (quelle que soit la commande) n'est prouvé que si le recalcul depuis le commit
(fichiers à effet web depuis la base commune de la référence enregistrée et depuis la base enregistrée)
le confirme ; sans relevé, un contrôle dont la commande montre web audit --preview --base ne l'est pas :
sinon « audit web non prouvé ».
Les reçus sont lus dans .apv/receipts/ du worktree, puis dans le magasin partagé pour les
exécutions que le worktree n'a pas : la preuve d'un commit se vérifie depuis n'importe quel
checkout du dépôt, avec les mêmes exigences. Une exécution du magasin partagé dont un fichier ne
correspond plus à son manifeste (empreintes) est refusée en entier et signalée.
--commit-config lit la configuration des contrôles au commit vérifié (git show <commit>:.apv/config.json)
plutôt que dans le checkout : utile depuis un checkout dont la configuration diffère de celle du commit.
Sortie : 0 preuve complète, 1 sinon (ce qui manque est listé), 2 appel incorrect.

receipts list : exécutions du worktree et du magasin partagé, les plus récentes d'abord (20 par
défaut, --limit N), avec commit, stage, verdict, arbre et emplacement ; --commit <ref> filtre.
receipts export <exécution> --out <dossier> : copie l'exécution (du worktree, sinon du magasin
partagé, intacte) dans <dossier>/<exécution>/ avec manifest.json (empreinte sha256 de chaque fichier).
receipts prune : applique la rétention au magasin partagé (--keep-days, --keep-runs remplacent
la configuration). Les reçus du worktree ne sont jamais touchés.
Sortie : 0, 1 exécution introuvable, altérée ou destination existante, 2 appel incorrect.`;
const STATUS = { passed: 'réussi', failed: 'échec', timed_out: 'délai dépassé', cancelled: 'annulé',
    spawn_error: 'non lancé', blocked: 'bloqué', cached: 'réutilisé', passed_after_retry: 'réussi après relance', not_required: 'non requis (portée)' };
const FLAKY = 'instable';
const RESERVED = 'réservé à la suite complète';
const TARGETED = 'ciblé';
const SHARED = 'magasin partagé';
const EVIDENCE = { passed: 'réussi', failed: 'échec', dirty: 'arbre modifié', missing: 'aucun reçu', unrepeated: 'tests modifiés non répétés',
    unaudited: 'audit web non prouvé', required: 'requis (dispense non prouvée)' };
/** One line of the repetition of the changed test files of a check. */
function repeatLine(r) {
    const only = r.importsOnly?.length ? ` ; tests dont seuls les imports changent : non répétés (${r.importsOnly.length > 5 ? `${r.importsOnly.slice(0, 5).join(', ')} ... (${r.importsOnly.length})` : r.importsOnly.join(', ')})` : '';
    return `${repeatText(r)}${only}`;
}
function repeatText(r) {
    const files = r.files.length > 5 ? `${r.files.slice(0, 5).join(', ')} ... (${r.files.length})` : r.files.join(', ');
    if (r.status === 'no_base')
        return 'non répétés : --base absent (apv gates run --base <base de la branche> les répète)';
    if (r.status === 'none')
        return `aucun fichier de test ${r.importsOnly?.length ? 'à répéter' : 'ajouté ou modifié'} depuis ${r.base?.slice(0, 12)}`;
    if (r.status === 'not_run')
        return `non répétés, la commande du contrôle n'a pas réussi (${files})`;
    if (r.status === 'passed')
        return `${r.files.length} fichier(s), ${r.times} fois chacun : réussi (${files})`;
    const tests = r.failures.map(f => `${f.test} échoue ${f.count} fois sur ${r.times}`).join(' ; ');
    return `${r.files.length} fichier(s), ${r.times} fois chacun : ${STATUS[r.status] ?? r.status}${tests ? `, test instable : ${tests}` : ''} (${files})`;
}
/** Human lines of `apv gates verify`. */
function verifyLines(result) {
    const what = result.stage === 'full' ? 'suite complète' : result.targeted.length ? 'contrôles de tâche et ciblés' : 'contrôles de tâche';
    const state = (g) => {
        const text = g.state === 'failed' ? `${EVIDENCE.failed} (${STATUS[g.status] ?? g.status})`
            : g.state === 'passed' && g.status === 'passed_after_retry' ? `${STATUS['passed_after_retry']} (${FLAKY})`
                : g.state === 'passed' && g.status === 'not_required' ? 'non requis (portée recalculée)' : EVIDENCE[g.state];
        return g.proof === 'targeted' ? `${text} (${TARGETED})` : text;
    };
    const lines = [`Vérification (${what}) au commit ${result.commit.slice(0, 12)}${result.base ? ` ; tests ciblés depuis ${result.base.slice(0, 12)}` : ''}`, '',
        table(['contrôle', 'état', 'reçu'], result.gates.map(g => [g.viaTargeted ? `${g.gateId} (${TARGETED})` : g.gateId, state(g),
            g.receipt ? `${g.runId}/${g.gateId}.json${g.source === 'shared' ? ` (${SHARED})` : ''}` : '-']))];
    if (result.gates.some(g => g.source === 'shared'))
        lines.push('', `Magasin partagé des reçus : ${result.store}`);
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
    if (result.altered.length)
        lines.push('', `Exécutions du magasin partagé refusées (altérées) : ${result.altered.map(a => `${a.runId} (${a.reason})`).join(', ')}`);
    const unrepeated = result.gates.filter(g => g.state === 'unrepeated');
    if (unrepeated.length)
        lines.push('', 'Tests modifiés non répétés (repeatChanged) : le reçu réussi ne prouve pas la répétition des tests que ce commit ajoute ou modifie :', ...unrepeated.map(g => `- ${g.gateId} : ${g.repeat.reason}${g.repeat.missing.length ? ` : ${g.repeat.missing.slice(0, 10).join(', ')}${g.repeat.missing.length > 10 ? ' ...' : ''}` : ''}`));
    const unaudited = result.gates.filter(g => g.state === 'unaudited');
    if (unaudited.length)
        lines.push('', 'Audit web non prouvé (apv web audit --preview --base) : le reçu dit « non requis », le recalcul depuis ce commit dit requis :', ...unaudited.map(g => `- ${g.gateId} : ${g.web.reason}${g.web.files.length ? ` : ${g.web.files.slice(0, 10).join(', ')}${g.web.files.length > 10 ? ' ...' : ''}` : ''}`));
    const scoped = result.gates.filter(g => g.scope);
    if (scoped.length)
        lines.push('', 'Portée de la preuve (skipWhenOnly), recalculée depuis le commit :', ...scoped.map(g => `- ${g.gateId} : ${g.scope.required ? 'REQUIS, le reçu « non requis » ne prouve rien' : 'non requis'} : ${g.scope.reason}` +
            `${g.scope.blocking.length ? ` ; fichiers qui le requièrent : ${g.scope.blocking.slice(0, 10).join(', ')}${g.scope.blocking.length > 10 ? ' ...' : ''}` : ''}`));
    const missing = result.gates.filter(g => g.state !== 'passed');
    const rerun = result.stage === 'task' && result.base ? `apv gates run --stage task --base ${result.base.slice(0, 12)}`
        : `apv gates run --stage ${result.stage}${result.repeating.length || result.scoped.length ? ' --base <base de la branche>' : ''}`;
    if (result.flaky.length)
        lines.push('', `Instables (réussis seulement après la relance de leurs tests en échec, même commit) : ${result.flaky.join(', ')} : à traiter comme un constat.`);
    lines.push('', result.ok
        ? `Preuve complète : ${result.required.length} contrôle(s) ${result.notRequired.length ? `prouvé(s) sur ce commit (dont ${result.notRequired.length} non requis par leur portée : ${result.notRequired.join(', ')})` : 'réussi(s) sur ce commit'}, arbre propre${result.flaky.length ? `, dont ${result.flaky.length} ${FLAKY}(s)` : ''}${result.stage === 'task' && (result.targeted.length || result.reserved.length) ? ' (niveau tâche : la suite complète reste à passer)' : ''}.`
        : `Preuve incomplète. Manque : ${missing.map(g => `${g.gateId} (${EVIDENCE[g.state]})`).join(', ')}. ` +
            `Relancer : ${rerun} sur ce commit, arbre propre.`);
    return lines;
}
/** The full proof of HEAD when it exists on a clean tree, else null (any refusal of verify counts as « not proven »). */
async function provenFull(repo, config, configFile) {
    try {
        const git = new Git();
        const root = await git.root(repo);
        if ((await git.exec(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) !== '')
            return null;
        const result = await verifyGates({ repo: root, config, commit: 'HEAD', stage: 'full', configFile });
        return result.ok ? result : null;
    }
    catch {
        return null;
    }
}
/**
 * The rhythm of an execution (/apv:run) applied to a full run: refused when the current step expects the task
 * level only (the level of `apv run next`), unless `reason` is given, journaled in the state of the execution.
 * Outside any execution, or when the level is full or unknown, nothing changes.
 */
async function rhythmCheck(repo, explicit, reason, io, beforeWrite) {
    const notes = [];
    const context = findRun(repo, explicit);
    if (!context) {
        if (reason !== undefined)
            notes.push('Note : --reason sans effet, aucune exécution trouvée pour cette branche (--run <spec-id> pour en nommer une).');
        return { context, expected: null, override: null, notes };
    }
    let expected;
    try {
        expected = expectedLevel(context);
    }
    catch (error) {
        // A state found by the branch but unreadable: said, and the run goes on as outside an execution.
        if (context.source === 'option' || !(error instanceof PipelineError))
            throw error;
        notes.push(`Note : rythme de l'exécution ${context.specId} non vérifié, état illisible (${cleanLine(error.message, 300)}).`);
        return { context, expected: null, override: null, notes };
    }
    const { plan, mode, where } = expected;
    if (plan.suite.level !== 'task') {
        if (reason !== undefined)
            notes.push(`Note : --reason sans effet, l'exécution ${context.specId} (${where}) n'attend pas le seul niveau tâche à cette étape.`);
        return { context, expected, override: null, notes };
    }
    const tb = plan.suite.targetBase.slice(0, 12);
    if (reason === undefined) {
        const found = context.source === 'branch' ? ` (exécution trouvée par la branche ${context.branch} ; --run <spec-id> pour en nommer une autre)` : '';
        throw new PipelineError('GATE_RHYTHM', `Suite complète refusée : l'exécution ${context.specId}${found} en est à l'étape ${where}, run.fullSuite = ${mode}, ` +
            `et le niveau attendu à cette étape est « contrôles de tâche et ciblés » (apv run next ${context.specId}). ` +
            `À lancer à la place : apv gates run --stage task --base ${tb}, puis apv gates verify --commit <tête> --stage task --base ${tb} à 0. ` +
            'La suite complète vient à la dernière intégration et à la livraison. ' +
            'Dérogation motivée seulement : --reason "<raison>" (journalisée dans l\'état de l\'exécution et écrite dans les reçus).');
    }
    await beforeWrite(context.checkout);
    const commit = resolveCommit(gitRoot(repo), 'HEAD') ?? undefined;
    await withRunLock(context.specId, io.env, () => {
        const current = readRunState(context.file, { shown: `.apv/state/run-${context.specId}.json`, specId: context.specId });
        writeRunState(context.file, applyFullSuiteOverride(current, { reason, ...(commit ? { commit } : {}) }).state);
    });
    notes.push(cleanLine(`Dérogation au rythme de l'exécution ${context.specId} (${where}, niveau attendu : contrôles de tâche et ciblés), journalisée dans son état : ${reason}`, 700));
    return { context, expected, override: { run: context.specId, reason }, notes };
}
/** `--against <ref>`: the branch the change goes to, whose mandatory checks are kept. */
function againstOf(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || !value || value.startsWith('-'))
        throw new UsageError('--against attend une référence Git (la branche où va le changement, par exemple origin/main)');
    return value;
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
            stage: { type: 'string' }, commit: { type: 'string' }, 'skip-proven': { type: 'boolean' }, run: { type: 'string' }, reason: { type: 'string' },
            'keep-going': { type: 'boolean' }, 'allow-dirty': { type: 'boolean' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
            'commit-config': { type: 'boolean' }, against: { type: 'string' }, offline: { type: 'boolean' }, limit: { type: 'string' }, out: { type: 'string' }, 'keep-days': { type: 'string' }, 'keep-runs': { type: 'string' },
            stacks: { type: 'string' },
        });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (action !== 'run' && action !== 'verify' && action !== 'receipts')
            throw new UsageError(action ? `sous-commande inconnue : gates ${action}` : 'sous-commande manquante');
        if (action === 'receipts')
            return receipts(rest, values, io);
        const own = ['limit', 'out', 'keep-days', 'keep-runs'].filter(k => values[k] !== undefined);
        if (own.length)
            throw new UsageError(`option de gates receipts seulement : --${own.join(', --')}`);
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        const stage = stageOf(values.stage);
        if (action === 'verify') {
            const extra = ['only', 'concurrency', 'keep-going', 'skip-proven', 'run', 'reason', 'allow-dirty', 'stacks'].filter(k => values[k] !== undefined);
            if (extra.length)
                throw new UsageError(`option de gates run seulement : --${extra.join(', --')}`);
            if (!values.commit)
                throw new UsageError('gates verify attend --commit <sha>');
            if (values.base !== undefined && stage !== 'task')
                throw new UsageError('gates verify : --base va avec --stage task (base des tests ciblés)');
            if (values['commit-config'] && values.config !== undefined)
                throw new UsageError('gates verify : --commit-config ou --config, pas les deux');
            const repo = repoPath(io, values.repo);
            let loaded;
            if (values['commit-config']) {
                const root = gitRoot(repo);
                const sha = resolveCommit(root, values.commit);
                if (!sha)
                    throw new PipelineError('SHA', `Commit introuvable : ${values.commit}`);
                loaded = loadConfigAtCommit(root, sha);
            }
            else
                loaded = loadConfig(repo, values.config);
            const verifyRoot = gitRoot(repo);
            const verified = resolveCommit(verifyRoot, values.commit);
            if (!verified)
                throw new PipelineError('SHA', `Commit introuvable : ${values.commit}`);
            const kept = applyBaseGates(verifyRoot, loaded.config, verified, againstOf(values.against) ?? values.base ?? null, { strict: true, offline: values.offline === true });
            loaded = { ...loaded, config: kept.config };
            const result = await verifyGates({ repo, config: loaded.config, commit: values.commit, ...(stage ? { stage } : {}), ...(values.base ? { base: values.base } : {}),
                configFile: values['commit-config'] ? null : loaded.file });
            if (values.json) {
                json(io, { ok: result.ok, commit: result.commit, stage: result.stage, base: result.base, config: loaded.file, configHash: result.configHash, baseGates: kept.base,
                    required: result.required, targeted: result.targeted, reserved: result.reserved, gates: result.gates, unreadable: result.unreadable,
                    store: result.store, altered: result.altered, flaky: result.flaky, repeating: result.repeating, auditing: result.auditing, notRequired: result.notRequired, missing: result.gates.filter(g => g.state !== 'passed').map(g => g.gateId) });
            }
            else {
                io.stdout(`${[...baseGatesLines(kept.base), ...verifyLines(result)].join('\n')}\n`);
            }
            return result.ok ? EXIT.ok : EXIT.failed;
        }
        if (values.commit !== undefined)
            throw new UsageError('--commit est une option de gates verify');
        if (values['commit-config'])
            throw new UsageError('--commit-config est une option de gates verify');
        if (values.offline)
            throw new UsageError('--offline est une option de gates verify (gates run avertit seulement quand le dépôt distant est illisible)');
        const spreadOver = values.stacks === undefined ? undefined : list(values.stacks);
        if (spreadOver !== undefined && (spreadOver.length < 2 || new Set(spreadOver).size !== spreadOver.length))
            throw new UsageError('--stacks attend au moins deux piles différentes, par exemple --stacks 1,2');
        if (spreadOver !== undefined && stage === 'task')
            throw new UsageError('--stacks répartit la suite complète (--stage full)');
        const skipProven = values['skip-proven'] === true;
        if (skipProven && (stage === 'task' || values.only !== undefined))
            throw new UsageError('--skip-proven va avec la suite complète entière (--stage full, sans --only)');
        if (values.run !== undefined && (!RUN_ID.test(values.run) || values.run.length > 80))
            throw new UsageError(`--run : identifiant de spec invalide : ${values.run}`);
        const reason = values.reason?.trim();
        if (values.reason !== undefined && (!reason || reason.length > MAX_OVERRIDE_REASON))
            throw new UsageError(`--reason attend un texte de 1 à ${MAX_OVERRIDE_REASON} caractères`);
        if (reason !== undefined && stage === 'task')
            throw new UsageError('--reason va avec la suite complète (--stage full) : il motive une dérogation au rythme de l\'exécution');
        const concurrency = values.concurrency === undefined ? 3 : Number(values.concurrency);
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
            throw new UsageError('--concurrency attend un entier entre 1 et 16');
        const repo = repoPath(io, values.repo);
        let loaded = loadConfig(repo, values.config);
        // The mandatory checks of the base are kept, whatever the candidate's configuration says (src/gates/base-gates.ts).
        const runRoot = gitRoot(repo);
        const runHead = resolveCommit(runRoot, 'HEAD');
        const kept = runHead ? applyBaseGates(runRoot, loaded.config, runHead, againstOf(values.against) ?? values.base ?? null) : null;
        if (kept)
            loaded = { ...loaded, config: kept.config };
        const keptLines = kept ? baseGatesLines(kept.base) : [];
        if (keptLines.length && !values.json)
            io.stderr(`${keptLines.join('\n')}\n`);
        // A check that repeats its changed test files needs the base they changed from: refused as an incorrect call, before
        // the proof lookup (--skip-proven) and any wait, so that a red repetition is never replaced by a run that repeats nothing.
        const selected = selectGates(loaded.config.gates, list(values.only)).gates;
        const staged = stageGates(selected, stage ?? 'full');
        const repeating = [...staged.run, ...staged.targeted].filter(g => g.repeatChanged).map(g => g.id);
        if (repeating.length && values.base === undefined) {
            throw new UsageError(`${repeating.join(', ')} déclare(nt) repeatChanged : --base <base de la branche> est obligatoire (ses tests ajoutés ou modifiés depuis elle sont répétés ; sans base, rien ne le serait)`);
        }
        // The scope of the proof (skipWhenOnly) is counted at the full stage from the base and the reference: both required.
        const scoped = (stage ?? 'full') === 'full' ? staged.run.filter(g => g.skipWhenOnly).map(g => g.id) : [];
        if (scoped.length && values.base === undefined) {
            throw new UsageError(`${scoped.join(', ')} déclare(nt) skipWhenOnly : --base <base de la branche> est obligatoire à la suite complète (la portée se compte depuis elle et depuis la référence ; sans base, rien ne se compte)`);
        }
        // At the full stage, the changes are also counted from the reference: one that does not resolve is refused here.
        if ((stage ?? 'full') === 'full') {
            const git = new Git();
            const root = await git.root(repo);
            for (const g of staged.run.filter(x => x.repeatChanged)) {
                const resolved = await resolveReference(git, root, g.repeatChanged.reference);
                if (!resolved.sha)
                    throw new UsageError(referenceMissing(g.id, g.repeatChanged.reference, resolved.reason));
            }
            for (const g of staged.run.filter(x => x.skipWhenOnly)) {
                const resolved = await resolveReference(git, root, g.skipWhenOnly.reference);
                if (!resolved.sha)
                    throw new UsageError(scopeReferenceMissing(g.id, g.skipWhenOnly.reference, resolved.reason));
            }
        }
        const allowDirty = values['allow-dirty'] === true;
        // A full suite: a check of stage full run in full. On a dirty tree it proves nothing: refused first, before the
        // proof lookup, the rhythm (which may journal an override in the state) and any wait.
        const full = isFullSuite(selectGates(loaded.config.gates, list(values.only)).gates, stage ?? 'full');
        let treeChecked = false;
        const cleanTree = async (stateCheckout) => {
            if (treeChecked || !full || allowDirty)
                return;
            treeChecked = true;
            const git = new Git();
            const root = await git.root(repo);
            const status = await git.exec(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
            if (status !== '')
                throw dirtyRefusal(status);
            // The override is journaled in the state of the execution: in this very copy, it would dirty the tree of the suite.
            if (stateCheckout !== undefined && realpathSync(stateCheckout) === root) {
                throw new PipelineError('GATE_DIRTY', `Suite complète refusée : la dérogation (--reason) s'écrit dans l'état de l'exécution, dans cette copie (${root}), ` +
                    'dont l\'arbre serait alors modifié et les reçus non prouvants. Lancer la suite dans une copie propre de la tête (worktree d\'intégration ou de livraison), ou --allow-dirty.');
            }
        };
        // The full suite already proven on this exact commit, clean tree: said before a run of several minutes, and
        // with --skip-proven, not run again. The proof is the one `apv gates verify` checks, nothing weaker.
        const proven = stage !== 'task' && values.only === undefined ? await provenFull(repo, loaded.config, loaded.file) : null;
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
        // The rhythm of an execution: only a run that executes a check of stage full in full is concerned.
        // The rhythm refusal first (it says what to run instead), then the clean tree, checked before an override is journaled.
        const rhythm = full ? await rhythmCheck(repo, values.run, reason, io, cleanTree)
            : { context: null, expected: null, override: null, notes: reason !== undefined ? ['Note : --reason sans effet, aucun contrôle de stage full à exécuter.'] : [] };
        await cleanTree();
        if (!values.json && rhythm.notes.length)
            io.stdout(`${rhythm.notes.join('\n')}\n`);
        // SIGINT, SIGTERM, SIGHUP: the checks are cancelled, the end of the suite stops what it started, then the exit.
        const abort = new AbortController();
        let received = null;
        const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
            const handler = () => {
                if (!received) {
                    received = signal;
                    io.stderr(`Signal ${signal} reçu : contrôles annulés ; les processus lancés par la suite sont arrêtés avant la sortie.\n`);
                }
                abort.abort();
            };
            process.on(signal, handler);
            return [signal, handler];
        });
        let result;
        try {
            result = await runGates({ repo, config: loaded.config, only: list(values.only), concurrency, failFast: !values['keep-going'], env: io.env, signal: abort.signal,
                allowDirty, log: line => io.stderr(`${line}\n`), ...(io.env['APV_LOCK_POLL_MS'] ? { hooks: { lockPollMs: Number(io.env['APV_LOCK_POLL_MS']) } } : {}),
                ...(values.base ? { base: values.base } : {}), ...(stage ? { stage } : {}), ...(rhythm.override ? { override: rhythm.override } : {}),
                ...(spreadOver ? { stacks: spreadOver } : {}), configFile: loaded.file });
        }
        catch (error) {
            if (received) {
                io.stderr(`Interrompu (${received}) : ${error instanceof Error ? error.message : String(error)}\n`);
                return signalExitCode(received);
            }
            throw error;
        }
        finally {
            for (const [signal, handler] of handlers)
                process.off(signal, handler);
        }
        const rows = result.receipts.map(r => ({ gate: r.gateId, targeted: r.targeted === true, status: r.status, exitCode: r.exitCode,
            durationMs: Math.round(r.durationMs), receipt: r.id, diagnostic: r.diagnostic,
            ...(r.lockWaitMs !== undefined ? { lockWaitMs: r.lockWaitMs } : {}), ...(r.retry ? { retriedTests: r.retry.tests } : {}),
            ...(r.repeat ? { repeat: { status: r.repeat.status, base: r.repeat.base, files: r.repeat.files, importsOnly: r.repeat.importsOnly, times: r.repeat.times, failures: r.repeat.failures, fixedWaits: r.repeat.fixedWaits } } : {}),
            ...(r.scope ? { scope: r.scope } : {}) }));
        const name = (r) => r.targeted ? `${r.gate} (${TARGETED})` : r.gate;
        if (values.json) {
            json(io, { ok: result.ok, runId: result.runId, candidateSha: result.candidateSha, baseSha: result.baseSha, dirty: result.dirty, alreadyProven: proven !== null, baseGates: kept?.base ?? null,
                stage: result.stage, config: loaded.file, legacyConfig: loaded.legacy, ignoredSections: loaded.ignored, added: result.added,
                reserved: result.reserved, targeted: result.targeted, receiptsDirectory: result.directory,
                sharedDirectory: result.shared?.directory ?? null, sharedError: result.shared?.error ?? null, pruned: result.shared?.pruned?.removed.length ?? 0, gates: rows,
                suite: result.suite, notRequired: result.notRequired, queue: result.queue, ports: result.ports, flaky: result.flaky, cleanup: result.cleanup, spread: result.spread, stoppedStacks: result.stoppedStacks, interrupted: received,
                rhythm: rhythm.context ? { run: rhythm.context.specId, source: rhythm.context.source, checkout: rhythm.context.checkout, step: rhythm.expected?.plan.step ?? null,
                    level: rhythm.expected?.plan.suite.level ?? null, override: rhythm.override } : null, notes: rhythm.notes });
        }
        else {
            const lines = [`${result.stage === 'task' ? 'Contrôles de tâche (--stage task)' : 'Contrôles'} à ${result.candidateSha.slice(0, 12)} (configuration : ${loaded.file ? relative(result.repo, loaded.file) || loaded.file : 'aucune'}${loaded.legacy ? ', format V2' : ''})`];
            if (result.added.length)
                lines.push(`Dépendances ajoutées : ${result.added.join(', ')}`);
            if (result.dirty)
                lines.push(`Attention : modifications non commitées présentes ; les reçus décrivent plus que le commit${result.suite ? ' (--allow-dirty : ils ne prouvent rien)' : ''}.`);
            const q = result.queue;
            if (q) {
                const load = q.load ? ` ; charge sur 1 min au démarrage ${q.load.atStart.toFixed(2)} (seuil ${q.load.max}${q.load.waitedMs >= 1000 ? `, attendu ${Math.round(q.load.waitedMs / 1000)} s` : ''}${q.load.exceeded ? ', délai d\'attente de la charge dépassé : démarrée quand même' : ''})` : '';
                lines.push(`File des suites complètes : ${q.waitedMs >= 1000 ? `attendu ${Math.round(q.waitedMs / 1000)} s${q.heldBy ? ` (tenue par ${q.heldBy})` : ''}` : 'libre'}${load}.`);
            }
            if (result.ports?.stopped.length)
                lines.push(`Orphelins de cette copie arrêtés sur les ports de la suite : ${result.ports.stopped.map(p => `pid ${p.pid} (${p.ports.join(', ')})`).join(', ')}.`);
            if (result.ports?.left.length)
                lines.push(`Ports de la suite tenus par d'autres processus, non arrêtés : ${result.ports.left.map(p => `pid ${p.pid} (${p.ports.join(', ')}, ${p.reason})`).join(', ')}.`);
            for (const x of result.stoppedStacks)
                lines.push(`ATTENTION : pile ${x.stack} arrêtée par apv stacks idle-stop le ${x.since}, pas redémarrée depuis (${x.gates.join(', ')}) : apv stacks start ${x.stack}, puis relancer si ces contrôles échouent.`);
            if (result.spread)
                lines.push(`Répartition sur les piles : ${result.spread.map(a => `${a.gate} sur la pile ${a.stack}${a.workspace === result.repo ? '' : ' (copie détachée)'}${a.error ? ` : copie non préparée, ${a.error}` : ''}`).join(', ') || 'aucun contrôle de pile'}.`);
            const end = result.cleanup;
            if (end?.stopped.length)
                lines.push(`Fin de suite : processus lancés par la suite encore vivants, arrêtés : ${end.stopped.map(p => `pid ${p.pid}${p.ports.length ? ` (${p.ports.join(', ')})` : ''}`).join(', ')}.`);
            if (end?.ports?.stopped.length)
                lines.push(`Fin de suite : orphelins de cette copie arrêtés sur les ports de la suite : ${end.ports.stopped.map(p => `pid ${p.pid} (${p.ports.join(', ')})`).join(', ')}.`);
            if (received)
                lines.push(`Interrompu par ${received} : contrôles annulés.`);
            lines.push('', table(['contrôle', 'statut', 'code', 'durée'], [
                ...rows.map(r => [name(r), STATUS[r.status] ?? r.status, r.exitCode === null ? '-' : String(r.exitCode), `${(r.durationMs / 1000).toFixed(1)} s`]),
                ...result.reserved.map(id => [id, RESERVED, '-', '-'])
            ]));
            const flaky = rows.filter(r => r.status === 'passed_after_retry');
            if (flaky.length)
                lines.push('', `Instables (${flaky.length}) : réussis seulement après la relance unique de leurs tests en échec, même commit et même arbre ; comptés comme réussis, à traiter comme un constat :`, ...flaky.map(r => `- ${name(r)}${r.retriedTests?.length ? ` : ${r.retriedTests.join(' ; ')}` : ' (tests concernés non relevés : retryFailed.testPattern)'}`));
            const repeated = rows.filter(r => r.repeat);
            if (repeated.length)
                lines.push('', 'Tests modifiés répétés (repeatChanged) :', ...repeated.map(r => `- ${name(r)} : ${repeatLine(r.repeat)}`));
            const waits = repeated.flatMap(r => r.repeat.fixedWaits.map(w => `- ${name(r)} : ${w.file}:${w.line} : ${w.text}`));
            if (waits.length)
                lines.push('', `Attentes à durée fixe dans les tests modifiés (${waits.length}) : attendre un fait observable (réponse, élément, état), jamais une durée ; page.clock pour le temps :`, ...waits);
            const scopedRows = rows.filter(r => r.scope);
            if (scopedRows.length)
                lines.push('', 'Portée de la preuve (skipWhenOnly) :', ...scopedRows.map(r => `- ${name(r)} : ${r.scope.required ? 'requis' : 'NON REQUIS, non lancé'} : ${r.scope.reason}` +
                    `${r.scope.required && r.scope.blocking.length ? ` ; fichiers qui le requièrent : ${r.scope.blocking.slice(0, 10).join(', ')}${r.scope.blocking.length > 10 ? ' ...' : ''}` : ''}`));
            const waited = rows.filter(r => (r.lockWaitMs ?? 0) >= 1000);
            if (waited.length)
                lines.push('', `Attente de verrou avant le délai des contrôles : ${waited.map(r => `${name(r)} ${Math.round(r.lockWaitMs / 1000)} s`).join(', ')}.`);
            for (const r of rows.filter(r => r.diagnostic && r.status !== 'blocked' && r.status !== 'not_required'))
                lines.push('', `--- ${name(r)} (${STATUS[r.status] ?? r.status}) ---`, r.diagnostic.trimEnd());
            const verdict = !result.ok ? 'Des contrôles échouent.'
                : result.stage === 'task' && !rows.length ? 'Aucun contrôle de tâche à exécuter.'
                    : result.stage === 'task' ? 'Tous les contrôles de tâche passent.'
                        : result.notRequired.length ? `Tous les contrôles requis passent ; ${result.notRequired.length} non requis par leur portée (${result.notRequired.join(', ')}), non lancé(s) : apv gates verify recalcule leur portée depuis le commit.`
                            : 'Tous les contrôles passent.';
            const reserved = result.reserved.length
                ? ` ${result.reserved.length} contrôle(s) ${RESERVED}, non exécuté(s) : la suite complète (apv gates run --stage full) les vérifie.` : '';
            const targeted = result.targeted.length
                ? ` ${result.targeted.length} contrôle(s) ${TARGETED}(s) (${result.targeted.join(', ')}) : seuls les tests concernés par les changements ont tourné ; la suite complète (apv gates run --stage full) les exécute en entier.` : '';
            lines.push('', `${verdict}${targeted}${reserved} Reçus : ${relative(io.cwd, result.directory) || result.directory}` +
                (result.shared?.directory ? ` ; copie partagée : ${result.shared.directory} (exécution ${result.runId})` : ''));
            if (result.shared?.error)
                lines.push(`Attention : copie dans le magasin partagé impossible (${cleanLine(result.shared.error, 300)}) ; ces reçus disparaîtront avec ce worktree.`);
            io.stdout(`${lines.join('\n')}\n`);
        }
        if (received)
            return signalExitCode(received);
        return result.ok ? EXIT.ok : EXIT.failed;
    });
}
function count(value, name, min, max) {
    if (value === undefined)
        return undefined;
    const n = Number(value);
    if (typeof value !== 'string' || !Number.isInteger(n) || n < min || n > max)
        throw new UsageError(`--${name} attend un entier entre ${min} et ${max}`);
    return n;
}
/** `apv gates receipts list|export|prune`: the runs of the worktree and of the shared store of the repository. */
async function receipts(args, values, io) {
    const [sub, ...rest] = args;
    if (sub !== 'list' && sub !== 'export' && sub !== 'prune')
        throw new UsageError(sub ? `sous-commande inconnue : gates receipts ${sub}` : 'sous-commande manquante (list, export, prune)');
    const allowed = { list: ['commit', 'limit'], export: ['out'], prune: ['keep-days', 'keep-runs', 'config'] };
    const foreign = ['only', 'config', 'base', 'concurrency', 'stage', 'commit', 'skip-proven', 'run', 'reason', 'keep-going', 'allow-dirty', 'commit-config', 'limit', 'out', 'keep-days', 'keep-runs', 'stacks']
        .filter(k => values[k] !== undefined && !allowed[sub].includes(k));
    if (foreign.length)
        throw new UsageError(`option inattendue pour gates receipts ${sub} : --${foreign.join(', --')}`);
    const repo = gitRoot(repoPath(io, values['repo']));
    const store = await sharedStore(new Git(), repo);
    const localRoot = join(repo, RECEIPTS_DIR);
    if (sub === 'export') {
        if (rest.length !== 1)
            throw new UsageError('gates receipts export attend un identifiant d\'exécution');
        if (typeof values['out'] !== 'string' || !values['out'])
            throw new UsageError('gates receipts export attend --out <dossier>');
        const result = exportRun(repo, localRoot, store, rest[0], resolve(io.cwd, values['out']));
        if (values['json'])
            json(io, { ok: true, ...result });
        else
            io.stdout(`Exécution ${result.runId} exportée (${result.source === 'shared' ? SHARED : 'worktree'}) : ${result.directory}, ${result.files.length} fichier(s) et manifest.json (empreintes sha256).\n`);
        return EXIT.ok;
    }
    if (rest.length)
        throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
    if (sub === 'prune') {
        const configured = receiptRetention(loadConfig(repo, typeof values['config'] === 'string' ? values['config'] : undefined).config);
        const retention = { keepDays: count(values['keep-days'], 'keep-days', 1, 3650) ?? configured.keepDays, keepRuns: count(values['keep-runs'], 'keep-runs', 1, 100000) ?? configured.keepRuns };
        const result = pruneStore(store, retention);
        if (values['json'])
            json(io, { ok: true, store, ...retention, ...result });
        else
            io.stdout(`Magasin partagé ${store} : ${result.removed.length} exécution(s) retirée(s), ${result.kept} gardée(s) (${retention.keepDays} jours, ${retention.keepRuns} exécutions au plus)${result.temporary ? `, ${result.temporary} copie(s) interrompue(s) retirée(s)` : ''}.\n`);
        return EXIT.ok;
    }
    const limit = count(values['limit'], 'limit', 1, 100000) ?? 20;
    let commit = null;
    if (typeof values['commit'] === 'string') {
        commit = resolveCommit(repo, values['commit']);
        if (!commit)
            throw new PipelineError('SHA', `Commit introuvable : ${values['commit']}`);
    }
    const runs = listRuns(localRoot, store).filter(r => !commit || r.candidateSha === commit);
    const shown = runs.slice(0, limit);
    if (values['json']) {
        json(io, { ok: true, store, total: runs.length, runs: shown });
        return EXIT.ok;
    }
    const where = (r) => [r.local ? 'worktree' : '', r.shared ? (r.intact ? SHARED : `${SHARED}, altérée : ${r.reason}`) : ''].filter(Boolean).join(' + ');
    const verdict = (r) => r.ok === null ? '-' : r.ok ? 'réussi' : 'échec';
    io.stdout(`${[`Exécutions (${shown.length} sur ${runs.length}${commit ? `, commit ${commit.slice(0, 12)}` : ''}) ; magasin partagé : ${store}`, '',
        runs.length ? table(['exécution', 'commit', 'stage', 'verdict', 'arbre', 'emplacement'], shown.map(r => [r.runId, r.candidateSha?.slice(0, 12) ?? '-', r.stage ?? '-', verdict(r),
            r.dirty === null ? '-' : r.dirty ? 'modifié' : 'propre', where(r)])) : 'Aucune exécution.'].join('\n')}\n`);
    return EXIT.ok;
}
//# sourceMappingURL=gates.js.map