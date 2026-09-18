import { type SpecRecord, type Spec, type PlanRevision } from './contracts.js';
/** Bind operator approval to the exact paused frontier, including later operational amendments. */
export declare function replanContext(r: SpecRecord): string;
export declare function replanHash(p: Pick<PlanRevision, 'contextHash' | 'reason' | 'tasks'>): string;
/** Keep identities, obligations and completed work; only the remaining execution plan can change. */
export declare function revisedContent(r: SpecRecord, input: unknown): {
    content: Spec;
    reason: string;
    tasks: Spec['tasks'];
};
