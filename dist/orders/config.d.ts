import { type Infer } from '../domain/schema.js';
/**
 * `rules.operatorOrders` of `.apv/config.json` (docs/REGLES.md, « Fusion sur ordre signé »), always read at the base of
 * the merge (a pull request never changes the rules it is checked against):
 * - `domain`: the domain of the signed messages of the project (`<domain>:signed:1:<kind>`, comment `<domain>-signed:1`);
 * - `publicKeys`: the Ed25519 public keys of the signer (PEM SPKI or its base64 line), two during a rotation; never a
 *   private key (refused by the loader, never echoed);
 * - `attestation`: the address of the production that attests an order is open, with `{nonce}` and `{challenge}`
 *   replaced by APV (HTTPS only, no exception: the tests of the tool replace the network, never the address), and
 *   `maxAgeSeconds`, the longest time between the attestation and the push of the merge (120 by default);
 * - `publicationBranch` (optional): the branch the publication pull request must come from, `{slug}` replaced by the
 *   `slug` the order signed (`publication/{slug}`); absent, only the command of the project binds that pull request to
 *   the order (closed list of files, content regenerated from the signed proposal);
 * - `paths.publication` and `paths.article`: the globs each pull request of an order may change (`{slug}` replaced by
 *   the slug the order signed); required for a merge on order, never covering a path of the refusal list of APV;
 * - `verify.publication`: the command of the project that checks the content of a step, run by APV from a clean copy
 *   of the trusted base, the verified order on its input, with whole arguments replaced: `{{trusted}}` the trusted base
 *   (where the keys and the configuration are read: the project reads its keys there too), `{{base}}` the commit the
 *   step merges on (the target at that moment, which may already contain the publication head), `{{head}}`, `{{step}}`;
 * - `reducedProof` (optional, docs/PREUVE-REDUITE.md): the check run of a job that stands in for the full suite in a
 *   merge on order only, when the diff of the step holds in a closed list of regenerated content; `gates` it runs whole,
 *   `waives` it does not run (the only declaration of `rules` that lifts checks: its addition or widening needs an
 *   anchored decision of the operator, checked by `apv rules check`).
 */
export declare const DEFAULT_ATTESTATION_MAX_AGE_SECONDS = 120;
export declare const DEFAULT_ATTESTATION_TIMEOUT_MS = 15000;
export declare const DEFAULT_VERIFY_TIMEOUT_MS = 900000;
/** Placeholders of `verify.publication`, replaced as whole arguments. */
export declare const VERIFY_PLACEHOLDERS: readonly ["trusted", "base", "head", "step"];
/** `rules.operatorOrders.reducedProof` (docs/PREUVE-REDUITE.md, section 4). */
export declare const reducedProofSchema: import("../domain/schema.js").Schema<{
    readonly workflow: string;
    readonly job: string;
    readonly name: string;
    readonly gates: string[];
    readonly waives: string[];
    readonly covers: string;
    readonly paths: {
        readonly publication: string[] | undefined;
        readonly article: string[] | undefined;
    };
    readonly protectedPaths: string[] | undefined;
    readonly artifact: string | undefined;
}>;
export type ReducedProofDeclaration = Infer<typeof reducedProofSchema>;
export declare const operatorOrdersSchema: import("../domain/schema.js").Schema<{
    readonly domain: string;
    readonly publicKeys: string[];
    readonly attestation: {
        readonly url: string;
        readonly maxAgeSeconds: number;
        readonly timeoutMs: number;
    };
    readonly publicationBranch: string | undefined;
    readonly paths: {
        readonly publication: string[];
        readonly article: string[];
    } | undefined;
    readonly verify: {
        readonly publication: string[];
        readonly timeoutMs: number;
    };
    readonly reducedProof: {
        readonly workflow: string;
        readonly job: string;
        readonly name: string;
        readonly gates: string[];
        readonly waives: string[];
        readonly covers: string;
        readonly paths: {
            readonly publication: string[] | undefined;
            readonly article: string[] | undefined;
        };
        readonly protectedPaths: string[] | undefined;
        readonly artifact: string | undefined;
    } | undefined;
}>;
export type OperatorOrdersSettings = Infer<typeof operatorOrdersSchema>;
/** The attestation address with its placeholders replaced (values already checked as UUID). */
export declare function attestationUrl(template: string, nonce: string, challenge: string): string;
/** The branch of the publication pull request an order names (`publicationBranch` with its slug), or null when undeclared or unreadable. */
export declare function publicationBranchOf(template: string | undefined, slug: unknown): string | null;
/** What the loader reads besides `rules.operatorOrders` to check `reducedProof`: the checks and the other rules. */
export interface OrdersContext {
    gates: readonly {
        id: string;
        command: readonly string[];
    }[];
    ciProof?: {
        workflow: string;
        name: string;
    } | undefined;
    requiredGates?: readonly {
        id: string;
        command: readonly string[];
    }[] | undefined;
}
/** Every problem of a declaration that the schema cannot see: keys, address, placeholders. Never echoes a key. */
export declare function operatorOrdersIssues(settings: OperatorOrdersSettings, context?: OrdersContext): string[];
/** The fingerprint of a declaration: the first 12 characters of the SHA-256 of its canonical form (docs/PREUVE-REDUITE.md, 4.3). */
export declare function reducedProofPrint(rp: ReducedProofDeclaration): string;
/**
 * Why the declaration of the head widens the one of the base (docs/PREUVE-REDUITE.md, 4.3), empty when it does not:
 * added; workflow, job or name changed; a check of `gates` or `waives`, a motif of `paths` added; a protected path
 * removed. Removing the declaration, a check, a motif, or adding a protected path never widens it.
 */
export declare function reducedProofWidening(base: ReducedProofDeclaration | undefined, head: ReducedProofDeclaration | undefined): string[];
/** One line of `apv status`: the declaration of the working tree, as the merge on order reads it at the base. */
export declare function operatorOrdersLine(settings: OperatorOrdersSettings | null, error?: string | null): string;
