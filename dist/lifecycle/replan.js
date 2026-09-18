import { hash } from '../domain/hash.js';
import { invariant } from '../domain/errors.js';
import { validateTaskCapabilities } from './capabilities.js';
import { replanSchema, stricter, validateSpec } from './contracts.js';
/** Bind operator approval to the exact paused frontier, including later operational amendments. */
export function replanContext(r) {
    return hash({ contentHash: r.contentHash, approval: r.approval, currentSha: r.currentSha,
        completed: r.completedTaskIds, attempts: r.attempts, activeRunId: r.activeRunId,
        finalRunId: r.finalRunId, configHash: r.configHash, operational: r.operational ?? null,
        scope: r.scopeAmendments, criteria: r.criterionAmendments ?? [], status: r.status });
}
export function replanHash(p) {
    return hash({ contextHash: p.contextHash, reason: p.reason, tasks: p.tasks });
}
/** Keep identities, obligations and completed work; only the remaining execution plan can change. */
export function revisedContent(r, input) {
    const { tasks, reason } = replanSchema.parse(input);
    invariant(reason.trim().length >= 20 && r.content, 'REPLAN', 'Explain why the remaining plan needs revision');
    const remaining = r.content.tasks.filter(t => !r.completedTaskIds.includes(t.id));
    invariant(tasks.length === remaining.length && new Set(tasks.map(t => t.id)).size === tasks.length &&
        tasks.every(t => remaining.some(old => old.id === t.id)), 'REPLAN', 'Provide exactly the remaining task IDs; completed tasks cannot change');
    for (const task of tasks) {
        const old = remaining.find(t => t.id === task.id);
        invariant(hash([...task.acceptanceIds].sort()) === hash([...old.acceptanceIds].sort()), 'REPLAN', `Keep the acceptance obligations of ${task.id}`);
        invariant(stricter(task.minimumLane, old.minimumLane) === task.minimumLane, 'REPLAN', `Cannot lower the risk lane of ${task.id}`);
    }
    const content = validateTaskCapabilities(validateSpec({ ...r.content,
        tasks: [...r.content.tasks.filter(t => r.completedTaskIds.includes(t.id)), ...tasks],
    }, true, r.decisionLedger, r.request, r.securityContext), r.config);
    invariant(hash(content) !== hash(r.content), 'REPLAN', 'The remaining plan has not changed');
    return { content, reason: reason.trim(), tasks };
}
//# sourceMappingURL=replan.js.map