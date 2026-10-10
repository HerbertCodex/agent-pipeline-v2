import type { LotGit } from '../stack/batch.js';
import type { OrderStep, VerifiedOrder } from './order.js';
/**
 * The verification command of the project (`rules.operatorOrders.verify.publication`), run by APV from a clean copy of
 * the base: a detached worktree of the base commit, prepared by `batch.setup` of the base when it declares one (the
 * dependencies of the base, never those of the pull request), then the command with `{{base}}`, `{{head}}` and
 * `{{step}}` replaced, the verified order as JSON on its input. Nothing of the head is executed by APV: the command reads
 * it through Git. Exit 0: the content is the one the order signed; any other exit refuses, with the code the command
 * wrote (`{ "ok": false, "code": "content" }` on its last line) when it is a short word.
 */
export interface VerifyCommand {
    command: readonly string[];
    timeoutMs: number;
    /** `batch.setup` of the base, with its time limit; absent: nothing is prepared. */
    setup?: {
        command: readonly string[];
        timeoutMs: number;
    } | undefined;
    /** Variables given to the setup and the command: `environment.passEnv` of the base, and HOME. */
    passEnv: readonly string[];
}
export interface VerifyInput {
    repo: string;
    git: LotGit;
    base: string;
    head: string;
    step: OrderStep;
    order: VerifiedOrder;
    settings: VerifyCommand;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}
/** `projectCode`: the code the command of the project gave (`content`, `files`...), null when it gave none or did not run. */
export type VerifyResult = {
    ok: true;
} | {
    ok: false;
    projectCode: string | null;
    detail: string;
};
/** The code a refusing command wrote on its last JSON line, when it is a short word. */
export declare function refusalCode(stdout: string): string | null;
export declare function runVerifyCommand(input: VerifyInput): Promise<VerifyResult>;
