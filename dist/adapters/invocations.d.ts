import type { AgentConfig, ProcessResult } from '../domain/contracts.js';
import type { Store } from '../persistence/store.js';
import type { SpecRecord } from '../lifecycle/contracts.js';
import { type AttemptUsage } from './usage.js';
export interface InvocationOwner {
    kind: 'run' | 'document';
    id: string;
}
export interface CostSummary {
    knownUsd: number;
    unknownInvocations: number;
    pendingInvocations: number;
}
interface Event {
    type: string;
    data: unknown;
}
/** Accounting is independent of output acceptance. An unfinished call remains visible after a crash. */
export declare function invocationTotals(events: Event[], budgetOnly?: boolean): CostSummary;
/** Legacy metrics are included only before the first journal entry, to avoid counting an invocation twice. */
export declare function specCosts(store: Store, record: SpecRecord, documentId: string, budgetOnly?: boolean): CostSummary;
/** Metered/legacy calls share the remaining declared budget; included subscription calls bypass USD ceilings. */
export declare function budgetedAgent(store: Store, documentId: string | undefined, agent: AgentConfig, acceptCost?: boolean, role?: 'product' | 'design' | 'implementer' | 'qa'): AgentConfig;
export declare function remainingSpecMs(store: Store, documentId?: string): number;
export declare function startInvocation(store: Store, owner: InvocationOwner, agent: AgentConfig, role: string, input: string): {
    finish(result: ProcessResult): AttemptUsage | null;
};
export {};
