import { type Infer } from '../domain/schema.js';
/**
 * `rules.operatorOrders` of `.apv/config.json` (docs/REGLES.md, « Fusion sur ordre signé »), always read at the base of
 * the merge (a pull request never changes the rules it is checked against):
 * - `domain`: the domain of the signed messages of the project (`<domain>:signed:1:<kind>`, comment `<domain>-signed:1`);
 * - `publicKeys`: the Ed25519 public keys of the signer (PEM SPKI or its base64 line), two during a rotation; never a
 *   private key (refused by the loader, never echoed);
 * - `attestation`: the address of the production that attests an order is open, with `{nonce}` and `{challenge}`
 *   replaced by APV (HTTPS; plain HTTP on the loopback only, for the tests), and `maxAgeSeconds`, the longest time
 *   between the attestation and the push of the merge (120 by default);
 * - `verify.publication`: the command of the project that checks the content of a step, run by APV from a clean copy
 *   of the base (`{{base}}`, `{{head}}`, `{{step}}` replaced as whole arguments, the verified order on its input).
 */
export declare const DEFAULT_ATTESTATION_MAX_AGE_SECONDS = 120;
export declare const DEFAULT_ATTESTATION_TIMEOUT_MS = 15000;
export declare const DEFAULT_VERIFY_TIMEOUT_MS = 900000;
/** Placeholders of `verify.publication`, replaced as whole arguments. */
export declare const VERIFY_PLACEHOLDERS: readonly ["base", "head", "step"];
export declare const operatorOrdersSchema: import("../domain/schema.js").Schema<{
    readonly domain: string;
    readonly publicKeys: string[];
    readonly attestation: {
        readonly url: string;
        readonly maxAgeSeconds: number;
        readonly timeoutMs: number;
    };
    readonly verify: {
        readonly publication: string[];
        readonly timeoutMs: number;
    };
}>;
export type OperatorOrdersSettings = Infer<typeof operatorOrdersSchema>;
/** The attestation address with its placeholders replaced (values already checked as UUID). */
export declare function attestationUrl(template: string, nonce: string, challenge: string): string;
/** Every problem of a declaration that the schema cannot see: keys, address, placeholders. Never echoes a key. */
export declare function operatorOrdersIssues(settings: OperatorOrdersSettings): string[];
/** One line of `apv status`: the declaration of the working tree, as the merge on order reads it at the base. */
export declare function operatorOrdersLine(settings: OperatorOrdersSettings | null, error?: string | null): string;
