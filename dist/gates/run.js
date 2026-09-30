import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gateStage, validateReceipt, webRecordSchema } from '../domain/contracts.js';
import { errorMessage, invariant } from '../domain/errors.js';
import { hash } from '../domain/hash.js';
import { environmentIdentity, executableIdentity, proofKey } from '../evidence/key.js';
import { Git } from '../execution/git.js';
import { environment, expandCommand, redact, runProcess } from '../execution/process.js';
import { failureExcerpt, MAX_DIAGNOSTIC_CHARS } from '../engine/diagnostic.js';
import { schedule, success } from '../engine/scheduler.js';
import { suiteSettings } from '../config/load.js';
import { PipelineError } from '../domain/errors.js';
import { WEB_RECORD } from '../web/impact.js';
import { publishRun, pruneStore, receiptRetention, sharedStore } from './store.js';
import { readPreviewState } from '../preview/state.js';
import { repositoryWorktrees } from '../execution/procs.js';
import { flockFree, markStacksUsed, resolveStacks, stacksOfLock, stoppedSince } from '../stacks/idle.js';
import { defaultLockDir } from '../lock/store.js';
import { planSpread, prepareCopies, removeCopies, stackLock, stackVariables } from './spread.js';
import { fixedWaitRefusal, referenceMissing, mergeBase, optionLikeFile, planRepeat, repeatArgv, repeatDiagnostic, repeatFailures, resolveReference, tooManyFiles } from './repeat.js';
import { planScope, scopeRecord, scopeReferenceMissing } from './proof-scope.js';
import { FLOCK_TIMEOUT_EXIT, SUITE_MARKER, cleanupSuite, commonPath, enterQueue, flockCommand, freePorts, resolveGateLock, withGateLease } from './suite.js';
/** Receipts of `apv gates run`, one directory per execution. Machine evidence, not versioned. */
export const RECEIPTS_DIR = '.apv/receipts';
/** Environment identity of a V3 local run; V2 read it from `environment.id`, a field V3 no longer reads. */
export const ENVIRONMENT_ID = 'apv3-local';
/** Files of a `git status --porcelain=v1 -z` output, as `XY path` lines. */
export function statusLines(porcelain) {
    const parts = porcelain.split('\0');
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (entry.length < 4)
            continue;
        out.push(`${entry.slice(0, 2)} ${entry.slice(3)}`);
        if (/[RC]/.test(entry.slice(0, 2)))
            i += 1;
    }
    return out;
}
/** The refusal of a full suite on a working tree with uncommitted changes, listing them (50 at most). */
export function dirtyRefusal(porcelain, when = '') {
    const lines = statusLines(porcelain);
    const shown = lines.slice(0, 50).map(l => `  ${l}`).join('\n');
    return new PipelineError('GATE_DIRTY', `Suite complète refusée${when} : l'arbre de travail a des modifications non commitées (${lines.length} fichier(s)), ` +
        `ses reçus ne prouveraient rien (apv gates verify les refuse) :\n${shown}${lines.length > 50 ? `\n  ... et ${lines.length - 50} autre(s)` : ''}\n` +
        'Commiter (ou retirer) ces fichiers, puis relancer ; --allow-dirty la lance quand même, reçus non prouvants.');
}
/** A run that executes at least one check of stage full in full: the full suite, under its queue and guards. */
export const isFullSuite = (gates, stage) => stage === 'full' && gates.some(g => gateStage(g) === 'full');
/** Lines of a test output that name tests: `pattern` (capture group 1 when present), ANSI codes removed, 100 at most. */
export function failedTests(pattern, output) {
    if (!pattern)
        return [];
    const re = new RegExp(pattern);
    const found = new Set();
    for (const raw of output.split('\n')) {
        // eslint-disable-next-line no-control-regex
        const line = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
        const m = re.exec(line);
        const name = m ? (m[1] ?? m[0]).trim().slice(0, 500) : '';
        if (name)
            found.add(name);
        if (found.size >= 100)
            break;
    }
    return [...found];
}
/** Selected gates in configuration order, with their transitive dependencies. */
export function selectGates(gates, only = []) {
    if (!only.length)
        return { gates: [...gates], added: [] };
    const byId = new Map(gates.map(g => [g.id, g]));
    const unknown = only.filter(id => !byId.has(id));
    invariant(!unknown.length, 'GATE_UNKNOWN', `Unknown gate: ${unknown.join(', ')}. Configured: ${[...byId.keys()].join(', ') || 'none'}`);
    const chosen = new Set();
    const include = (id) => { if (chosen.has(id))
        return; chosen.add(id); byId.get(id).dependsOn.forEach(include); };
    only.forEach(include);
    return { gates: gates.filter(g => chosen.has(g.id)), added: [...chosen].filter(id => !only.includes(id)) };
}
/**
 * Checks a stage requires (`run`), the full checks a task stage runs through their targeted `affected` command
 * (`targeted`, never proof of the full check) and the selected checks it leaves to the full suite (`reserved`).
 */
export function stageGates(gates, stage) {
    if (stage === 'full')
        return { run: [...gates], targeted: [], reserved: [] };
    const full = gates.filter(g => gateStage(g) === 'full');
    return { run: gates.filter(g => gateStage(g) === 'task'), targeted: full.filter(g => g.affected), reserved: full.filter(g => !g.affected) };
}
/** Identity of the declared checks and passed variables, recorded in every receipt and compared by `apv gates verify`. */
export function gatesConfigHash(config) {
    return hash({ gates: config.gates, passEnv: config.environment.passEnv });
}
const HELD_BY = {
    'other-copy': 'une autre copie du dépôt', 'main-checkout': 'le checkout principal', tool: 'un outil protégé', protected: 'la session',
    outside: 'un processus hors du dépôt', 'unknown-cwd': 'un processus au dossier illisible',
};
/** Why a full suite cannot start: ports of the suite held by others, declared stacks whose lock is held. */
export function busyReasons(ports, stacks, free = flockFree, previewPorts = []) {
    const out = (ports?.left ?? []).map(p => `port ${p.ports.join(', ')} tenu par le pid ${p.pid} (${HELD_BY[p.reason] ?? p.reason}${p.worktree ? ` : ${p.worktree}` : ''}) : ${p.command.slice(0, 100)}` +
        `${p.ports.some(port => previewPorts.includes(port)) ? ' ; c\'est le serveur de l\'aperçu vivant : apv preview stop (depuis le checkout qui l\'a lancé), puis relancer la suite' : ''}`);
    for (const s of stacks)
        if (s.lockFile && free(s.lockFile) === false)
            out.push(`pile ${s.id} : son verrou (${s.lockFile}) est tenu`);
    return out;
}
/** Share of its timeout beyond which a receipt warns (`nearTimeout`): 85 %. */
export const NEAR_TIMEOUT = 0.85;
/**
 * The warning of a receipt whose longest pass took at least 85 % of the timeout of its check (a relaunch has its own
 * timeout: each pass is compared alone), or null. A pass that ran out of time is at 100 % or more.
 */
export function nearTimeout(receipt, timeoutMs) {
    if (!timeoutMs || receipt.status === 'blocked' || receipt.status === 'not_required' || receipt.status === 'cached')
        return null;
    const longest = receipt.retry ? Math.max(receipt.retry.first.durationMs, receipt.durationMs - receipt.retry.first.durationMs) : receipt.durationMs;
    const ratio = longest / timeoutMs;
    return ratio >= NEAR_TIMEOUT ? { timeoutMs, percent: Math.min(1_000_000, Math.max(85, Math.floor(ratio * 100))) } : null;
}
/**
 * Runs configured checks in the project working tree: dependency graph, named resources and read/write
 * exclusion through the V2 scheduler, only the declared variables passed, each command bounded by its
 * timeout, secrets redacted from diagnostics. Each receipt is validated and written as JSON.
 * Extracted from the V2 controller validation step, without its disposable worktree, its receipt cache
 * or its approval state: an implementer runs this in the worktree it owns.
 */
export async function runGates(options) {
    const git = new Git(options.signal);
    const repo = await git.root(options.repo);
    const candidateSha = await git.sha(repo);
    const baseSha = options.base ? await git.sha(repo, options.base) : null;
    const treeStatus = () => git.exec(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const treeOf = (dir) => dir === repo ? treeStatus() : git.exec(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    let status = await treeStatus();
    let dirty = status !== '';
    const stage = options.stage ?? 'full';
    const log = options.log ?? (() => { });
    const selection = selectGates(options.config.gates, options.only);
    invariant(selection.gates.length > 0, 'NO_GATES', 'No checks configured; declare gates in .apv/config.json');
    const { added } = selection;
    const staged = stageGates(selection.gates, stage);
    const { reserved } = staged;
    const targeted = new Set(staged.targeted.map(g => g.id));
    // Configuration order; a targeted check keeps its id, dependencies and resources, with its targeted command.
    const gates = selection.gates.filter(g => staged.run.includes(g) || targeted.has(g.id))
        .map(g => targeted.has(g.id) ? { ...g, command: g.affected } : g);
    const asked = isFullSuite(gates, stage);
    if (options.stacks) {
        invariant(asked, 'GATE_STACKS', '--stacks répartit une suite complète : aucun contrôle de stage full à exécuter en entier ici');
        invariant(options.stacks.length >= 2 && new Set(options.stacks).size === options.stacks.length, 'GATE_STACKS', '--stacks attend au moins deux piles différentes, par exemple --stacks 1,2');
        invariant((options.config.stacks ?? []).length >= 2, 'GATE_STACKS', '--stacks : déclarer au moins deux piles (section stacks de .apv/config.json)');
    }
    // A full suite on a dirty tree proves nothing: refused before any wait, unless asked for.
    if (asked && dirty && !options.allowDirty)
        throw dirtyRefusal(status);
    // The scope of the proof (`skipWhenOnly`), decided before any wait: at the full stage, a check whose change only
    // touches files without effect on it is recorded as not required instead of running. Same rigour as repeatChanged:
    // --base required, HEAD strictly below it, the reference resolved; the paths are those of the reference.
    const scopeDecisions = new Map();
    const scoped = stage === 'full' ? gates.filter(g => g.skipWhenOnly) : [];
    if (scoped.length) {
        invariant(baseSha, 'GATE_BASE', `${scoped.map(g => g.id).join(', ')} déclare(nt) skipWhenOnly : --base <base de la branche> est obligatoire à la suite complète (la portée se compte depuis elle et depuis la référence).`);
        invariant(await mergeBase(git, repo, baseSha, candidateSha) !== candidateSha, 'GATE_BASE', `--base ${options.base} : HEAD n'en descend pas strictement (base égale à HEAD, ou en aval) ; la portée de ${scoped.map(g => g.id).join(', ')} ne peut pas se compter. Donner la base de la branche (le commit d'où elle part).`);
        for (const g of scoped) {
            const name = options.reference ?? g.skipWhenOnly.reference;
            const resolved = await resolveReference(git, repo, name);
            if (!resolved.sha)
                throw new PipelineError('GATE_BASE', scopeReferenceMissing(g.id, name, resolved.reason));
        }
        const all = await planScope(git, repo, options.config, { base: baseSha, head: candidateSha, dirty, configFile: options.configFile ?? null,
            ...(options.reference ? { reference: options.reference } : {}) });
        for (const g of scoped)
            if (all.has(g.id))
                scopeDecisions.set(g.id, all.get(g.id));
    }
    const skipped = new Set([...scopeDecisions.values()].filter(d => !d.required).map(d => d.gateId));
    for (const d of scopeDecisions.values())
        log(`${d.gateId} : ${d.required ? 'requis' : 'non requis'} (portée, skipWhenOnly) : ${d.reason}.`);
    // What actually runs: a check not required is never started (its dependents are not required either).
    const runnable = gates.filter(g => !skipped.has(g.id));
    const suite = isFullSuite(runnable, stage);
    const context = { workspace: repo, candidateSha, ...(baseSha ? { baseSha } : {}) };
    // Placeholders are resolved before anything runs: a missing --base never fails halfway through a batch.
    const expand = (g, argv) => {
        try {
            return expandCommand(argv, context);
        }
        catch (error) {
            invariant(!/\{\{baseSha\}\}/.test(argv.join(' ')) || baseSha, 'GATE_BASE', `Le contrôle ${g.id} utilise {{baseSha}} : passez --base <branche de base>, par exemple apv gates run --base origin/main (la base du passage entre dans la preuve).`);
            throw error;
        }
    };
    const commands = new Map(gates.map(g => [g.id, expand(g, g.command)]));
    const retries = new Map(gates.filter(g => g.retryFailed).map(g => [g.id, expand(g, g.retryFailed.command)]));
    const repeats = new Map(gates.filter(g => g.repeatChanged).map(g => [g.id, expand(g, repeatArgv(g.repeatChanged))]));
    // The changed test files each check repeats, decided before any wait: a ceiling exceeded or a refused fixed wait
    // stops the run here, explicitly, rather than after a full suite or by a silent skip. Null: no --base to compare to.
    const repeatPlans = new Map();
    const repeating = runnable.filter(g => g.repeatChanged);
    if (repeating.length) {
        // Without a base, or with one HEAD does not strictly descend from, nothing would be repeated: refused, never a silent pass.
        invariant(baseSha, 'GATE_BASE', `${repeating.map(g => g.id).join(', ')} déclare(nt) repeatChanged : --base <base de la branche> est obligatoire (les tests ajoutés ou modifiés depuis elle sont répétés).`);
        invariant(await mergeBase(git, repo, baseSha, candidateSha) !== candidateSha, 'GATE_BASE', `--base ${options.base} : HEAD n'en descend pas strictement (base égale à HEAD, ou en aval) ; aucun test modifié ne serait répété pour ${repeating.map(g => g.id).join(', ')}. Donner la base de la branche (le commit d'où elle part).`);
    }
    for (const g of repeating) {
        const settings = g.repeatChanged;
        // A check run in full also compares to the reference (the branch the change goes to): a --base too close cannot narrow it.
        let reference = null;
        if (stage === 'full' && !targeted.has(g.id)) {
            const name = options.repeatReference ?? settings.reference;
            const resolved = await resolveReference(git, repo, name);
            reference = resolved.sha;
            if (!reference)
                throw new PipelineError('GATE_BASE', referenceMissing(g.id, name, resolved.reason));
        }
        const plan = await planRepeat(git, repo, { base: baseSha, reference }, settings);
        const optionLike = plan.files.find(f => f.startsWith('-'));
        if (optionLike)
            throw optionLikeFile(g.id, optionLike);
        if (options.repeatCeiling !== false && plan.files.length > settings.maxFiles)
            throw tooManyFiles(g.id, plan, settings);
        if (plan.fixedWaits.length && settings.fixedWaits === 'refuse')
            throw fixedWaitRefusal(g.id, plan.fixedWaits);
        for (const w of plan.fixedWaits)
            log(`${g.id} : attente à durée fixe dans un test modifié, ${w.file}:${w.line} : ${w.text} (attendre un fait observable ; page.clock pour le temps).`);
        repeatPlans.set(g.id, plan);
    }
    // The queue of the full suites, then the load: every timeout of a check starts after them.
    const settings = suiteSettings(options.config);
    let queue = null;
    // Set once the run has an id: the end of a full suite stops what it started, even when it is interrupted.
    let started = null;
    let cleanup = null;
    let spread = null;
    let webRecords = null;
    const endSuite = async (runId) => {
        if (!suite || cleanup)
            return cleanup;
        try {
            cleanup = await cleanupSuite(repo, runId, settings.ports, { log });
        }
        catch (error) {
            log(`Fin de suite : nettoyage des processus en échec (${errorMessage(error)}).`);
        }
        return cleanup;
    };
    if (suite && settings.queue.enabled) {
        queue = await enterQueue({ lockFile: await commonPath(git, repo, settings.queue.lockFile), settings: settings.queue, repo, log, signal: options.signal, hooks: options.hooks });
    }
    try {
        let ports = null;
        if (suite) {
            // The copy may have changed during the wait: the run is on the commit and tree it was asked for, or not at all.
            if (queue && queue.record.waitedMs + (queue.record.load?.waitedMs ?? 0) > 0) {
                const head = await git.sha(repo);
                if (head !== candidateSha)
                    throw new PipelineError('GATE_DIRTY', `Suite complète refusée : HEAD est passé de ${candidateSha.slice(0, 12)} à ${head.slice(0, 12)} pendant l'attente de la file. Relancer sur le nouveau commit.`);
                const now = await treeStatus();
                if (now !== status) {
                    if (now !== '' && !options.allowDirty)
                        throw dirtyRefusal(now, ' (arbre modifié pendant l\'attente de la file)');
                    status = now;
                    dirty = now !== '';
                }
            }
            if (settings.ports.length)
                ports = await freePorts(repo, settings.ports, { log });
            // One full suite at a time on a test stack, and no e2e beside it: a port of the suite held by another copy,
            // the main checkout or a tool, or a declared stack whose lock is held, refuses the suite before anything runs.
            const previews = [repo, repositoryWorktrees(repo)[0] ?? repo].map(r => { try {
                return readPreviewState(r)?.port ?? null;
            }
            catch {
                return null;
            } }).filter((x) => x !== null);
            const busy = busyReasons(ports, options.config.stacks?.length ? resolveStacks(options.config, await commonPath(git, repo, '.')) : [], flockFree, previews);
            if (busy.length) {
                throw new PipelineError('GATE_BUSY', `Suite complète refusée, rien n'a été exécuté : ${busy.join(' ; ')}. Une autre suite, un e2e lancé par un agent ou un serveur ` +
                    'utilise déjà la pile de test : deux exécutions en même temps rendent les tests instables. Attendre sa fin (apv lock status, apv stacks status), ' +
                    'ou l\'arrêter s\'il est orphelin (apv procs list, puis apv procs stop --port <p>), puis relancer.');
            }
        }
        const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomUUID().slice(0, 8)}`;
        started = runId;
        const directory = join(repo, RECEIPTS_DIR, runId);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        // Where `apv web audit`, run by a check, writes its record (`APV_WEB_RECORD`), outside the copy.
        webRecords = mkdtempSync(join(tmpdir(), 'apv-web-record-'));
        // Receipts are local evidence: keep them out of diffs, scope checks and commits, before any gate
        // (a gate that checks the working tree is clean must not see the receipts of its siblings).
        const ignore = join(repo, RECEIPTS_DIR, '.gitignore');
        if (!existsSync(ignore))
            writeFileSync(ignore, '*\n');
        const configHash = gatesConfigHash(options.config);
        // The declared test stacks: a check under the lock of one of them notes its use (apv stacks idle-stop reads it).
        const common = options.config.stacks?.length ? await commonPath(git, repo, '.') : null;
        const stacks = common ? resolveStacks(options.config, common) : [];
        const source = options.env ?? process.env;
        // A suite spread over stacks: checks dealt to the stacks, the copies of the other stacks made now.
        if (options.stacks && common) {
            spread = await planSpread({ git, repo, common, config: options.config, gates: runnable, ids: options.stacks, runId });
            log(`Répartition sur les piles : ${[...spread.assignments.values()].map(a => `${a.gateId} sur la pile ${a.stack.id}${a.workspace === repo ? '' : ` (copie ${a.workspace})`}`).join(', ') || 'aucun contrôle de pile'}.`);
            for (const a of spread.assignments.values())
                if (a.notPassed.length)
                    log(`Note : ${a.gateId} ne reçoit pas ${a.notPassed.join(', ')} du fichier d'environnement de la pile ${a.stack.id} (absents de son passEnv).`);
            await prepareCopies(spread, { git, repo, sha: candidateSha, config: options.config, env: source, signal: options.signal, log });
        }
        // A stack stopped by idle-stop and not restarted: said before the checks, not discovered as a refused connection.
        const stoppedStacks = [];
        if (common) {
            for (const gate of runnable) {
                const assignedStack = spread?.assignments.get(gate.id)?.stack.id;
                if (!gate.lock && !assignedStack)
                    continue;
                const ids = assignedStack ? [assignedStack]
                    : stacksOfLock(stacks, await resolveGateLock(git, repo, gate.lock, environment([...options.config.environment.passEnv, ...gate.passEnv], source), source));
                for (const id of ids) {
                    const since = stoppedSince(common, id);
                    if (!since)
                        continue;
                    const entry = stoppedStacks.find(x => x.stack === id) ?? (stoppedStacks.push({ stack: id, since, gates: [] }), stoppedStacks[stoppedStacks.length - 1]);
                    entry.gates.push(gate.id);
                }
            }
            for (const x of stoppedStacks)
                log(`ATTENTION : la pile ${x.stack} a été arrêtée par apv stacks idle-stop le ${x.since} et rien ne montre qu'elle ait redémarré depuis ; ${x.gates.join(', ')} la verrouille(nt). Redémarrer d'abord : apv stacks start ${x.stack}.`);
        }
        const keys = new Map();
        const override = options.override ? { run: options.override.run, reason: options.override.reason } : null;
        const write = (receipt) => {
            const decision = scopeDecisions.get(receipt.gateId);
            const near = nearTimeout(receipt, gates.find(g => g.id === receipt.gateId)?.timeoutMs);
            if (near)
                log(`ATTENTION : ${receipt.gateId} a pris ${near.percent} % de son délai (${Math.round(near.timeoutMs / 1000)} s) : augmenter timeoutMs de ce contrôle avant qu'il ne casse une preuve.`);
            const valid = validateReceipt({ ...receipt, stage, dirty, ...(targeted.has(receipt.gateId) ? { targeted: true } : {}), ...(override ? { override } : {}),
                ...(decision ? { scope: scopeRecord(decision) } : {}), ...(near ? { nearTimeout: near } : {}) });
            writeFileSync(join(directory, `${valid.gateId}.json`), JSON.stringify(valid, null, 2) + '\n');
            return valid;
        };
        const execute = async (gate, signal) => {
            const startedAt = Date.now();
            const webRecord = join(webRecords, `${gate.id}.json`);
            const elapsedStart = performance.now();
            // On a stack of `--stacks`: its copy, its variables (over those of the check) and its lock.
            const assigned = spread?.assignments.get(gate.id) ?? null;
            const workspace = assigned?.workspace ?? repo;
            const env = { ...environment([...options.config.environment.passEnv, ...gate.passEnv], source),
                ...(assigned ? stackVariables(assigned.stack, gate, options.config.environment.passEnv) : {}) };
            const command = workspace === repo ? commands.get(gate.id) : expandCommand(targeted.has(gate.id) ? gate.affected : gate.command, { ...context, workspace });
            let executable = null;
            try {
                executable = await executableIdentity(command[0], workspace, env);
            }
            catch { /* reported as spawn_error below */ }
            const environmentHash = environmentIdentity(ENVIRONMENT_ID, env, { executable });
            const key = proofKey({ repository: repo, baseSha: baseSha ?? candidateSha, candidateSha, taskHash: hash(null), configHash, environmentHash,
                workspace, gate: { ...gate, command }, dependencyKeys: gate.dependsOn.map(d => keys.get(d) ?? hash(null)),
                executable: executable ?? { path: command[0], sha256: hash('unresolved') } });
            keys.set(gate.id, key);
            const base = { id: randomUUID(), runId, gateId: gate.id, key, candidateSha, configHash, environmentHash, startedAt, reusedFrom: null,
                ...(assigned ? { stack: assigned.stack.id } : {}) };
            const copyError = assigned ? spread.copies.find(c => c.dir === workspace)?.error ?? null : null;
            if (copyError)
                return write({ ...base, status: 'spawn_error', durationMs: 0, exitCode: null, stdoutHash: '', stderrHash: '',
                    diagnostic: `Copie de la pile ${assigned.stack.id} non préparée : ${copyError}. La commande n'a pas été lancée.` });
            if (!executable)
                return write({ ...base, status: 'spawn_error', durationMs: performance.now() - elapsedStart, exitCode: null,
                    stdoutHash: '', stderrHash: '', diagnostic: `Executable unavailable: ${command[0]}` });
            const secrets = { ...env, ...source };
            const excerpt = (r, limit = MAX_DIAGNOSTIC_CHARS) => redact(failureExcerpt(r.status, r.stderr, r.stdout, limit), secrets).slice(0, limit);
            const exitOf = (r) => r.exitCode !== null && r.exitCode >= 0 && r.exitCode <= 255 ? r.exitCode : null;
            const lock = assigned ? stackLock(assigned.stack, gate, defaultLockDir(source)) : gate.lock ? await resolveGateLock(git, repo, gate.lock, env, source) : null;
            const withLockWait = (ms) => lock ? { lockWaitMs: Math.round(ms) } : {};
            /** One pass of a command, under the flock of the check when it has one: the timeout starts once it is held. */
            const pass = async (argv, checkEnv, timeoutMs = gate.timeoutMs) => {
                // The marker of a full suite, outside the environment identity: its processes are found at its end.
                // The record file of `apv web audit`, outside the environment identity too: emptied before each pass.
                rmSync(webRecord, { force: true });
                const passEnv = { ...(suite ? { ...checkEnv, [SUITE_MARKER]: runId } : checkEnv), [WEB_RECORD]: webRecord };
                if (lock?.kind !== 'flock') {
                    const result = await runProcess({ command: argv, cwd: workspace, env: passEnv, timeoutMs, signal, maxOutputBytes: 1024 * 1024 });
                    return { result, commandMs: result.durationMs, lockWaitMs: 0, lockError: null };
                }
                const result = await runProcess({ command: flockCommand(lock.file, lock.waitMs, argv), cwd: workspace, env: passEnv, timeoutMs, signal,
                    maxOutputBytes: 1024 * 1024, waitReady: true });
                if (result.readyMs === null || result.readyMs === undefined) {
                    const lockError = result.status === 'cancelled' ? null
                        : result.status === 'spawn_error' ? `flock introuvable (util-linux) pour le verrou ${lock.file} : ${result.stderr.slice(0, 500)}`
                            : result.exitCode === FLOCK_TIMEOUT_EXIT ? `Verrou flock ${lock.file} non obtenu après ${Math.round(lock.waitMs / 1000)} s (lock.waitMs) : la commande n'a pas été lancée.`
                                : `flock en échec pour le verrou ${lock.file} (code ${result.exitCode ?? '-'}) : ${redact(result.stderr, secrets).slice(0, 2000)}`;
                    const status = result.status === 'cancelled' ? 'cancelled' : result.status === 'spawn_error' ? 'spawn_error' : result.exitCode === FLOCK_TIMEOUT_EXIT ? 'timed_out' : 'failed';
                    return { result: { ...result, status }, commandMs: 0, lockWaitMs: result.durationMs, lockError };
                }
                return { result, commandMs: result.durationMs - result.readyMs, lockWaitMs: result.readyMs, lockError: null };
            };
            /** The record of `apv web audit` left by the last pass, when the command is one: added to the receipt. */
            const withWebRecord = (fields) => {
                try {
                    return { ...fields, web: webRecordSchema.parse(JSON.parse(readFileSync(webRecord, 'utf8'))) };
                }
                catch {
                    return fields;
                }
                finally {
                    rmSync(webRecord, { force: true });
                }
            };
            const lockRefused = (reason, waitedMs) => write({ ...base, status: 'timed_out', durationMs: 0, exitCode: null,
                stdoutHash: '', stderrHash: '', diagnostic: `Verrou du contrôle non obtenu : ${reason}. La commande n'a pas été lancée.`, lockWaitMs: Math.round(waitedMs) });
            /** The command, and its single relaunch (`retryFailed`): the fields of the receipt, before any repetition. */
            const main = async (passEnv, leaseWaitMs) => {
                const first = await pass(command, passEnv);
                let lockWaitMs = leaseWaitMs + first.lockWaitMs;
                const r1 = first.result;
                if (first.lockError !== null || r1.status === 'cancelled' && first.commandMs === 0 && lock?.kind === 'flock') {
                    return ({ ...base, status: r1.status, durationMs: 0, exitCode: null, stdoutHash: '', stderrHash: '',
                        diagnostic: first.lockError ?? 'cancelled', ...withLockWait(lockWaitMs) });
                }
                const plain = () => ({ ...base, status: r1.status, durationMs: first.commandMs, exitCode: exitOf(r1),
                    stdoutHash: r1.stdoutHash, stderrHash: r1.stderrHash, diagnostic: r1.status === 'passed' ? '' : excerpt(r1), ...withLockWait(lockWaitMs) });
                const retryCommand = retries.has(gate.id) && workspace !== repo ? expandCommand(gate.retryFailed.command, { ...context, workspace }) : retries.get(gate.id);
                // Only a command that failed by itself is relaunched: a timeout, a cancellation or a missing command is not.
                if (r1.status !== 'failed' || !retryCommand)
                    return plain();
                const tests = failedTests(gate.retryFailed.testPattern, `${r1.stdout}\n${r1.stderr}`).map(t => redact(t, secrets));
                const firstPass = { status: 'failed', exitCode: exitOf(r1), durationMs: first.commandMs, stdoutHash: r1.stdoutHash, stderrHash: r1.stderrHash, diagnostic: excerpt(r1, 8000) };
                // Same commit, same tree: otherwise the relaunch would prove other code.
                const head = await git.sha(workspace);
                const now = workspace === repo ? await treeStatus() : await git.exec(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
                if (head !== candidateSha || now !== (workspace === repo ? status : '')) {
                    return ({ ...base, status: 'failed', durationMs: first.commandMs, exitCode: exitOf(r1), stdoutHash: r1.stdoutHash, stderrHash: r1.stderrHash,
                        diagnostic: `Relance refusée : ${head !== candidateSha ? 'HEAD a changé' : 'l\'arbre de travail a changé'} pendant la première passe (la relance ne prouverait pas le même code).\n${excerpt(r1, MAX_DIAGNOSTIC_CHARS - 300)}`,
                        ...withLockWait(lockWaitMs) });
                }
                log(`${gate.id} : échec (code ${exitOf(r1) ?? '-'}) ; relance unique des tests en échec (retryFailed)${tests.length ? ` : ${tests.slice(0, 5).join(' ; ')}${tests.length > 5 ? ' ...' : ''}` : ''}.`);
                const second = await pass(retryCommand, passEnv);
                lockWaitMs += second.lockWaitMs;
                const r2 = second.result;
                const output = redact(`${r2.stdout}\n${r2.stderr}`.trim(), secrets).slice(-4000);
                const retry = { command: retryCommand, first: firstPass, output, tests };
                const durationMs = first.commandMs + second.commandMs;
                if (second.lockError === null && r2.status === 'passed') {
                    log(`${gate.id} : réussi après relance (instable).`);
                    return ({ ...base, status: 'passed_after_retry', durationMs, exitCode: 0, stdoutHash: r2.stdoutHash, stderrHash: r2.stderrHash,
                        diagnostic: `Réussi après relance (retryFailed) : première passe en échec (code ${firstPass.exitCode ?? '-'})${tests.length ? ` ; tests relancés : ${tests.join(' ; ')}` : ''}.\n${excerpt(r1, 8000)}`.slice(0, MAX_DIAGNOSTIC_CHARS),
                        retry, ...withLockWait(lockWaitMs) });
                }
                const failure = second.lockError ?? excerpt(r2, MAX_DIAGNOSTIC_CHARS - 300);
                return ({ ...base, status: r2.status === 'passed' ? 'failed' : r2.status, durationMs, exitCode: second.lockError === null ? exitOf(r2) : null,
                    stdoutHash: second.lockError === null ? r2.stdoutHash : '', stderrHash: second.lockError === null ? r2.stderrHash : '',
                    diagnostic: `Relance (retryFailed) en échec aussi :\n${failure}`.slice(0, MAX_DIAGNOSTIC_CHARS), retry, ...withLockWait(lockWaitMs) });
            };
            /**
             * The repetition of the changed test files (`repeatChanged`), once the command passed (after its relaunch
             * included), under the same lock: never relaunched, and any failure turns the check red whatever `retryFailed`
             * said. Without a plan (no --base), no changed file or a command that did not pass, only recorded.
             */
            const repeated = async (fields, passEnv, before) => {
                const settings = gate.repeatChanged;
                const plan = repeatPlans.get(gate.id);
                if (!settings || !plan)
                    return fields;
                const times = settings.times;
                const record = { base: plan.base, reference: plan.reference, files: plan.files, times, fixedWaits: plan.fixedWaits };
                if (!plan.files.length)
                    return { ...fields, repeat: { ...record, status: 'none', failures: [] } };
                const afterRetry = fields.status === 'passed_after_retry';
                if (fields.status !== 'passed' && !afterRetry)
                    return { ...fields, repeat: { ...record, status: 'not_run', failures: [] } };
                const prefix = workspace === repo ? repeats.get(gate.id) : expandCommand(repeatArgv(settings), { ...context, workspace });
                const withWait = (ms) => lock ? { lockWaitMs: Math.round((fields.lockWaitMs ?? 0) + ms) } : {};
                // Same commit, same tree as just before the command of the check: otherwise the repetition would prove other code.
                const head = await git.sha(workspace);
                const tree = await treeOf(workspace);
                if (!before || head !== before.head || tree !== before.tree) {
                    const was = new Set(statusLines(before?.tree ?? ''));
                    const now = new Set(statusLines(tree));
                    const changes = [...[...now].filter(l => !was.has(l)).map(l => `+ ${l}`), ...[...was].filter(l => !now.has(l)).map(l => `- ${l}`)];
                    const why = !before ? 'état de l\'arbre avant la commande inconnu'
                        : head !== before.head ? `HEAD est passé de ${before.head.slice(0, 12)} à ${head.slice(0, 12)} pendant la commande du contrôle`
                            : `l'arbre de travail a changé pendant la commande du contrôle (${changes.length} entrée(s) de git status : ${changes.slice(0, 10).join(' ; ')}${changes.length > 10 ? ' ...' : ''})`;
                    return { ...fields, status: 'failed', exitCode: null, repeat: { ...record, status: 'failed', command: prefix, failures: [] },
                        diagnostic: `Répétition des tests modifiés refusée : ${why} ; elle ne prouverait pas le même code. Une commande de contrôle ne doit écrire que des fichiers ignorés par Git.` };
                }
                log(`${gate.id} : répétition des tests modifiés (repeatChanged), ${times} fois chacun : ${plan.files.join(', ')}${settings.stressArgs ? ` ; charge : ${settings.stressArgs.join(' ')}` : ''}.`);
                const timeoutMs = settings.timeoutMs ?? gate.timeoutMs;
                const run = await pass([...prefix, ...plan.files], passEnv, timeoutMs);
                const r = run.result;
                const output = `${r.stdout}\n${r.stderr}`;
                const pattern = settings.testPattern ?? gate.retryFailed?.testPattern;
                const failures = run.lockError === null ? repeatFailures(pattern, output).map(f => ({ ...f, test: redact(f.test, secrets).slice(0, 500) })) : [];
                const durationMs = fields.durationMs + run.commandMs;
                const repeat = { ...record, command: prefix, durationMs: run.commandMs, exitCode: run.lockError === null ? exitOf(r) : null, failures,
                    output: redact(output.trim(), secrets).slice(-4000) };
                if (run.lockError === null && r.status === 'passed') {
                    log(`${gate.id} : répétition des tests modifiés réussie (${plan.files.length} fichier(s), ${times} fois).`);
                    return { ...fields, durationMs, repeat: { ...repeat, status: 'passed' }, ...withWait(run.lockWaitMs) };
                }
                const failed = r.status === 'passed' ? 'failed' : r.status;
                log(`${gate.id} : répétition des tests modifiés en échec (${failed})${failures.length ? ` : ${failures.slice(0, 5).map(f => `${f.test} échoue ${f.count} fois sur ${times}`).join(' ; ')}` : ''}.`);
                const diagnostic = repeatDiagnostic({ files: plan.files, times, failures, afterRetry, status: failed, timeoutMs, hasPattern: pattern !== undefined,
                    excerpt: run.lockError ?? excerpt(r, 6000) });
                return { ...fields, status: failed, durationMs, exitCode: repeat.exitCode, stdoutHash: run.lockError === null ? r.stdoutHash : '', stderrHash: run.lockError === null ? r.stderrHash : '',
                    diagnostic: diagnostic.slice(0, MAX_DIAGNOSTIC_CHARS), repeat: { ...repeat, status: failed }, ...withWait(run.lockWaitMs) };
            };
            const body = async (passEnv, leaseWaitMs) => {
                // The state the repetition must find again: taken just before the command, under the lock.
                const plan = repeatPlans.get(gate.id);
                const before = plan?.files.length ? { head: await git.sha(workspace), tree: await treeOf(workspace) } : null;
                return write(await repeated(withWebRecord(await main(passEnv, leaseWaitMs)), passEnv, before));
            };
            const used = lock && common ? stacksOfLock(stacks, lock) : [];
            let outcome = null;
            try {
                if (lock?.kind === 'lease') {
                    outcome = await withGateLease(lock, { label: `apv gates run ${gate.id} (${workspace})`, env, source, signal, log, hooks: options.hooks }, body, lockRefused);
                    return outcome;
                }
                outcome = await body(env, 0);
                return outcome;
            }
            finally {
                if (used.length && common)
                    markStacksUsed(common, used, outcome !== null && success(outcome));
            }
        };
        const blocked = (gate, reason) => write({ id: randomUUID(), runId, gateId: gate.id, key: hash({ blocked: gate.id, candidateSha }), candidateSha, configHash,
            environmentHash: hash('not-executed'), status: 'blocked', startedAt: Date.now(), durationMs: 0, exitCode: null,
            stdoutHash: '', stderrHash: '', diagnostic: reason, reusedFrom: null });
        const failFast = options.failFast ?? true;
        // The checks not required: a receipt that says so, with the scope, and nothing run.
        const notRequired = new Map(gates.filter(g => skipped.has(g.id)).map(g => {
            const d = scopeDecisions.get(g.id);
            return [g.id, write({ id: randomUUID(), runId, gateId: g.id, key: hash({ notRequired: g.id, candidateSha, configHash, base: d.base, reference: d.reference, referenceSha: d.referenceSha }),
                    candidateSha, configHash, environmentHash: hash('not-executed'), status: 'not_required', startedAt: Date.now(), durationMs: 0, exitCode: null,
                    stdoutHash: '', stderrHash: '', diagnostic: `Non requis (portée, skipWhenOnly) : ${d.reason}.`.slice(0, MAX_DIAGNOSTIC_CHARS), reusedFrom: null })];
        }));
        let list;
        if (!spread?.copies.length) {
            list = await schedule(runnable, { concurrency: options.concurrency ?? 3, failFast, signal: options.signal ?? new AbortController().signal, execute, blocked });
        }
        else {
            // One scheduler per copy (each has its own workspace), run together; a failure stops them all under failFast.
            const stop = new AbortController();
            const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
            const inCopy = new Set(spread.copies.flatMap(c => c.gates));
            const groups = [runnable.filter(g => !inCopy.has(g.id)), ...spread.copies.map(c => runnable.filter(g => c.gates.includes(g.id)))].filter(g => g.length);
            const run = async (gate, s) => {
                const receipt = await execute(gate, s);
                if (failFast && !success(receipt))
                    stop.abort();
                return receipt;
            };
            const results = await Promise.all(groups.map(group => schedule(group, { concurrency: options.concurrency ?? 3, failFast, signal, execute: run, blocked })));
            const byId = new Map(results.flat().map(r => [r.gateId, r]));
            list = runnable.map(g => byId.get(g.id));
        }
        const ran = new Map(list.map(r => [r.gateId, r]));
        list = gates.map(g => notRequired.get(g.id) ?? ran.get(g.id));
        const flaky = list.filter(r => r.status === 'passed_after_retry').map(r => r.gateId);
        await endSuite(runId);
        const spreadRecord = spread ? [...spread.assignments.values()].map(a => ({ gate: a.gateId, stack: a.stack.id, workspace: a.workspace, notPassed: a.notPassed,
            error: spread.copies.find(c => c.dir === a.workspace)?.error ?? null })) : null;
        const result = { runId, repo, candidateSha, baseSha, dirty, stage, selected: gates.map(g => g.id), added,
            reserved: reserved.map(g => g.id), targeted: [...targeted], receipts: list, directory, shared: null, suite, notRequired: [...notRequired.keys()], scope: [...scopeDecisions.values()],
            queue: queue?.record ?? null, ports, flaky, cleanup, stoppedStacks, spread: spreadRecord, ok: list.every(r => success(r) || r.status === 'not_required') };
        writeFileSync(join(directory, 'summary.json'), JSON.stringify({ runId, candidateSha, baseSha, dirty, stage, ok: result.ok, selected: result.selected, added,
            reserved: result.reserved, targeted: result.targeted, ...(override ? { override } : {}),
            ...(suite ? { suite: true, queue: result.queue, ports, flaky, cleanup } : {}), ...(spreadRecord ? { spread: spreadRecord } : {}), ...(stoppedStacks.length ? { stoppedStacks } : {}),
            receipts: list.map(r => ({ gateId: r.gateId, id: r.id, status: r.status, ...(r.targeted ? { targeted: true } : {}), exitCode: r.exitCode, durationMs: Math.round(r.durationMs),
                ...(r.lockWaitMs !== undefined ? { lockWaitMs: r.lockWaitMs } : {}), ...(r.retry ? { retriedTests: r.retry.tests } : {}), ...(r.stack ? { stack: r.stack } : {}),
                ...(r.nearTimeout ? { nearTimeout: r.nearTimeout } : {}),
                ...(r.repeat ? { repeat: { status: r.repeat.status, files: r.repeat.files, times: r.repeat.times, failures: r.repeat.failures } } : {}),
                ...(r.scope ? { scope: { required: r.scope.required, reason: r.scope.reason, fileCount: r.scope.fileCount } } : {}),
                ...(r.web ? { web: { required: r.web.required, auditId: r.web.auditId, ok: r.web.ok } } : {}) })) }, null, 2) + '\n');
        if (options.share !== false)
            result.shared = await shareRun(git, repo, directory, runId, candidateSha, options.config);
        return result;
    }
    finally {
        if (webRecords)
            rmSync(webRecords, { recursive: true, force: true });
        if (started)
            await endSuite(started);
        if (spread)
            await removeCopies(spread, git, repo, log);
        await queue?.release();
    }
}
/**
 * Copies a finished run into the shared store of the repository, so that it survives its worktree, then applies
 * the retention of the store. A failure is reported, never fatal: the run and its local receipts stand.
 */
async function shareRun(git, repo, directory, runId, candidateSha, config) {
    let target;
    let store;
    try {
        store = await sharedStore(git, repo);
        target = publishRun(store, directory, runId, candidateSha, repo);
    }
    catch (error) {
        return { directory: null, error: errorMessage(error), pruned: null };
    }
    let pruned = null;
    try {
        pruned = pruneStore(store, receiptRetention(config));
    }
    catch { /* Retention is retried by the next run. */ }
    return { directory: target, error: null, pruned };
}
//# sourceMappingURL=run.js.map