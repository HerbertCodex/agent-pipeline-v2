import { type Infer } from '../domain/schema.js';
/**
 * Test stacks of the project (docs/APV3-SPEC.md, section 18.1): a test database or browser stack shared by the
 * copies of the repository, with its lock (kernel `flock` file or `apv lock` lease), what selects it (variables, env
 * file), its Docker project, its ports and how to stop and restart it. Read by the Bash hook (a docker or supabase
 * command on a stack needs its lock), `apv stacks` (idle stop, restart) and `apv gates run --stacks` (a suite spread
 * over several stacks).
 */
export declare const STACK_ID: RegExp;
/** Default idle delay of `apv stacks idle-stop`: 30 minutes. */
export declare const DEFAULT_IDLE_AFTER_MS = 1800000;
/** Longest run of a `stop` or `start` command of a stack: 10 minutes. */
export declare const DEFAULT_STACK_COMMAND_TIMEOUT_MS = 600000;
export declare const stackSchema: import("../domain/schema.js").Schema<{
    readonly id: string;
    readonly lockFile: string | undefined;
    readonly resource: string | undefined;
    readonly lockCommand: string[] | undefined;
    readonly dockerProject: string | undefined;
    readonly env: Record<string, string> | undefined;
    readonly envFile: string | undefined;
    readonly ports: number[] | undefined;
    readonly stop: string[] | undefined;
    readonly start: string[] | undefined;
    readonly idleAfterMs: number | undefined;
    readonly commandTimeoutMs: number;
    readonly description: string | undefined;
}>;
export type StackConfig = Infer<typeof stackSchema>;
export declare const stacksSchema: import("../domain/schema.js").Schema<{
    readonly id: string;
    readonly lockFile: string | undefined;
    readonly resource: string | undefined;
    readonly lockCommand: string[] | undefined;
    readonly dockerProject: string | undefined;
    readonly env: Record<string, string> | undefined;
    readonly envFile: string | undefined;
    readonly ports: number[] | undefined;
    readonly stop: string[] | undefined;
    readonly start: string[] | undefined;
    readonly idleAfterMs: number | undefined;
    readonly commandTimeoutMs: number;
    readonly description: string | undefined;
}[]>;
/** Every problem of the declared stacks: duplicate ids, lock files or resources, a stack without a lock, duplicate ports. */
export declare function stackIssues(stacks: readonly StackConfig[]): string[];
/** A path of a stack: absolute as is, else relative to the Git common directory `common`. */
export declare const stackPath: (common: string, path: string) => string;
