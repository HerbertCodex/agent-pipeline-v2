import { FULL_SUITE_OVERRIDE_TARGET, PAUSE_TARGET, REVIEWS } from '../run/state.js';
/**
 * Time measure of one spec execution (docs/SHIFT-LEFT.md, section 11), computed from what the tool already wrote: the
 * timestamped events of `.apv/state/run-<id>.json`, the receipts of the full suites and the merge of its pull request.
 * Nothing is typed by hand. Pure: the caller reads the sources (src/metrics/sources.ts).
 */
/** Phases of an execution, each ending at a milestone of the journal; the first starts when the execution is created. */
export const PHASES = ['data-model', 'plan', 'code', 'integration', 'reviews', 'fixes', 'delivery', 'merge-wait'];
export const PHASE_LABEL = {
    'data-model': 'modèle de données', plan: 'plan', code: 'code (vagues)', integration: 'intégration', reviews: 'relectures', fixes: 'corrections',
    delivery: 'livraison', 'merge-wait': 'attente de fusion',
};
const ms = (iso) => Date.parse(iso);
const span = (from, to) => Math.max(0, ms(to) - ms(from));
const finishedStatus = (s) => s === 'done' || s === 'skipped';
const latest = (values) => values.filter((v) => typeof v === 'string').sort((a, b) => ms(a) - ms(b)).at(-1) ?? null;
/** Last move of `target` to `done` or `skipped`, when its current status is finished; null otherwise. */
function milestone(events, target, status, fallback) {
    if (!finishedStatus(status))
        return null;
    const last = [...events].reverse().find(e => e.target === target && finishedStatus(e.to));
    return last?.at ?? fallback;
}
export function taskTimings(state) {
    return Object.entries(state.tasks).map(([id, t]) => {
        const own = state.events.filter(e => e.target === `task:${id}`);
        const startedAt = own.find(e => e.to === 'running')?.at ?? null;
        const endedAt = t.status === 'done' ? ([...own].reverse().find(e => e.to === 'done')?.at ?? t.updatedAt) : null;
        return { id, dependsOn: [...t.dependsOn], wave: t.wave, status: t.status, startedAt, endedAt,
            ms: startedAt && endedAt ? span(startedAt, endedAt) : null, starts: own.filter(e => e.to === 'running' && e.from !== 'running').length };
    });
}
/**
 * Critical path of the code phase: the chain of dependencies whose summed measured durations is the longest. A task in
 * parallel with a longer one adds nothing to it. Ties go to the first task in spec order, then to the first dependency.
 */
export function criticalPath(tasks) {
    const done = tasks.filter(t => t.ms !== null);
    const byId = new Map(done.map(t => [t.id, t]));
    const best = new Map();
    const visit = (id, seen) => {
        const known = best.get(id);
        if (known)
            return known.work;
        const task = byId.get(id);
        let previous = null;
        let before = 0;
        for (const dep of task.dependsOn) {
            if (!byId.has(dep) || seen.has(dep))
                continue;
            const w = visit(dep, new Set([...seen, dep]));
            if (w > before || previous === null) {
                before = w;
                previous = dep;
            }
        }
        best.set(id, { work: before + task.ms, previous });
        return before + task.ms;
    };
    let last = null;
    let top = -1;
    for (const t of done) {
        const w = visit(t.id, new Set([t.id]));
        if (w > top) {
            top = w;
            last = t.id;
        }
    }
    const chain = [];
    for (let id = last; id; id = best.get(id).previous)
        chain.unshift(id);
    const starts = done.map(t => t.startedAt).sort((a, b) => ms(a) - ms(b));
    const ends = done.map(t => t.endedAt).sort((a, b) => ms(a) - ms(b));
    const spanMs = done.length ? span(starts[0], ends.at(-1)) : null;
    const workMs = last ? top : null;
    return { chain, workMs, spanMs, waitMs: spanMs !== null && workMs !== null ? Math.max(0, spanMs - workMs) : null,
        complete: tasks.every(t => t.status === 'skipped' || t.ms !== null) };
}
/** Quota pauses of the journal: from each `pause` event to `pending` up to the next `pause` event to `running` (or `until`). */
export function pausedMs(state, now) {
    let total = 0;
    let since = null;
    for (const e of state.events) {
        if (e.target !== PAUSE_TARGET)
            continue;
        if (e.to === 'pending') {
            since ??= e.at;
            continue;
        }
        if (since) {
            total += span(since, e.at);
            since = null;
        }
    }
    if (since)
        total += span(since, state.pause?.until && ms(state.pause.until) < ms(now) ? state.pause.until : now);
    return total;
}
/** The measure of one execution: phases chained milestone to milestone, the critical path of the code phase, the counts. */
export function measureRun(input) {
    const { state } = input;
    const ev = state.events;
    const tasks = taskTimings(state);
    const allTasksFinished = tasks.every(t => finishedStatus(t.status));
    const reviewsFinished = REVIEWS.every(r => finishedStatus(state.reviews[r].status));
    const ends = {
        'data-model': milestone(ev, 'data-model', state.steps['data-model'].status, state.steps['data-model'].updatedAt),
        plan: milestone(ev, 'plan', state.steps.plan.status, state.steps.plan.updatedAt),
        code: allTasksFinished ? latest(tasks.map(t => t.endedAt)) : null,
        integration: milestone(ev, 'integration', state.steps.integration.status, state.steps.integration.updatedAt),
        // The `reviews` step closes the reviews; without it, the last review finished does.
        reviews: milestone(ev, 'reviews', state.steps.reviews.status, state.steps.reviews.updatedAt)
            ?? (reviewsFinished && REVIEWS.some(r => state.reviews[r].status === 'done') ? latest(REVIEWS.map(r => state.reviews[r].updatedAt)) : null),
        fixes: milestone(ev, 'fixes', state.steps.fixes.status, state.steps.fixes.updatedAt),
        delivery: milestone(ev, 'delivery', state.steps.delivery.status, state.steps.delivery.updatedAt),
        'merge-wait': input.pr?.mergedAt ?? null,
    };
    // A phase without its own milestone but followed by one (tasks all skipped, a step never journaled) ends with the previous one.
    if (ends.code === null && allTasksFinished)
        ends.code = ends.plan;
    const skipped = (p) => p === 'code' ? tasks.length > 0 && tasks.every(t => t.status === 'skipped')
        : p === 'merge-wait' ? false : state.steps[p].status === 'skipped';
    const phases = [];
    let previous = state.createdAt;
    let blocked = false;
    for (const phase of PHASES) {
        const end = blocked ? null : ends[phase];
        if (end === null || previous === null) {
            phases.push({ phase, status: !blocked && previous !== null ? 'running' : 'pending', startedAt: blocked ? null : previous, endedAt: null, ms: null });
            blocked = true;
            previous = null;
            continue;
        }
        const at = ms(end) < ms(previous) ? previous : end;
        phases.push({ phase, status: skipped(phase) ? 'skipped' : 'done', startedAt: previous, endedAt: at, ms: span(previous, at) });
        previous = at;
    }
    const lastEvent = ev.at(-1)?.at ?? state.updatedAt;
    const end = input.pr?.mergedAt ? { at: input.pr.mergedAt, kind: 'merge' }
        : ends.delivery ? { at: ends.delivery, kind: 'delivery' } : { at: lastEvent, kind: 'last-event' };
    const launches = (domain) => ev.filter(e => e.target === `review:${domain}` && e.to === 'running' && e.from !== 'running').length;
    return {
        specId: state.specId, source: input.source, createdAt: state.createdAt, updatedAt: state.updatedAt,
        end, totalMs: span(state.createdAt, end.at), finished: end.kind === 'merge',
        phases, tasks, waves: state.waves.length, criticalPath: criticalPath(tasks), pausedMs: pausedMs(state, end.at),
        reviews: REVIEWS.map(domain => ({ domain, status: state.reviews[domain].status, findings: state.reviews[domain].findings, launches: launches(domain) })),
        fixPasses: ev.filter(e => e.target === 'fixes' && e.to === 'running' && e.from !== 'running').length,
        fullSuiteOverrides: ev.filter(e => e.target === FULL_SUITE_OVERRIDE_TARGET).length,
        suites: input.suites ?? null, contestations: null, survivingMutations: null, pr: input.pr ?? null,
    };
}
/** The pull request a delivery names in its note: an address `…/pull/<n>` first, else « PR #<n> ». */
export function deliveredPullRequest(state) {
    const notes = state.events.filter(e => e.target === 'delivery' && e.note).map(e => e.note).reverse();
    if (state.steps.delivery.note)
        notes.unshift(state.steps.delivery.note);
    for (const note of notes) {
        const n = /\/pull\/(\d{1,7})\b/.exec(note)?.[1] ?? /\bPR\s*#(\d{1,7})\b/i.exec(note)?.[1];
        if (n)
            return Number(n);
    }
    return null;
}
export const median = (values) => {
    if (!values.length)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
/** Signed gap of `value` to `base`, in percent rounded to the unit; null without a base. */
export const gapPercent = (value, base) => value === null || base === null || base <= 0 ? null : Math.round(((value - base) / base) * 100);
/** Number of past executions of the comparison base (section 11: « les trois dernières specs »). */
export const BASELINE_RUNS = 3;
/**
 * Base of comparison: the median of the last BASELINE_RUNS executions merged before `target` was created (all merged
 * ones but `target` when none is older). Median, not mean: one execution stopped overnight does not move it.
 */
export function runBaseline(all, target, count = BASELINE_RUNS) {
    const merged = all.filter(m => m.finished && m.specId !== target?.specId).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    const before = target ? merged.filter(m => ms(m.createdAt) < ms(target.createdAt)) : merged;
    const picked = (before.length ? before : merged).slice(0, count);
    const values = (f) => picked.map(f).filter((v) => v !== null);
    return { specs: picked.map(m => m.specId), totalMs: median(values(m => m.totalMs)), criticalWorkMs: median(values(m => m.criticalPath.workMs)),
        codeSpanMs: median(values(m => m.criticalPath.spanMs)) };
}
/** `1 h 05 min`, `42 min`, `36 s`; `?` for an unknown duration. */
export function duration(value) {
    if (value === null || !Number.isFinite(value))
        return '?';
    const s = Math.round(value / 1000);
    if (s < 60)
        return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60)
        return `${m} min`;
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const rest = m % 60;
    return `${d ? `${d} j ` : ''}${h} h ${String(rest).padStart(2, '0')} min`;
}
export const signedPercent = (p) => p === null ? 'sans base' : `${p > 0 ? '+' : ''}${p} %`;
//# sourceMappingURL=run.js.map