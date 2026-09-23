import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError, errorMessage, invariant } from '../domain/errors.js';
import { s } from '../domain/schema.js';
import { LockStore, defaultLockDir } from '../lock/store.js';
import { describeHolder } from '../lock/run.js';
/** Resume state of a spec execution: `.apv/state/run-<spec-id>.json`, versioned with the project (spec section 8). */
export const RUN_STATE_DIR = '.apv/state';
export const runStateFile = (repo, specId) => join(repo, RUN_STATE_DIR, `run-${specId}.json`);
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'];
/** Steps of `/apv:run` in their order (spec section 8); the task waves happen between `plan` and `integration`. */
export const STEPS = ['data-model', 'plan', 'integration', 'reviews', 'fixes', 'delivery'];
/** Independent reviews (spec section 8, step 5): security, fidelity, data, GDPR. */
export const REVIEWS = ['securite', 'fidelite', 'donnees', 'rgpd'];
export const STATUS_LABEL = { pending: 'à faire', running: 'en cours', done: 'fait', failed: 'en échec', skipped: 'sauté' };
export const STEP_LABEL = {
    'data-model': 'modèle de données', plan: 'plan', waves: 'vagues', integration: 'intégration', reviews: 'revues', fixes: 'corrections', delivery: 'livraison',
};
const status = s.enum(STATUSES);
const text = (max) => s.nullable(s.string(0, max));
// Dates as written by Date#toISOString, nothing else: a free text here would reach the summary lines.
const at = s.string(24, 24, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const sha = s.nullable(s.string(7, 64, /^[a-f0-9]{7,64}$/));
const key = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// `commit` is optional on steps and reviews: states written before it existed stay readable.
const stepSchema = s.object({ status, commit: s.default(sha, null), note: text(4000), updatedAt: s.nullable(at) });
const taskSchema = s.object({
    title: s.string(1, 500), dependsOn: s.array(s.string(1, 80, key), 0, 20), wave: s.number(0, 1000), status,
    branch: text(300), worktree: text(4096), agentId: text(300), base: sha, commit: sha, note: text(4000), updatedAt: s.nullable(at),
});
const reviewSchema = s.object({ status, findings: s.nullable(s.number(0, 100000)), commit: s.default(sha, null), note: text(4000), updatedAt: s.nullable(at) });
const eventSchema = s.object({
    at, target: s.string(1, 200), from: s.nullable(status), to: status,
    note: s.optional(s.string(0, 4000)), commit: s.optional(s.string(7, 64)), agentId: s.optional(s.string(0, 300)),
});
export const runStateSchema = s.object({
    schemaVersion: s.literal(1),
    specId: s.string(1, 80, RUN_ID), specFile: s.string(1, 4096), specSha256: s.string(64, 64, /^[a-f0-9]{64}$/),
    base: s.string(1, 300), baseSha: s.string(40, 64, /^[a-f0-9]{40,64}$/), branch: s.string(1, 300),
    createdAt: at, updatedAt: at,
    steps: s.object({
        'data-model': stepSchema, plan: stepSchema, integration: stepSchema, reviews: stepSchema, fixes: stepSchema, delivery: stepSchema,
    }),
    waves: s.array(s.object({ index: s.number(0, 1000), foundation: s.boolean(), tasks: s.array(s.string(1, 80, key), 1, 100) }), 0, 1000),
    tasks: s.record(key, taskSchema, 100),
    reviews: s.object({ securite: reviewSchema, fidelite: reviewSchema, donnees: reviewSchema, rgpd: reviewSchema }),
    events: s.array(eventSchema, 0, 100000),
});
const parseState = (value) => runStateSchema.parse(value);
/**
 * Waves by topological layers of `dependsOn`. The spec format has no « foundation » marker (its task schema
 * refuses unknown properties), so the foundations are the first-layer tasks other tasks depend on: they form
 * wave 0, alone, written before the parallel waves open (incident 24). The other first-layer tasks join
 * wave 1 with the tasks of depth 1; a task of depth d is in wave d. Without any dependency, every task is in
 * wave 0. Tasks keep the order of the spec inside a wave. The graph must be acyclic (validated spec).
 */
export function computeWaves(tasks) {
    const byId = new Map(tasks.map(t => [t.id, t]));
    const depth = new Map();
    const visiting = new Set();
    const visit = (id) => {
        const known = depth.get(id);
        if (known !== undefined)
            return known;
        invariant(!visiting.has(id), 'RUN_DAG', `Cycle de dépendances à la tâche ${id}`);
        const task = byId.get(id);
        invariant(task, 'RUN_DAG', `Dépendance inconnue : ${id}`);
        visiting.add(id);
        const d = task.dependsOn.length ? 1 + Math.max(...task.dependsOn.map(visit)) : 0;
        visiting.delete(id);
        depth.set(id, d);
        return d;
    };
    tasks.forEach(t => visit(t.id));
    const dependedOn = new Set(tasks.flatMap(t => t.dependsOn));
    const foundations = tasks.filter(t => depth.get(t.id) === 0 && dependedOn.has(t.id)).map(t => t.id);
    const waveOf = (id) => {
        const d = depth.get(id);
        return foundations.length && d === 0 && !dependedOn.has(id) ? 1 : d;
    };
    const indexes = [...new Set(tasks.map(t => waveOf(t.id)))].sort((a, b) => a - b);
    return indexes.map(index => ({ index, foundation: index === 0 && foundations.length > 0, tasks: tasks.filter(t => waveOf(t.id) === index).map(t => t.id) }));
}
export function createRunState(input) {
    const now = (input.now ?? new Date()).toISOString();
    const waves = computeWaves(input.tasks);
    const waveOf = new Map(waves.flatMap(w => w.tasks.map(id => [id, w.index])));
    const step = () => ({ status: 'pending', note: null, updatedAt: null });
    const review = () => ({ status: 'pending', findings: null, note: null, updatedAt: null });
    const tasks = {};
    for (const t of input.tasks) {
        Object.defineProperty(tasks, t.id, { enumerable: true, writable: true, configurable: true, value: {
                title: t.title, dependsOn: [...t.dependsOn], wave: waveOf.get(t.id), status: 'pending', branch: null, worktree: null, agentId: null,
                base: null, commit: null, note: null, updatedAt: null,
            } });
    }
    return parseState({
        schemaVersion: 1, specId: input.specId, specFile: input.specFile, specSha256: input.specSha256, base: input.base, baseSha: input.baseSha,
        branch: `apv/${input.specId}`, createdAt: now, updatedAt: now,
        steps: Object.fromEntries(STEPS.map(n => [n, step()])),
        waves, tasks, reviews: Object.fromEntries(REVIEWS.map(n => [n, review()])),
        events: [{ at: now, target: 'run', from: null, to: 'running', note: `exécution créée depuis ${input.specFile} (base ${input.base} à ${input.baseSha.slice(0, 12)})` }],
    });
}
/** `data-model`, `task:<id>` or `review:<domaine>`; null when the text names none of them. */
export function parseTarget(value) {
    if (STEPS.includes(value))
        return { kind: 'step', name: value };
    if (value.startsWith('task:') && key.test(value.slice(5)))
        return { kind: 'task', id: value.slice(5) };
    if (value.startsWith('review:') && REVIEWS.includes(value.slice(7)))
        return { kind: 'review', domain: value.slice(7) };
    return null;
}
export const targetName = (t) => t.kind === 'step' ? t.name : t.kind === 'task' ? `task:${t.id}` : `review:${t.domain}`;
/**
 * Allowed moves. Staying on the same status only updates the fields (a new wip commit, another agent).
 * Leaving `done` reopens finished work, and replacing the commit of finished work changes what was delivered:
 * both need a note that says why.
 */
const TRANSITIONS = {
    pending: ['running', 'done', 'skipped', 'failed'],
    running: ['done', 'failed', 'pending', 'skipped'],
    failed: ['pending', 'running', 'skipped'],
    skipped: ['pending', 'running'],
    done: ['running', 'pending'],
};
/** Refused transition: exit 1 (a control failed), unlike a malformed call. */
export class TransitionError extends PipelineError {
    constructor(message) { super('RUN_TRANSITION', message); }
}
/**
 * Applies `apv run set` to a copy of the state and returns it with the event it added. Checks the transition,
 * the dependencies of a task that starts (all `done`), and the commit of a task that ends (`--commit`).
 * Commit existence is checked by the caller, which owns the repository.
 */
export function applySet(state, target, options) {
    const next = structuredClone(state);
    const now = (options.now ?? new Date()).toISOString();
    const name = targetName(target);
    const entry = target.kind === 'step' ? next.steps[target.name] : target.kind === 'review' ? next.reviews[target.domain] : Object.hasOwn(next.tasks, target.id) ? next.tasks[target.id] : undefined;
    if (!entry)
        throw new PipelineError('RUN_TARGET', `Tâche inconnue dans l'exécution ${state.specId} : ${target.kind === 'task' ? target.id : name}`);
    const from = entry.status;
    const to = options.status;
    if (from !== to && !TRANSITIONS[from].includes(to))
        throw new TransitionError(`${name} : passage de « ${from} » à « ${to} » refusé (possibles : ${TRANSITIONS[from].join(', ')})`);
    if (from === 'done' && to !== 'done' && !options.note?.trim())
        throw new TransitionError(`${name} : rouvrir un travail terminé exige --note (la raison est journalisée)`);
    // The commit of finished work is what integration and reviews rely on: changing it is a decision to journal.
    const recorded = entry.commit;
    if (from === 'done' && to === 'done' && options.commit !== undefined && recorded !== null && options.commit !== recorded && !options.note?.trim()) {
        throw new TransitionError(`${name} : remplacer le commit d'un travail terminé (${recorded.slice(0, 12)}) exige --note (la raison est journalisée)`);
    }
    if (target.kind === 'task') {
        const task = entry;
        if (to === 'running') {
            const waiting = task.dependsOn.filter(dep => next.tasks[dep]?.status !== 'done');
            if (waiting.length)
                throw new TransitionError(`${name} : dépendance(s) pas encore faite(s) : ${waiting.map(d => `${d} (${next.tasks[d]?.status ?? 'inconnue'})`).join(', ')}`);
        }
        if (to === 'done' && !options.commit)
            throw new TransitionError(`${name} : une tâche faite exige --commit <sha> (le commit qui la porte)`);
        if (options.branch !== undefined)
            task.branch = options.branch;
        if (options.worktree !== undefined)
            task.worktree = options.worktree;
        if (options.agentId !== undefined)
            task.agentId = options.agentId;
        if (options.base !== undefined)
            task.base = options.base;
        if (options.commit !== undefined)
            task.commit = options.commit;
    }
    else if (options.commit !== undefined)
        entry.commit = options.commit;
    if (target.kind === 'review' && options.findings !== undefined)
        entry.findings = options.findings;
    if (options.note !== undefined)
        entry.note = options.note;
    entry.status = to;
    entry.updatedAt = now;
    next.updatedAt = now;
    const event = { at: now, target: name, from, to,
        ...(options.note !== undefined ? { note: options.note } : {}), ...(options.commit !== undefined ? { commit: options.commit } : {}),
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}) };
    next.events.push(event);
    return { state: parseState(next), from, event };
}
const finished = (st) => st === 'done' || st === 'skipped';
/** Where the execution stands: the first unfinished step, with the waves between `plan` and `integration`. */
export function currentStep(state) {
    const unfinishedTasks = Object.values(state.tasks).filter(t => !finished(t.status));
    const wave = unfinishedTasks.length ? Math.min(...unfinishedTasks.map(t => t.wave)) : null;
    for (const name of STEPS) {
        if (name === 'integration' && unfinishedTasks.length)
            return { step: 'waves', wave };
        if (!finished(state.steps[name].status))
            return { step: name, wave };
    }
    return { step: null, wave };
}
/**
 * `apv run next`: what to do now, deterministic, the basis of resuming after an interruption. A running task
 * whose worktree is gone, or that has no commit after its base (`--base` given when it started, else the base
 * of the execution), is to relaunch if its agent no longer runs.
 */
export function computeNext(state, probe) {
    const { step, wave } = currentStep(state);
    const tasks = Object.entries(state.tasks);
    const ready = tasks.filter(([, t]) => t.status === 'pending' && t.dependsOn.every(d => state.tasks[d]?.status === 'done'))
        .map(([id, t]) => ({ id, title: t.title, wave: t.wave })).sort((a, b) => a.wave - b.wave);
    const blocked = tasks.filter(([, t]) => t.status === 'pending' && !t.dependsOn.every(d => state.tasks[d]?.status === 'done'))
        .map(([id, t]) => ({ id, waitingOn: t.dependsOn.filter(d => state.tasks[d]?.status !== 'done') }));
    const failed = tasks.filter(([, t]) => t.status === 'failed').map(([id, t]) => ({ id, note: t.note }));
    const resume = [];
    const relaunch = [];
    for (const [id, t] of tasks.filter(([, x]) => x.status === 'running')) {
        const base = t.base ?? state.baseSha;
        const item = { id, branch: t.branch, worktree: t.worktree, agentId: t.agentId, commit: t.commit, head: null, commitsAfterBase: null, base };
        let reason = null;
        if (t.worktree && !probe.exists(t.worktree))
            reason = `worktree absent : ${t.worktree}`;
        else {
            const head = (t.branch ? probe.resolve(t.branch) : null) ?? (t.worktree ? probe.resolve('HEAD', t.worktree) : null);
            item.head = head;
            if (!head)
                reason = t.branch ? `branche introuvable : ${t.branch}` : 'ni branche ni worktree enregistrés';
            else {
                item.commitsAfterBase = probe.countAfter(base, head, t.branch ? undefined : t.worktree ?? undefined);
                if (!item.commitsAfterBase)
                    reason = `aucun commit après la base ${base.slice(0, 12)}`;
            }
        }
        if (reason)
            relaunch.push({ ...item, reason });
        else
            resume.push(item);
    }
    const tasksFinished = tasks.every(([, t]) => finished(t.status));
    const integrated = tasksFinished && finished(state.steps.integration.status);
    const reviewsToLaunch = integrated ? REVIEWS.filter(r => ['pending', 'failed'].includes(state.reviews[r].status)) : [];
    const reviewsRunning = REVIEWS.filter(r => state.reviews[r].status === 'running');
    const allDone = step === null;
    const stepStatus = step && step !== 'waves' ? state.steps[step].status : null;
    const actions = [];
    for (const r of relaunch)
        actions.push(`relancer ${r.id} si son agent ne tourne plus (${r.reason})${r.branch ? `, depuis la branche ${r.branch}` : ''}`);
    for (const r of resume)
        actions.push(`reprendre ${r.id} : agent ${r.agentId ?? 'inconnu'} (SendMessage s'il vit encore), sinon relancer « termine ${r.id} depuis ${r.head?.slice(0, 12)} » sur ${r.branch ?? r.worktree}`);
    for (const f of failed)
        actions.push(`décider de ${f.id} (en échec${f.note ? ` : ${f.note}` : ''}) : relancer, corriger ou sauter`);
    if (step === 'data-model' || step === 'plan')
        actions.push(`étape ${STEP_LABEL[step]} (${STATUS_LABEL[state.steps[step].status]}) : la terminer avant d'ouvrir les vagues`);
    else if (step === 'waves') {
        // The current wave first: the foundations are integrated before the parallel waves open (incident 24).
        const now = ready.filter(r => r.wave === wave);
        const foundation = state.waves.find(w => w.index === wave)?.foundation ? ', fondations, un seul agent' : '';
        if (now.length)
            actions.push(`lancer ${now.length} tâche(s) prête(s) de la vague ${wave}${foundation} : ${now.map(r => r.id).join(', ')}`);
        const later = ready.filter(r => r.wave !== wave);
        if (later.length)
            actions.push(`prêtes mais d'une vague suivante : ${later.map(r => `${r.id} (vague ${r.wave})`).join(', ')} ; à lancer une fois la vague ${wave} intégrée, sauf décision contraire notée`);
        if (!ready.length && !resume.length && !relaunch.length && !failed.length)
            actions.push('aucune tâche prête : vérifier les dépendances bloquées');
    }
    else if (step === 'reviews' && reviewsToLaunch.length)
        actions.push(`lancer les revues : ${reviewsToLaunch.join(', ')}`);
    else if (step)
        actions.push(`étape ${STEP_LABEL[step]} (${STATUS_LABEL[state.steps[step].status]})`);
    if (allDone)
        actions.push('exécution terminée');
    return { specId: state.specId, step, stepStatus, wave, finished: allDone, ready, resume, relaunch, failed, blocked, reviewsToLaunch, reviewsRunning, actions };
}
export function readRunState(file, source = {}) {
    const shown = source.shown ?? file;
    if (!existsSync(file))
        throw new PipelineError('RUN_MISSING', `Aucune exécution : ${shown} n'existe pas (apv run start <spec>)`);
    return parseRunStateText(readFileSync(file, 'utf8'), shown, source.specId);
}
/**
 * Reason of a schema refusal without any text of the file: the paths hold only schema keys, task ids (checked
 * against their pattern before they enter a path) and indexes; a refused property or key name is dropped.
 */
function schemaReason(message) {
    return message.replace(/(unknown property) [\s\S]*$/, '$1').replace(/(invalid key) [\s\S]*?(, expected to match )/, '$1$2');
}
/**
 * Parses and validates the text of a state file. `shown` names it in the errors, which never quote its content
 * (a JSON error keeps only its position). With `specId` (the id its file name carries), a state of another spec
 * is refused: the summary and `apv run next` would otherwise name one execution with the data of another.
 */
export function parseRunStateText(text, shown, specId) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        const position = /at position (\d+)/.exec(errorMessage(error))?.[1];
        throw new PipelineError('RUN_STATE', `État illisible ${shown} : JSON invalide${position ? ` (position ${position})` : ''}`);
    }
    let state;
    try {
        state = parseState(raw);
    }
    catch (error) {
        throw new PipelineError('RUN_STATE', `État invalide ${shown} : ${schemaReason(errorMessage(error))}`);
    }
    if (specId !== undefined && state.specId !== specId) {
        throw new PipelineError('RUN_STATE', `État incohérent ${shown} : son identifiant de spec ne correspond pas au nom du fichier`);
    }
    return state;
}
/** Atomic write: a temporary file in the same directory, flushed, then renamed over the target. */
export function writeRunState(file, state) {
    const dir = join(file, '..');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${file.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o644);
    try {
        writeSync(fd, `${JSON.stringify(runStateSchema.parse(state), null, 2)}\n`);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    try {
        renameSync(tmp, file);
    }
    catch (error) {
        rmSync(tmp, { force: true });
        throw error;
    }
}
/** Every `run-<id>.json` of `.apv/state/`, in name order. */
export function listRunFiles(repo) {
    const dir = join(repo, RUN_STATE_DIR);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir).filter(f => /^run-.+\.json$/.test(f)).sort().map(f => ({ specId: f.slice(4, -5), file: join(dir, f) }));
}
export function summarize(state, file) {
    const counts = Object.fromEntries(STATUSES.map(st => [st, 0]));
    for (const t of Object.values(state.tasks))
        counts[t.status] += 1;
    const { step, wave } = currentStep(state);
    return { specId: state.specId, file, step, wave, finished: step === null, tasks: { ...counts, total: Object.keys(state.tasks).length },
        reviews: Object.fromEntries(REVIEWS.map(r => [r, state.reviews[r].status])), updatedAt: state.updatedAt, error: null };
}
/**
 * One line for `apv status` and `apv run status`. `running` names the running tasks after their count
 * (ids of the state, already restricted to the task id pattern by the schema); the first ones only.
 */
export function summaryLine(sum, running = []) {
    const t = sum.tasks;
    const where = sum.finished ? 'terminée' : `étape ${STEP_LABEL[sum.step]}${sum.step === 'waves' && sum.wave !== null ? ` (vague ${sum.wave})` : ''}`;
    const names = running.length ? ` (${running.slice(0, 5).join(', ')}${running.length > 5 ? ', …' : ''})` : '';
    const extra = [t.running ? `${t.running} en cours${names}` : '', t.failed ? `${t.failed} en échec` : '', t.skipped ? `${t.skipped} sautée(s)` : ''].filter(Boolean).join(', ');
    return `${sum.specId} : ${where} ; tâches ${t.done}/${t.total} faites${extra ? `, ${extra}` : ''} ; mise à jour ${sum.updatedAt}`;
}
/**
 * Runs `fn` under the lease lock `run:<spec-id>` (apv lock), so that two agents never interleave a
 * read-modify-write of the same state. The lock lives in the lock directory of the machine (APV_LOCK_DIR);
 * the wait is 60 s, or APV_RUN_LOCK_WAIT seconds.
 */
export async function withRunLock(specId, env, fn) {
    const configured = Number(env['APV_RUN_LOCK_WAIT']);
    const waitSeconds = env['APV_RUN_LOCK_WAIT'] && Number.isFinite(configured) && configured >= 0 ? configured : 60;
    const poll = env['APV_LOCK_POLL_MS'] ? Number(env['APV_LOCK_POLL_MS']) : undefined;
    const store = new LockStore(defaultLockDir(env), poll && Number.isFinite(poll) ? { pollMs: poll } : {});
    const resource = `run:${specId}`;
    const owner = { pid: process.pid, host: store.host, label: env['APV_LOCK_LABEL'] || env['USER'] || 'apv run' };
    const result = await store.acquire(resource, { owner, ttlSeconds: 120, waitSeconds, purpose: `apv run (${specId})` });
    if (!result.ok)
        throw new PipelineError('RUN_LOCKED', `Verrou « ${resource} » non obtenu après ${waitSeconds} s : tenu par ${describeHolder(result.holder)}`);
    try {
        return await fn();
    }
    finally {
        await store.release(resource, { token: result.record.token });
    }
}
//# sourceMappingURL=state.js.map