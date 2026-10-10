import { type KeyObject } from 'node:crypto';
/**
 * Signed envelope of the operator orders (docs/REGLES.md, « Fusion sur ordre signé »): the objects a project signs
 * with Ed25519 on its production server (a decision, an order, an attestation) and that APV only verifies, never signs.
 *
 * - Payload: canonical JSON object (keys sorted by code point, UTF-8, no whitespace, safe integers only, no null),
 *   4 KiB at most, written in base64url without padding.
 * - Signed message: the ASCII prefix `<domain>:signed:1:<kind>`, a line feed, then the bytes of the payload. The prefix
 *   comes from the kind the caller expects, never from the payload: a decision never verifies as an order nor as an
 *   attestation. `domain` is declared by the project (`rules.operatorOrders.domain`).
 * - Comment line: `<!-- <domain>-signed:1 <payload>.<signature> -->`, one per comment at most.
 * - Key id: the first 16 hexadecimal characters of the SHA-256 of the raw public key (32 bytes).
 * - Digest of an object: SHA-256 (hexadecimal) of the bytes of its canonical payload.
 */
export declare const SIGNED_KINDS: readonly ["decision", "publish_order", "publish_attestation"];
export type SignedKind = typeof SIGNED_KINDS[number];
/** Largest canonical payload, in UTF-8 bytes. */
export declare const PAYLOAD_MAX_BYTES = 4096;
/** Domain of the signed messages of a project: lower case letters, digits and dashes. */
export declare const DOMAIN_PATTERN: RegExp;
export declare const KEY_ID_PATTERN: RegExp;
export type JsonValue = string | number | boolean | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
/** Canonical JSON text of `value`, or null when a value has no place in it (null, float, unsafe integer, class instance). */
export declare function canonicalJson(value: unknown): string | null;
/** SHA-256 (hexadecimal) of the UTF-8 bytes of a canonical payload. */
export declare function payloadDigest(canonical: string): string;
export interface PublicKey {
    key: KeyObject;
    id: string;
}
export type PublicKeyProblem = 'private' | 'unreadable' | 'not_ed25519';
/**
 * An Ed25519 public key, given in PEM (SPKI, the output of `openssl pkey -pubout`) or as the base64 line of that PEM.
 * A private key is refused, never read: `createPublicKey` would derive the public key from it, and a private key pasted
 * into a versioned file must be said, not used.
 */
export declare function readPublicKey(text: string): PublicKey | {
    problem: PublicKeyProblem;
};
/** The readable public keys of a declaration; the unreadable ones are left out (the loader already refused them). */
export declare function publicKeys(texts: readonly string[]): PublicKey[];
export type VerifyRefusal = 'malformed' | 'kind' | 'key' | 'signature';
export type Verified = {
    ok: true;
    value: JsonObject;
    canonical: string;
    digest: string;
    keyId: string;
} | {
    ok: false;
    code: VerifyRefusal;
};
/** The object of canonical UTF-8 bytes, or null (not UTF-8, not a JSON object, not canonical, too large). */
export declare function readCanonical(bytes: Buffer): {
    value: JsonObject;
    text: string;
} | null;
/** The payload of a base64url text read without checking any signature (to sort the lines of a comment), or null. */
export declare function unverifiedPayload(payload: string): JsonObject | null;
/**
 * Verifies a payload and its signature (both base64url) as an object of kind `kind` of the project `domain`, with the
 * declared public keys. Codes: malformed (encoding, non canonical JSON, more than 4 KiB, key id absent), kind (a payload
 * of another kind), key (key id not declared), signature (wrong signature for the named key).
 */
export declare function verifySigned(domain: string, kind: SignedKind, payload: string, signature: string, keys: readonly PublicKey[]): Verified;
export interface SignedLine {
    payload: string;
    signature: string;
    value: JsonObject;
}
/**
 * The readable signed lines of comment bodies, one per comment at most: a comment with two marks or more, or whose
 * line cannot be read, gives none (it can neither carry an order nor cancel one).
 */
export declare function signedLines(domain: string, bodies: readonly string[]): SignedLine[];
