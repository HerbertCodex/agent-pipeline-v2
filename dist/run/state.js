import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError, errorMessage, invariant } from '../domain/errors.js';
import { s } from '../domain/schema.js';
import { LockStore, defaultLockDir } from '../lock/store.js';
import { describeHolder } from '../lock/run.js';
import { MAX_RUN_STATE_BYTES, readBounded } from './bounded-read.js';
import { localTime } from '../domain/time.js';
/** Resume state of a spec execution: `.apv/state/run-<spec-id>.json`, versioned with the project (spec section 8). */
export const RUN_STATE_DIR = '.apv/state';
export const runStateFile = (repo, specId) => join(repo, RUN_STATE_DIR, `run-${specId}.json`);
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'];
/** Steps of `/apv:run` in their order (spec section 8); the task waves happen between `plan` and `integration`. */
export const STEPS = ['data-model', 'plan', 'integration', 'reviews', 'fixes', 'delivery'];
/** Independent reviews (spec section 8, step 5): security, fidelity, data, GDPR. */
export const REVIEWS = ['securite', 'fidelite', 'donnees', 'rgpd'];
/**
 * Confidence of a finished task or fix pass (docs/CONFIANCE.md), noted by the project lead with `apv run set --confidence`:
 * `prouve` (reproducible proof), `probable` (read or reasoned, not run), `suppose` (hypothesis). Ordered from the strongest.
 */
export const CONFIDENCE_LEVELS = ['prouve', 'probable', 'suppose'];
/** Steps that may carry a confidence: the fix pass (its tasks carry their own). */
export const CONFIDENCE_STEPS = ['fixes'];
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
// Optional, absent until the project lead notes one: a state written before it existed reads and writes as before.
const confidence = s.optional(s.enum(CONFIDENCE_LEVELS));
// `commit` is optional on steps and reviews: states written before it existed stay readable.
const stepSchema = s.object({ status, commit: s.default(sha, null), note: text(4000), updatedAt: s.nullable(at), confidence });
const taskSchema = s.object({
    title: s.string(1, 500), dependsOn: s.array(s.string(1, 80, key), 0, 20), wave: s.number(0, 1000), foundation: s.boolean(), status,
    branch: text(300), worktree: text(4096), agentId: text(300), base: sha, commit: sha, note: text(4000), updatedAt: s.nullable(at), confidence,
});
const reviewSchema = s.object({ status, findings: s.nullable(s.number(0, 100000)), commit: s.default(sha, null), note: text(4000), updatedAt: s.nullable(at) });
const eventSchema = s.object({
    at, target: s.string(1, 200), from: s.nullable(status), to: status,
    note: s.optional(s.string(0, 4000)), commit: s.optional(s.string(7, 64)), agentId: s.optional(s.string(0, 300)),
    // Dependencies not integrated when the task was started anyway (`--force-unintegrated`).
    unintegrated: s.optional(s.array(s.string(1, 80, key), 1, 20)),
    // End of a quota pause (`apv run pause --until`), on the event that starts or extends it.
    until: s.optional(at),
    // Confidence noted with the transition (`apv run set --confidence`).
    confidence,
});
/** A quota pause of the execution (`apv run pause`): since when, until when, why. Absent when not paused. */
const pauseSchema = s.object({ since: at, until: at, note: text(4000) });
/**
 * Version 2: the foundation marker moved from the wave (v1, « the whole wave 0 ») to the task. A v1 state is
 * migrated when read (`migrateRunState`) and written back as v2 on its next write.
 */
export const RUN_STATE_VERSION = 2;
export const runStateSchema = s.object({
    schemaVersion: s.literal(RUN_STATE_VERSION),
    specId: s.string(1, 80, RUN_ID), specFile: s.string(1, 4096), specSha256: s.string(64, 64, /^[a-f0-9]{64}$/),
    base: s.string(1, 300), baseSha: s.string(40, 64, /^[a-f0-9]{40,64}$/), branch: s.string(1, 300),
    createdAt: at, updatedAt: at,
    steps: s.object({
        'data-model': stepSchema, plan: stepSchema, integration: stepSchema, reviews: stepSchema, fixes: stepSchema, delivery: stepSchema,
    }),
    waves: s.array(s.object({ index: s.number(0, 1000), tasks: s.array(s.string(1, 80, key), 1, 100) }), 0, 1000),
    tasks: s.record(key, taskSchema, 100),
    reviews: s.object({ securite: reviewSchema, fidelite: reviewSchema, donnees: reviewSchema, rgpd: reviewSchema }),
    events: s.array(eventSchema, 0, 100000),
    // Optional: absent when the execution is not paused, so that a state never paused reads as before.
    pause: s.optional(pauseSchema),
});
const parseState = (value) => runStateSchema.parse(migrateRunState(value));
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * A state of version 1 in the shape of version 2, the plan it recorded kept: under the v1 rule a wave marked
 * `foundation` held only foundations, so each of its tasks becomes a foundation task, every other task is not
 * one, and the wave loses its marker. Anything else is returned as is, for the schema to judge. Pure: the
 * input is never modified.
 */
export function migrateRunState(value) {
    if (!isRecord(value) || value['schemaVersion'] !== 1 || !Array.isArray(value['waves']) || !isRecord(value['tasks']))
        return value;
    const tasks = value['tasks'];
    const marked = new Set();
    const waves = value['waves'].map(w => {
        if (!isRecord(w) || typeof w['foundation'] !== 'boolean')
            return w;
        const { foundation, ...rest } = w;
        if (foundation && Array.isArray(w['tasks']))
            for (const id of w['tasks'])
                if (typeof id === 'string')
                    marked.add(id);
        return rest;
    });
    const migrated = {};
    for (const [id, task] of Object.entries(tasks)) {
        const value = isRecord(task) && !Object.hasOwn(task, 'foundation') ? { ...task, foundation: marked.has(id) } : task;
        Object.defineProperty(migrated, id, { value, enumerable: true, writable: true, configurable: true });
    }
    return { ...value, schemaVersion: RUN_STATE_VERSION, waves, tasks: migrated };
}
/** Least number of tasks that depend directly on a task for it to be a foundation. */
export const FOUNDATION_MIN_DEPENDENTS = 2;
/**
 * Waves: the topological layers of `dependsOn`. A task of depth d (0 without dependency, else one more than
 * its deepest dependency) is in wave d. Tasks keep the order of the spec inside a wave. The graph must be
 * acyclic (validated spec).
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
    const indexes = [...new Set(depth.values())].sort((a, b) => a - b);
    return indexes.map(index => ({ index, tasks: tasks.filter(t => depth.get(t.id) === index).map(t => t.id) }));
}
/**
 * The longest chain of dependencies, from a task without dependency to the deepest task: as many tasks as
 * `computeWaves` has layers. Ties go to the first task in spec order, then to the first dependency listed.
 * Empty for no task; the graph must be acyclic (validated spec).
 */
export function longestChain(tasks) {
    const waves = computeWaves(tasks);
    const last = waves.at(-1);
    if (!last)
        return [];
    const depth = new Map(waves.flatMap(w => w.tasks.map(id => [id, w.index])));
    const byId = new Map(tasks.map(t => [t.id, t]));
    const chain = [last.tasks[0]];
    for (let task = byId.get(chain[0]); task?.dependsOn.length;) {
        const deepest = Math.max(...task.dependsOn.map(d => depth.get(d)));
        const previous = task.dependsOn.find(d => depth.get(d) === deepest);
        chain.unshift(previous);
        task = byId.get(previous);
    }
    return chain;
}
/**
 * The foundations: the tasks at least FOUNDATION_MIN_DEPENDENTS other tasks depend on directly, in spec order.
 * They write what several tasks share (incident 24); in their wave, one agent writes them while the other tasks
 * of the wave run in parallel. One dependent is not enough: a task that only one other task needs is an
 * ordinary dependency (the phase 3 trial had BIN wait alone because DOCS depended on it).
 */
export function computeFoundations(tasks) {
    const dependents = new Map();
    for (const t of tasks)
        for (const dep of new Set(t.dependsOn))
            dependents.set(dep, (dependents.get(dep) ?? 0) + 1);
    return tasks.filter(t => (dependents.get(t.id) ?? 0) >= FOUNDATION_MIN_DEPENDENTS).map(t => t.id);
}
/** The foundations and the other tasks of one wave, each in wave order. */
export function splitWave(state, wave) {
    const foundations = wave.tasks.filter(id => state.tasks[id]?.foundation === true);
    return { foundations, parallel: wave.tasks.filter(id => !foundations.includes(id)) };
}
export function createRunState(input) {
    const now = (input.now ?? new Date()).toISOString();
    const waves = computeWaves(input.tasks);
    const foundations = new Set(computeFoundations(input.tasks));
    const waveOf = new Map(waves.flatMap(w => w.tasks.map(id => [id, w.index])));
    const step = () => ({ status: 'pending', note: null, updatedAt: null });
    const review = () => ({ status: 'pending', findings: null, note: null, updatedAt: null });
    const tasks = {};
    for (const t of input.tasks) {
        Object.defineProperty(tasks, t.id, { enumerable: true, writable: true, configurable: true, value: {
                title: t.title, dependsOn: [...t.dependsOn], wave: waveOf.get(t.id), foundation: foundations.has(t.id), status: 'pending', branch: null, worktree: null, agentId: null,
                base: null, commit: null, note: null, updatedAt: null,
            } });
    }
    return parseState({
        schemaVersion: RUN_STATE_VERSION, specId: input.specId, specFile: input.specFile, specSha256: input.specSha256, base: input.base, baseSha: input.baseSha,
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
/** The integration head of `state` as the probe sees the repository. */
export function integrationCheck(state, probe) {
    const branchHead = probe.resolve(state.branch);
    const head = branchHead ?? state.baseSha;
    const where = branchHead ? state.branch : `la base ${state.base} (${state.baseSha.slice(0, 12)}), la branche ${state.branch} n'existant pas encore`;
    return { head, where, integrated: commit => commit === head || probe.isAncestor(commit, head) };
}
/**
 * The dependencies of a task split by readiness: `notDone` (not `done`) and `notIntegrated` (`done`, but their
 * commit is missing or not an ancestor of the integration head). A task is ready when both are empty.
 */
export function dependencyGaps(state, task, integration) {
    const notDone = task.dependsOn.filter(d => state.tasks[d]?.status !== 'done');
    const notIntegrated = task.dependsOn.filter(d => {
        const dep = state.tasks[d];
        return dep?.status === 'done' && !(dep.commit && integration?.integrated(dep.commit));
    });
    return { notDone, notIntegrated };
}
/** Refused transition: exit 1 (a control failed), unlike a malformed call. */
export class TransitionError extends PipelineError {
    constructor(message) { super('RUN_TRANSITION', message); }
}
/**
 * Applies `apv run set` to a copy of the state and returns it with the event it added. Checks the transition,
 * the dependencies of a task that starts (all `done`, and integrated: their commit in the integration head,
 * unless `forceUnintegrated` with a note), and the commit of a task that ends (`--commit`).
 * Commit existence is checked by the caller, which owns the repository.
 */
export function applySet(state, target, options) {
    const next = structuredClone(state);
    const now = (options.now ?? new Date()).toISOString();
    const name = targetName(target);
    // Any transition means the work goes on: a pause left open ends here, journaled before the transition.
    if (next.pause) {
        Reflect.deleteProperty(next, 'pause');
        next.events.push({ at: now, target: PAUSE_TARGET, from: 'pending', to: 'running', note: `reprise (première transition après la pause : ${name})` });
    }
    const entry = target.kind === 'step' ? next.steps[target.name] : target.kind === 'review' ? next.reviews[target.domain] : Object.hasOwn(next.tasks, target.id) ? next.tasks[target.id] : undefined;
    if (!entry)
        throw new PipelineError('RUN_TARGET', `Tâche inconnue dans l'exécution ${state.specId} : ${target.kind === 'task' ? target.id : name}`);
    const from = entry.status;
    const to = options.status;
    let unintegrated = null;
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
            const { notDone, notIntegrated } = dependencyGaps(next, task, options.integration);
            if (notDone.length)
                throw new TransitionError(`${name} : dépendance(s) pas encore faite(s) : ${notDone.map(d => `${d} (${next.tasks[d]?.status ?? 'inconnue'})`).join(', ')}`);
            // Checked when the task starts, not when a running task only updates its fields.
            if (from !== 'running' && notIntegrated.length) {
                const list = notIntegrated.map(d => `${d} (commit ${next.tasks[d]?.commit?.slice(0, 12) ?? 'absent'})`).join(', ');
                if (!options.forceUnintegrated) {
                    throw new TransitionError(`${name} : dépendance(s) faite(s) mais pas encore intégrée(s) dans ${options.integration?.where ?? 'la branche de la spec'} : ${list}. ` +
                        'Intègre-les d\'abord ; sinon --force-unintegrated avec --note (la raison est journalisée)');
                }
                if (!options.note?.trim())
                    throw new TransitionError(`${name} : --force-unintegrated exige --note (la raison est journalisée)`);
                unintegrated = notIntegrated;
            }
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
    // The confidence speaks of finished work: it is noted with `done`, and reopening the work drops it.
    if (options.confidence !== undefined) {
        const allowed = target.kind === 'task' || (target.kind === 'step' && CONFIDENCE_STEPS.includes(target.name));
        if (!allowed)
            throw new TransitionError(`${name} : --confidence est réservé aux tâches (task:<id>) et aux corrections (${CONFIDENCE_STEPS.join(', ')})`);
        if (to !== 'done')
            throw new TransitionError(`${name} : --confidence accompagne « done » (le niveau de confiance du travail terminé)`);
        entry.confidence = options.confidence;
    }
    else if (to !== 'done')
        Reflect.deleteProperty(entry, 'confidence');
    entry.status = to;
    entry.updatedAt = now;
    next.updatedAt = now;
    const event = { at: now, target: name, from, to,
        ...(options.note !== undefined ? { note: options.note } : {}), ...(options.commit !== undefined ? { commit: options.commit } : {}),
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}), ...(unintegrated ? { unintegrated } : {}),
        ...(options.confidence !== undefined ? { confidence: options.confidence } : {}) };
    next.events.push(event);
    return { state: parseState(next), from, event };
}
const finished = (st) => st === 'done' || st === 'skipped';
/** Target of the pause and resume events of the journal (`apv run pause`, `apv run resume`). */
export const PAUSE_TARGET = 'pause';
/**
 * `apv run pause`: the execution waits for the quota to reset, until `until`. Written in the state (`pause`) and
 * journaled (event `pause`, `running` to `pending`, with `until`); a second pause extends the first. Refused
 * on a finished execution or with an end that is not in the future.
 */
export function applyPause(state, options) {
    const now = options.now ?? new Date();
    if (currentStep(state).step === null)
        throw new TransitionError(`L'exécution ${state.specId} est terminée : rien à mettre en pause`);
    if (options.until.getTime() <= now.getTime())
        throw new TransitionError(`Fin de pause dans le passé (${localTime(options.until)}) : donner une heure à venir`);
    const next = structuredClone(state);
    const at = now.toISOString();
    const until = options.until.toISOString();
    const note = options.note?.trim() ? options.note : (state.pause?.note ?? null);
    next.pause = { since: state.pause?.since ?? at, until, note };
    next.updatedAt = at;
    const event = { at, target: PAUSE_TARGET, from: 'running', to: 'pending', until, ...(note !== null ? { note } : {}) };
    next.events.push(event);
    return { state: parseState(next), event };
}
/** `apv run resume`: ends the pause, journaled (event `pause`, `pending` to `running`). Refused without a pause. */
export function applyResume(state, options = {}) {
    if (!state.pause)
        throw new TransitionError(`L'exécution ${state.specId} n'est pas en pause`);
    const next = structuredClone(state);
    const at = (options.now ?? new Date()).toISOString();
    Reflect.deleteProperty(next, 'pause');
    next.updatedAt = at;
    const event = { at, target: PAUSE_TARGET, from: 'pending', to: 'running', note: options.note?.trim() ? options.note : 'reprise' };
    next.events.push(event);
    return { state: parseState(next), event };
}
/** Target of the journal event of a full suite run at a step that expected the task level (`apv gates run --reason`). */
export const FULL_SUITE_OVERRIDE_TARGET = 'gates:full';
/** Longest reason of such an override: one or two sentences, written in the state and in every receipt. */
export const MAX_OVERRIDE_REASON = 500;
/**
 * `apv gates run --stage full --reason`: journals a full suite launched while the current step expects the task
 * level (event `gates:full`, with the reason and the commit it runs on). Changes nothing else: no step, task or
 * pause moves.
 */
export function applyFullSuiteOverride(state, options) {
    const reason = options.reason.trim();
    if (!reason || reason.length > MAX_OVERRIDE_REASON)
        throw new TransitionError(`Raison de la dérogation : de 1 à ${MAX_OVERRIDE_REASON} caractères`);
    const next = structuredClone(state);
    const at = (options.now ?? new Date()).toISOString();
    next.updatedAt = at;
    const event = { at, target: FULL_SUITE_OVERRIDE_TARGET, from: null, to: 'running', note: reason, ...(options.commit ? { commit: options.commit } : {}) };
    next.events.push(event);
    return { state: parseState(next), event };
}
/**
 * One journal event for a human, times in local time: `2026-09-24 18:02 UTC+2 task:A en cours -> fait (commit …)`,
 * and for the pauses `… pause quota jusqu'à 20:30 : <note>` or `… reprise : <note>`. The note is data: the
 * caller cleans the line.
 */
export function describeEvent(event) {
    const when = localTime(event.at);
    const note = event.note ? ` : ${event.note}` : '';
    if (event.target === PAUSE_TARGET) {
        return event.to === 'pending' ? `${when} pause quota jusqu'à ${event.until ? localTime(event.until) : '?'}${note}` : `${when} reprise${note}`;
    }
    const commit = event.commit ? ` (commit ${event.commit.slice(0, 12)}${event.confidence ? `, confiance ${event.confidence}` : ''})`
        : event.confidence ? ` (confiance ${event.confidence})` : '';
    if (event.target === FULL_SUITE_OVERRIDE_TARGET)
        return `${when} suite complète lancée hors rythme (niveau attendu : contrôles de tâche et ciblés)${commit}${note}`;
    return `${when} ${event.target} ${event.from ? STATUS_LABEL[event.from] : '-'} -> ${STATUS_LABEL[event.to]}${commit}${note}`;
}
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
 * `apv run next`: what to do now, deterministic, the basis of resuming after an interruption. A task is ready
 * when its dependencies are `done` and their commits integrated in the branch of the spec (or in the base of
 * the execution while that branch does not exist); tasks are launched as soon as they are ready, not wave by
 * wave. A running task
 * whose worktree is gone, or that has no commit after its base (`--base` given when it started, else the base
 * of the execution), is to relaunch if its agent no longer runs.
 */
export function computeNext(state, probe, options = {}) {
    const { step, wave } = currentStep(state);
    const mode = options.fullSuite ?? 'final';
    const tasks = Object.entries(state.tasks);
    const integration = integrationCheck(state, probe);
    const pending = tasks.filter(([, t]) => t.status === 'pending').map(([id, t]) => ({ id, t, gaps: dependencyGaps(state, t, integration) }));
    const ready = pending.filter(p => !p.gaps.notDone.length && !p.gaps.notIntegrated.length)
        .map(({ id, t }) => ({ id, title: t.title, wave: t.wave, foundation: t.foundation })).sort((a, b) => a.wave - b.wave);
    const awaitingIntegration = pending.filter(p => !p.gaps.notDone.length && p.gaps.notIntegrated.length)
        .map(({ id, t, gaps }) => ({ id, wave: t.wave, waitingOn: gaps.notIntegrated })).sort((a, b) => a.wave - b.wave);
    const blocked = pending.filter(p => p.gaps.notDone.length).map(({ id, gaps }) => ({ id, waitingOn: gaps.notDone }));
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
    // The last commit the full suite proved: in `final`, the head of the last integration once it is done; in
    // `each-integration`, the integration head (every integration passed it). Before any, the base of the run.
    const integrationCommit = state.steps.integration.status === 'done' ? state.steps.integration.commit : null;
    const targetBase = mode === 'final' ? integrationCommit ?? state.baseSha : integration.head;
    const targetBaseWhere = mode === 'final'
        ? integrationCommit ? `tête de la dernière intégration (${integrationCommit.slice(0, 12)}), prouvée par la suite complète` : `base de l'exécution (${state.baseSha.slice(0, 12)}) : aucune suite complète depuis`
        : `tête d'intégration (${integration.head.slice(0, 12)}), prouvée par la suite complète à chaque intégration`;
    const level = step === 'waves' ? (mode === 'final' ? 'task' : 'full')
        : step === 'integration' || step === 'delivery' ? 'full' : step === 'fixes' ? (mode === 'final' ? 'task' : 'full') : null;
    const tb = targetBase.slice(0, 12);
    const taskLevel = `apv gates run --stage task --base ${tb} sur la tête intégrée, arbre propre, puis apv gates verify --commit <tête> --stage task --base ${tb} à 0`;
    const fullLevel = 'apv gates run --stage full sur la tête intégrée, arbre propre, puis apv gates verify --commit <tête> à 0';
    if (state.pause) {
        actions.push(`exécution en pause (quota) depuis ${localTime(state.pause.since)} jusqu'à ${localTime(state.pause.until)}${state.pause.note ? ` (${state.pause.note})` : ''} : à la reprise, apv run resume ${state.specId}`);
    }
    for (const r of relaunch)
        actions.push(`relancer ${r.id} si son agent ne tourne plus (${r.reason})${r.branch ? `, depuis la branche ${r.branch}` : ''}`);
    for (const r of resume)
        actions.push(`reprendre ${r.id} : agent ${r.agentId ?? 'inconnu'} (SendMessage s'il vit encore), sinon relancer « termine ${r.id} depuis ${r.head?.slice(0, 12)} » sur ${r.branch ?? r.worktree}`);
    for (const f of failed)
        actions.push(`décider de ${f.id} (en échec${f.note ? ` : ${f.note}` : ''}) : relancer, corriger ou sauter`);
    const unproven = [
        ...tasks.filter(([, t]) => t.status === 'done').map(([id, t]) => ({ target: `task:${id}`, confidence: t.confidence })),
        ...(state.steps.fixes.status === 'done' ? [{ target: 'fixes', confidence: state.steps.fixes.confidence }] : []),
    ].filter((u) => u.confidence === 'probable' || u.confidence === 'suppose');
    for (const u of unproven) {
        actions.push(u.confidence === 'probable'
            ? `${u.target} noté « probable » : une vérification (test ou exécution) d'abord, avant de l'intégrer, de le livrer ou de l'annoncer corrigé`
            : `${u.target} noté « suppose » : à prouver, ou à remonter à l'opérateur avant toute fusion, toute action sur la production et toute annonce « corrigé »`);
    }
    if (step === 'data-model' || step === 'plan')
        actions.push(`étape ${STEP_LABEL[step]} (${STATUS_LABEL[state.steps[step].status]}) : la terminer avant d'ouvrir les vagues`);
    else if (step === 'waves') {
        // Every ready task now, whatever its wave: the foundations to one agent (incident 24), the others in parallel.
        const found = ready.filter(r => r.foundation).map(r => r.id);
        const parallel = ready.filter(r => !r.foundation).map(r => r.id);
        if (ready.length) {
            actions.push(`lancer ${ready.length} tâche(s) prête(s) : ${[found.length ? `fondations (un seul agent) : ${found.join(', ')}` : '',
                parallel.length ? `en parallèle : ${parallel.join(', ')}` : ''].filter(Boolean).join(' ; ')}`);
        }
        const toIntegrate = [...new Set(awaitingIntegration.flatMap(a => a.waitingOn))];
        for (const dep of toIntegrate) {
            const waiting = awaitingIntegration.filter(a => a.waitingOn.includes(dep)).map(a => a.id);
            actions.push(`intégrer ${dep} (commit ${state.tasks[dep]?.commit?.slice(0, 12) ?? 'absent'}) dans ${state.branch} : ${waiting.join(', ')} en attend(ent) l'intégration`);
        }
        if (toIntegrate.length) {
            actions.push(mode === 'final'
                ? `intégration intermédiaire (il reste des tâches), niveau tâche : ${taskLevel} ; la suite complète vient à la dernière intégration`
                : `intégration (run.fullSuite = each-integration), suite complète : ${fullLevel}`);
        }
        if (!ready.length && !toIntegrate.length && !resume.length && !relaunch.length && !failed.length)
            actions.push('aucune tâche prête : vérifier les dépendances bloquées');
    }
    else if (step === 'reviews' && reviewsToLaunch.length)
        actions.push(`lancer les revues : ${reviewsToLaunch.join(', ')}`);
    else if (step) {
        actions.push(`étape ${STEP_LABEL[step]} (${STATUS_LABEL[state.steps[step].status]})`);
        if (step === 'integration')
            actions.push(`dernière intégration (toutes les tâches), suite complète : ${fullLevel}, avant les revues ; garder ce worktree et ses reçus jusqu'à la livraison`);
        if (step === 'fixes') {
            actions.push(mode === 'final'
                ? `corrections, niveau tâche : ${taskLevel}, et le test qui prouve chaque correction ; la suite complète vient une fois, à la livraison`
                : `corrections (run.fullSuite = each-integration), suite complète : ${fullLevel}`);
        }
        if (step === 'delivery') {
            actions.push(`livraison : apv gates verify --commit <tête exacte de ${state.branch}> ; à 0 (reçus de la suite complète sur cette tête, arbre propre), pas de nouvelle suite ; sinon apv gates run --stage full puis apv gates verify à 0 avant de pousser`);
        }
    }
    if (allDone)
        actions.push('exécution terminée');
    return { specId: state.specId, step, stepStatus, wave, finished: allDone, ready, awaitingIntegration, integration: { head: integration.head, where: integration.where },
        resume, relaunch, failed, blocked, reviewsToLaunch, reviewsRunning, suite: { mode, level, targetBase, targetBaseWhere },
        pause: state.pause ? { ...state.pause } : null, unproven, actions };
}
/**
 * Reads one state file (`apv run start|set|next|status <id>`) with the bounded read of the summary: a regular
 * file only (a FIFO named like the state never blocks), MAX_RUN_STATE_BYTES at most; errors name the file by
 * `shown` and never quote its content.
 */
export function readRunState(file, source = {}) {
    const shown = source.shown ?? file;
    // lstat: a dangling link is not « no execution », and nothing is followed or opened here.
    let present = true;
    try {
        lstatSync(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            present = false;
    }
    if (!present)
        throw new PipelineError('RUN_MISSING', `Aucune exécution : ${shown} n'existe pas (apv run start <spec>)`);
    return parseRunStateText(readBounded(file, shown, MAX_RUN_STATE_BYTES).toString('utf8'), shown, source.specId);
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
        reviews: Object.fromEntries(REVIEWS.map(r => [r, state.reviews[r].status])), updatedAt: state.updatedAt, error: null,
        pause: state.pause ? { ...state.pause } : null };
}
/**
 * One line for `apv status` and `apv run status`. `running` names the running tasks after their count
 * (ids of the state, already restricted to the task id pattern by the schema); the first ones only.
 * Times in local time (`localTime`); the state keeps them in UTC.
 */
export function summaryLine(sum, running = []) {
    const t = sum.tasks;
    const where = sum.finished ? 'terminée' : `étape ${STEP_LABEL[sum.step]}${sum.step === 'waves' && sum.wave !== null ? ` (vague ${sum.wave})` : ''}`;
    const names = running.length ? ` (${running.slice(0, 5).join(', ')}${running.length > 5 ? ', …' : ''})` : '';
    const extra = [t.running ? `${t.running} en cours${names}` : '', t.failed ? `${t.failed} en échec` : '', t.skipped ? `${t.skipped} sautée(s)` : ''].filter(Boolean).join(', ');
    const pause = sum.pause ? ` ; en pause (quota) jusqu'à ${localTime(sum.pause.until)}` : '';
    return `${sum.specId} : ${where} ; tâches ${t.done}/${t.total} faites${extra ? `, ${extra}` : ''}${pause} ; mise à jour ${localTime(sum.updatedAt)}`;
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