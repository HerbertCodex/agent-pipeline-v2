import { type JsonObject, type PublicKey, type VerifyRefusal } from './envelope.js';
/**
 * The operator order of format 1 (docs/REGLES.md, « Fusion sur ordre signé »): what APV reads of the objects a project
 * signs, and how it decides, offline, that an order is authentic, intact, not expired, bound to the last signed decision
 * of its pull request and not consumed. The revocation is read in production (src/orders/attestation.ts): this check
 * alone never allows a merge.
 *
 * - Decision (`kind: "decision"`): `repo`, `pr`, `decision` (`validate` executes an order), `articleSha`, `requestId`,
 *   `seq` (a global sequence number given by the production before the comment), optional `choices`.
 * - Order (`kind: "publish_order"`): `repo`, `articlePr`, `articleSha` (the commit the decision was taken on),
 *   `decisionRef` and `decisionSeq` (the decision it executes), `issuedAt`, `expiresAt` (7 days at most), `nonce`; the
 *   other fields (slug, digest of the proposal, choices) belong to the project and reach its verification command.
 * - Attestation (`kind: "publish_attestation"`): `repo`, `articlePr`, `articleSha`, `orderNonce`, `decisionSeq`, and the
 *   `challenge` APV drew for this request.
 *
 * The last decision is the one of the largest signed `seq`, never the last comment nor a date of GitHub: a copy of an
 * old decision keeps its old number.
 */
export declare const ORDER_STEPS: readonly ["publication", "article"];
export type OrderStep = typeof ORDER_STEPS[number];
/** Longest life of an order: 7 days. */
export declare const ORDER_MAX_TTL_MS: number;
export declare const COMMIT: RegExp;
export declare const UUID: RegExp;
export type OrderRefusal = VerifyRefusal | 'repo' | 'pr' | 'expired' | 'nonce_conflict' | 'decision_conflict' | 'decision_missing' | 'superseded' | 'head_moved';
export interface PublishOrder {
    repo: string;
    articlePr: number;
    articleSha: string;
    decisionRef: string;
    decisionSeq: number;
    issuedAt: string;
    expiresAt: string;
    nonce: string;
    keyId: string;
    /** The whole signed payload, given as is to the verification command of the project. */
    payload: JsonObject;
}
export interface VerifiedOrder {
    order: PublishOrder;
    payload: string;
    signature: string;
    digest: string;
}
/** The fields APV reads of a signed order, or null when one is missing or out of its bounds. */
export declare function readOrder(value: JsonObject): PublishOrder | null;
export interface OrderInput {
    domain: string;
    keys: readonly PublicKey[];
    /** Bodies of the comments of the pull request the order is signed on, in any order (without effect). */
    bodies: readonly string[];
    /** The repository (`owner/name`) and the number of that pull request, as GitHub gives them. */
    repo: string;
    pr: number;
    /** Its head now. */
    head: string;
    nonce: string;
    now: number;
}
export type OrderVerdict = ({
    ok: true;
} & VerifiedOrder) | {
    ok: false;
    code: OrderRefusal;
};
/**
 * The order `nonce` among the comments: authenticated by a declared key, then bound to the repository, the pull request,
 * the time, the last signed decision of the pull request and its head. The first refusal is given.
 */
export declare function verifyOrder(input: OrderInput): OrderVerdict;
export type AttestationRefusal = VerifyRefusal | 'challenge' | 'order';
/**
 * An attestation of the production for `order` and the challenge APV drew: signed by a declared key under the kind
 * `publish_attestation`, for the same repository, pull request, commit, order and decision.
 */
export declare function checkAttestation(domain: string, keys: readonly PublicKey[], signed: string, order: PublishOrder, challenge: string): {
    ok: true;
} | {
    ok: false;
    code: AttestationRefusal;
};
/** One commit of a first-parent history, read without any separator a message could forge. */
export interface HistoryCommit {
    sha: string;
    parents: string[];
    message: string;
}
/**
 * The format of `git log` that `readHistory` reads: fields and commits separated by NUL, the one byte a commit message
 * can never contain (Git refuses it), never a printable or control character an author could put in a message.
 */
export declare const HISTORY_LOG_FORMAT = "--format=%H%x00%P%x00%B%x00";
/**
 * The commits of `git log --first-parent HISTORY_LOG_FORMAT <base>`, newest first; null when the output is not exactly
 * a chain of first parents (an id that is not 40 hexadecimal characters, a first parent that is not the next commit):
 * the caller then refuses, it never guesses.
 */
export declare function readHistory(log: string): HistoryCommit[] | null;
/**
 * A merge commit made by APV on order, on the first-parent history of the target: two parents, the trailer `Apv-Order`,
 * `Apv-Order-Step`, `Apv-Order-Sha256` and `Apv-Merged-Head` once each in the last paragraph of its own message, the
 * merged head being the second parent. A trailer copied into an ordinary commit (a squash) is not one.
 */
export interface OrderMergeCommit {
    sha: string;
    firstParent: string;
    nonce: string;
    step: OrderStep;
    digest: string;
    head: string;
    /** The whole message, trimmed: a merge APV made has exactly the message of `mergeMessage`. */
    message: string;
}
/** The message of the merge commit of a step: a title, then the trailer (nonce, step, digest of the order, merged head). */
export declare function mergeMessage(input: {
    pr: number;
    step: OrderStep;
    nonce: string;
    digest: string;
    head: string;
}): string;
/** The trailer of an order in the last paragraph of `message`, each key exactly once; null otherwise. */
export declare function orderTrailer(message: string): {
    nonce: string;
    step: OrderStep;
    digest: string;
    head: string;
} | null;
/** The merge commits on order of a first-parent history, newest first. */
export declare function orderMergeCommits(history: readonly HistoryCommit[]): OrderMergeCommit[];
