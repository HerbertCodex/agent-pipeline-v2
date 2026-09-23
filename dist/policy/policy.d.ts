import type { ChangeSet, Config, Gate, Lane, RiskDecision, Task } from '../domain/contracts.js';
export declare function validRelativePath(path: string): boolean;
export declare function matches(path: string, pattern: string): boolean;
export declare const sensitivePaths: string[];
/** The part of a configuration the policy reads: V2 configurations and V3 `.apv/config.json` both provide it. */
export type PolicyConfig = Pick<Config, 'gates' | 'risk' | 'validationRules'> & {
    workflow: Pick<Config['workflow'], 'qualityReview'>;
};
export declare function classify(changes: ChangeSet, config: Pick<Config, 'risk'>, minimum?: Lane): RiskDecision;
/** The part of a task that scope policy reads; a spec task provides `allowedPaths` only. */
export type ScopeTask = Pick<Task, 'allowedPaths'> & Partial<Pick<Task, 'allowedNewPaths' | 'maxNewFiles'>>;
export interface ScopeReport {
    /** Files created inside a declared `allowedNewPaths` envelope. */
    autoNew: string[];
    /** Files outside the task scope, or invalid paths. */
    rejected: string[];
    /** More automatically accepted new files than `maxNewFiles` allows. */
    tooManyNew: boolean;
}
/** Every scope violation of a change, for a report; `assertScope` turns it into the V2 error. */
export declare function scopeReport(changes: ChangeSet | string[], task: ScopeTask): ScopeReport;
export declare function assertScope(changes: ChangeSet | string[], task: ScopeTask): string[];
export declare function validateDag(gates: Gate[]): void;
export declare function planGates(config: PolicyConfig, changes: ChangeSet, lane: Lane): Gate[];
export declare function gateApplies(gate: Pick<Gate, 'paths'>, files: string[]): boolean;
export interface ValidationRequirement {
    id: string;
    anyOf: Gate['covers'];
    reason: string;
    paths?: string[];
}
export declare function isCodeChange(files: string[]): boolean;
export declare function isUiChange(files: string[]): boolean;
/** Conservative defaults plus reviewed project paths, not a semantic classifier. */
export declare function validationRequirements(config: PolicyConfig, files: string[], lane: Lane): ValidationRequirement[];
export type ReviewMode = 'solo' | 'team' | 'regulated';
export declare function requiredApprovals(lane: Lane, mode?: ReviewMode): number;
