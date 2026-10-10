import type { LotGit } from '../stack/batch.js';
import { type GhCall, type GhRunner } from '../stack/github.js';
import { type Fetcher } from './attestation.js';
import { type OrderRefusal, type OrderStep } from './order.js';
import { type VerifyInput, type VerifyResult } from './verify-command.js';
/**
 * `apv stack merge <publication> <article> --order <nonce>` (docs/REGLES.md, « Fusion sur ordre signé »): the merge of
 * the two pull requests of an operator order, with no session of the operator, each step once.
 *
 * For each step (publication, then article), in this order, `M` being the head of the target read at that moment:
 * 1. the order `nonce`, signed on the article pull request, verified offline with the keys of `M` (signature, repository,
 *    pull request, expiry, last signed decision by sequence number, head of the article pull request);
 * 2. not consumed: no commit of the first-parent history of `M` carries its trailer for this step (`nonce_used`;
 *    both steps there: `already_done`, nothing to do);
 * 3. the publication head `H` (read once, at the start) descends from `M` (`base`); the verification command of the
 *    project, from a clean copy of `M`, finds the content of the step to be the one the order signed (`verify`);
 * 4. the rules checked before any merge (`apv rules check`) at the merged head (`rules`);
 * 5. a fresh attestation of the production bound to a challenge drawn here (`attestation`);
 * 6. the merge commit of parents (`M`, head), with the trailer `Apv-Order`, pushed on the target without force within
 *    `maxAgeSeconds` of the attestation (a new attestation otherwise). A push refused because the target moved starts the
 *    step again on the new `M` (twice at most, then `main_moved`). Never the merge API of GitHub, never a forced push.
 */
export type OrderMergeCode = OrderRefusal | 'config' | 'github' | 'git' | 'nonce_used' | 'base' | 'verify' | 'rules' | 'attestation' | 'merge_conflict' | 'main_moved';
export interface OrderMergeStep {
    step: OrderStep;
    pr: number;
    head: string;
    base: string;
    mergeCommit: string;
}
export interface OrderMergeReport {
    status: 'merged' | 'already_done' | 'refused';
    code: OrderMergeCode | null;
    /** Why, in French; for `verify`, the code of the command of the project in `projectCode`. */
    reason: string | null;
    projectCode: string | null;
    target: string | null;
    /** Steps merged by this run, in order; the steps found already consumed are in `consumed`. */
    merged: OrderMergeStep[];
    consumed: OrderStep[];
    attestations: number;
    traceErrors: string[];
}
export interface OrderMergeOptions {
    repo: string;
    remote: string;
    publicationPr: number;
    articlePr: number;
    nonce: string;
    gh: GhRunner;
    git: LotGit;
    env: NodeJS.ProcessEnv;
    /** The rules checked before a merge at `head` against `<remote>/<target>`: the problems, empty when respected. */
    rules: (head: string, target: string) => Promise<string[]>;
    log?: (line: string) => void;
    onCall?: (call: GhCall) => void;
    /** The signed trace of a merge (`apv audit merges`); returns the error when it could not be written. */
    onMerged?: (merge: {
        pr: number;
        head: string;
        target: string;
        method: string;
        mergeCommit: string;
    }) => string | null;
    fetch?: Fetcher;
    verify?: (input: VerifyInput) => Promise<VerifyResult>;
    now?: () => number;
    monotonic?: () => number;
    challenge?: () => string;
    /** Called just before each push (tests: another run, or someone else, moves the target there). */
    beforePush?: (step: OrderStep, commit: string) => Promise<void>;
}
/** Pushes refused because the target moved, after which the run stops (`main_moved`). */
export declare const MAX_PUSH_RETRIES = 2;
export declare function mergeOnOrder(options: OrderMergeOptions): Promise<OrderMergeReport>;
/** The bodies of `gh api --paginate .../comments --jq '.[] | .body | @json'`: one JSON string per line; null when unreadable. */
export declare function readBodies(stdout: string): string[] | null;
