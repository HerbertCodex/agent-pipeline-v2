import type { ChangeSet, Config, Gate, Lane, RiskDecision, Task } from '../domain/contracts.js';
export declare function validRelativePath(path: string): boolean;
export declare function matches(path: string, pattern: string): boolean;
export declare const sensitivePaths: string[];
export declare function classify(changes: ChangeSet, config: Config, minimum?: Lane): RiskDecision;
export declare function assertScope(changes: ChangeSet | string[], task: Task): string[];
export declare function validateDag(gates: Gate[]): void;
export declare function planGates(config: Config, changes: ChangeSet, lane: Lane): Gate[];
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
export declare function validationRequirements(config: Config, files: string[], lane: Lane): ValidationRequirement[];
export type ReviewMode = 'solo' | 'team' | 'regulated';
export declare function requiredApprovals(lane: Lane, mode?: ReviewMode): number;
