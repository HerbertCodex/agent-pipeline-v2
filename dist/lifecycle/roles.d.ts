import type { SkillsConfig } from '../domain/knowledge.js';
import type { AgentConfig } from '../domain/contracts.js';
import type { Schema } from '../domain/schema.js';
import { PipelineError } from '../domain/errors.js';
import type { Store } from '../persistence/store.js';
export declare const roleInstructions: Record<Role, string>;
export type Role = 'setup' | 'product' | 'qa';
export { strictSchema } from '../adapters/structured-schema.js';
export declare function isRepairableOutputError(error: unknown): error is PipelineError;
export declare const MAX_REPAIR_ERROR_CHARS = 4000;
export declare function repairNotice(attempt: number, error: PipelineError): {
    attempt: number;
    previousError: {
        code: string;
        message: string;
        path: string | null;
    };
    previousOutput?: unknown;
    instruction: string;
};
export declare function runRole<T>(options: {
    store: Store;
    documentId: string;
    repo: string;
    sha: string;
    role: Role;
    agent: AgentConfig;
    passEnv: string[];
    schema: Schema<T>;
    context: unknown;
    signal?: AbortSignal;
    skills?: SkillsConfig;
    /** Controller validation beyond the schema; its output-contract errors are eligible for bounded repair. */
    validate?: (value: T) => T;
    /** Additional invocations allowed after an output-contract violation (0 disables repair). */
    maxRepairs?: number;
    budgetDocumentId?: string;
    acceptCost?: boolean;
    repairPatches?: boolean;
    modelReason?: string;
}): Promise<T>;
