import type { LotGit } from '../stack/batch.js';
import { type GhCall, type GhRunner } from '../stack/github.js';
import { type Fetcher } from './attestation.js';
import { type OrderRefusal, type OrderStep } from './order.js';
import { type VerifyInput, type VerifyResult } from './verify-command.js';
/**
 * `apv stack merge <publication> <article> --order <nonce>` (docs/REGLES.md, section 3 ter): the merge of the two pull
 * requests of an operator order, with no session of the operator, each step once.
 *
 * Trusted base `T`, fixed for the whole run before anything is merged: the target as it was before any merge on this
 * order (its head at the start, or the first parent of the publication merge APV already made for this order). The keys,
 * the domain, the attestation address, the verification command, `batch.setup` and the variables are read at `T` only,
 * and the verification command always runs from a clean copy of `T`: nothing a pull request wrote (the publication head
 * merged at the first step included) is ever read as configuration or executed by the tool.
 *
 * For each step (publication, then article), in this order, `M` being the head of the target read at that moment:
 * 1. the order `nonce`, signed on the article pull request, verified offline with the keys of `T` (signature,
 *    repository, pull request, expiry, last signed decision by sequence number, head of the article pull request);
 * 2. not consumed: only merge commits APV made count (two parents, second parent equal to `Apv-Merged-Head`, trailer
 *    read by Git, `Apv-Order-Sha256` equal to the digest of this order); both steps there: `already_done`;
 * 3. the publication head `H` (read once, at the start) descends from `M` (`base`); the verification command of the
 *    project, from a clean copy of `T`, finds the content of the step to be the one the order signed (`verify`);
 * 4. the rules checked before any merge (`apv rules check`) at the merged head (`rules`);
 * 5. the tree of the merge is the tree verified: the one of `H` (publication), or only the files of the article pull
 *    request with their content at the signed commit (article);
 * 6. a fresh attestation of the production bound to a challenge drawn here (`attestation`);
 * 7. the merge commit of parents (`M`, head), with the trailer `Apv-Order`, pushed on the target without force within
 *    `maxAgeSeconds` of the attestation (a new attestation otherwise), the push bounded in time. A push refused because
 *    the target moved starts the step again on the new `M`, whose declaration must be the one of `T` (twice at most, then
 *    `main_moved`). Never the merge API of GitHub, never a forced push.
 */
export type OrderMergeCode = OrderRefusal | 'config' | 'github' | 'git' | 'nonce_used' | 'base' | 'verify' | 'rules' | 'attestation' | 'merge_conflict' | 'main_moved' | 'push';
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
    /** The trusted base of the run: the configuration was read there and the verification command ran from it. */
    trustedBase: string | null;
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
    /** Longest push (the attestation window is checked just before it). */
    pushTimeoutMs?: number;
    /** Called just before each push (tests: another run, or someone else, moves the target there). */
    beforePush?: (step: OrderStep, commit: string) => Promise<void>;
}
/** Pushes refused because the target moved, after which the run stops (`main_moved`). */
export declare const MAX_PUSH_RETRIES = 2;
export declare const DEFAULT_PUSH_TIMEOUT_MS = 60000;
/** A branch name read from GitHub that may be fetched: never `HEAD`, an option, a range or a reflog form. */
export declare function safeBranch(name: string): boolean;
export declare function mergeOnOrder(options: OrderMergeOptions): Promise<OrderMergeReport>;
/** The bodies of `gh api --paginate .../comments --jq '.[] | .body | @json'`: one JSON string per line; null when unreadable. */
export declare function readBodies(stdout: string): string[] | null;
