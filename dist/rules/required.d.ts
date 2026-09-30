import type { ApvConfig } from '../config/load.js';
import type { RequiredGate } from './config.js';
/**
 * The check of the tree structure, added by `apv init` and `apv onboard` to a web project (task stage: it also runs in the
 * full suite). By default every finding is a warning: the check fails only on what the project raised to `error`.
 */
export declare const STRUCTURE_GATE: {
    readonly id: "structure";
    readonly command: readonly ["apv", "structure", "check"];
    readonly covers: readonly ["architecture"];
    readonly stage: "task";
    readonly readOnly: true;
    readonly mandatory: true;
};
/**
 * Checks every web project must declare, mandatory, before a merge (rule `controles`): the reuse of the shared components,
 * the code map and the tree structure. A check is recognised by the start of its command (`apv reuse check ...`), wrapped
 * or not (`node .../cli.js reuse check`, `npx apv ...`), whatever its id. A new capability of the tool (the architecture
 * map, for instance) is added here, and a project adds its own through `rules.requiredGates`.
 */
export declare const REQUIRED_WEB_GATES: readonly RequiredGate[];
/** Whether `command` runs `required` (its words, in order, at the start of the command once the launcher is read). */
export declare function runsCommand(command: readonly string[], required: readonly string[]): boolean;
export interface MissingGate {
    id: string;
    command: string[];
    problem: 'absent' | 'optional';
}
/** The required checks the configuration lacks, or declares without `mandatory`. */
export declare function missingRequiredGates(config: ApvConfig, required: readonly RequiredGate[]): MissingGate[];
