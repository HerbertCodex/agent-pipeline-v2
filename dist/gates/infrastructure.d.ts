import type { GateReceipt } from '../domain/contracts.js';
/**
 * A check that failed because of its infrastructure, not of the code it tests: a variable of its environment absent,
 * a test stack or a service it reaches unreachable (refused connection, stopped container), a copy or an executable
 * missing. Told apart from a test that fails, so that a batch is never bisected nor a pull request blamed for it
 * (lessons of the night of 2 October 2026: `SUPABASE_TEST_URL` absent from a batch, a Docker container left
 * « Created » under load). It is a reading of the output, never a proof: the receipt keeps its status, the check stays
 * failed, only the next step changes (repair the infrastructure, then run again).
 */
export type InfrastructureKind = 'environment' | 'unreachable' | 'setup';
export interface InfrastructureCause {
    gateId: string;
    kind: InfrastructureKind;
    /** What was read, in a few words (the variable, the line of the output). */
    detail: string;
}
/**
 * Why a failed check failed for its infrastructure, or null (a test that fails, or nothing recognised).
 * `missing`: the variables the check receives (its `passEnv`) that were absent from its environment; one of them
 * named by the output is the strongest sign. Only failed, timed out or unstarted checks are read.
 */
export declare function infrastructureCause(receipt: Pick<GateReceipt, 'gateId' | 'status' | 'diagnostic'>, missing?: readonly string[]): InfrastructureCause | null;
/** Words of a cause, for a report line. */
export declare function infrastructureText(cause: InfrastructureCause): string;
/** What to do about failures of the infrastructure, generic to every project. */
export declare function infrastructureAdvice(causes: readonly InfrastructureCause[], stacksDeclared: readonly string[]): string;
/**
 * The failures of a run that are infrastructure: one cause per failed check recognised, and whether every failure
 * is one (`all`; cancelled checks stopped by the first failure, and checks blocked by a failed dependency, are not failures of their own).
 */
export declare function classifyFailures(receipts: readonly Pick<GateReceipt, 'gateId' | 'status' | 'diagnostic'>[], missing: ReadonlyMap<string, readonly string[]>): {
    causes: InfrastructureCause[];
    all: boolean;
};
