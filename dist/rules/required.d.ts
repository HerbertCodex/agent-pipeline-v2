import type { ApvConfig } from '../config/load.js';
import type { RequiredGate } from './config.js';
/**
 * Checks every web project must declare, mandatory, before a merge (rule `controles`): the reuse of the shared components,
 * the code map and the tree structure. A check is recognised by the start of its command (`apv reuse check ...`), wrapped
 * or not (`node .../cli.js reuse check`, `npx apv ...`), whatever its id and its options (`--base {{baseSha}}`). The
 * architecture map is checked by `apv structure check` itself (its rule `architecture-map`): the `structure` check covers
 * it. A new capability of the tool that has its own check is added here; a project adds its own through `rules.requiredGates`.
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
