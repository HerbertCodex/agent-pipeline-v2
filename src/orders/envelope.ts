import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

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

export const SIGNED_KINDS = ['decision', 'publish_order', 'publish_attestation'] as const;
export type SignedKind = typeof SIGNED_KINDS[number];

/** Largest canonical payload, in UTF-8 bytes. */
export const PAYLOAD_MAX_BYTES = 4096;
/** Domain of the signed messages of a project: lower case letters, digits and dashes. */
export const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;
/** An Ed25519 signature: 64 bytes, 86 characters of base64url without padding. */
const SIGNATURE_TEXT = /^[A-Za-z0-9_-]{86}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PAYLOAD_MAX_ENCODED = Math.ceil((PAYLOAD_MAX_BYTES * 4) / 3);

export type JsonValue = string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Order of code points (not of the UTF-16 units `Array.prototype.sort` compares). */
function byCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const diff = (left[index]!.codePointAt(0) ?? 0) - (right[index]!.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** Canonical JSON text of `value`, or null when a value has no place in it (null, float, unsafe integer, class instance). */
export function canonicalJson(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    return items.includes(null) ? null : `[${items.join(',')}]`;
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => byCodePoint(a, b));
    const parts: string[] = [];
    for (const [key, item] of entries) {
      const text = canonicalJson(item);
      if (text === null) return null;
      parts.push(`${JSON.stringify(key)}:${text}`);
    }
    return `{${parts.join(',')}}`;
  }
  return null;
}

/** SHA-256 (hexadecimal) of the UTF-8 bytes of a canonical payload. */
export function payloadDigest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function prefix(domain: string, kind: SignedKind): Buffer {
  return Buffer.from(`${domain}:signed:1:${kind}\n`, 'ascii');
}

export interface PublicKey { key: KeyObject; id: string }
export type PublicKeyProblem = 'private' | 'unreadable' | 'not_ed25519';

/**
 * An Ed25519 public key, given in PEM (SPKI, the output of `openssl pkey -pubout`) or as the base64 line of that PEM.
 * A private key is refused, never read: `createPublicKey` would derive the public key from it, and a private key pasted
 * into a versioned file must be said, not used.
 */
export function readPublicKey(text: string): PublicKey | { problem: PublicKeyProblem } {
  const value = text.trim();
  if (/PRIVATE KEY/.test(value)) return { problem: 'private' };
  if (value === '') return { problem: 'unreadable' };
  let key: KeyObject;
  try {
    key = value.includes('-----BEGIN')
      ? createPublicKey(value)
      : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
  } catch { return { problem: 'unreadable' }; }
  if (key.type !== 'public') return { problem: 'private' };
  if (key.asymmetricKeyType !== 'ed25519') return { problem: 'not_ed25519' };
  const raw = Buffer.from(String(key.export({ format: 'jwk' }).x), 'base64url');
  if (raw.length !== 32) return { problem: 'unreadable' };
  return { key, id: createHash('sha256').update(raw).digest('hex').slice(0, 16) };
}

/** The readable public keys of a declaration; the unreadable ones are left out (the loader already refused them). */
export function publicKeys(texts: readonly string[]): PublicKey[] {
  return texts.map(readPublicKey).filter((k): k is PublicKey => 'key' in k);
}

export type VerifyRefusal = 'malformed' | 'kind' | 'key' | 'signature';
export type Verified =
  | { ok: true; value: JsonObject; canonical: string; digest: string; keyId: string }
  | { ok: false; code: VerifyRefusal };

/** Bytes of a strict base64url text (no padding, one encoding only), or null. */
function strictBase64url(text: string, maxLength: number): Buffer | null {
  if (text.length === 0 || text.length > maxLength || !BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

/** The object of canonical UTF-8 bytes, or null (not UTF-8, not a JSON object, not canonical, too large). */
export function readCanonical(bytes: Buffer): { value: JsonObject; text: string } | null {
  if (bytes.length === 0 || bytes.length > PAYLOAD_MAX_BYTES) return null;
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return canonicalJson(value) === text ? { value: value as JsonObject, text } : null;
}

/** The payload of a base64url text read without checking any signature (to sort the lines of a comment), or null. */
export function unverifiedPayload(payload: string): JsonObject | null {
  const bytes = strictBase64url(payload, PAYLOAD_MAX_ENCODED);
  return bytes ? readCanonical(bytes)?.value ?? null : null;
}

/**
 * Verifies a payload and its signature (both base64url) as an object of kind `kind` of the project `domain`, with the
 * declared public keys. Codes: malformed (encoding, non canonical JSON, more than 4 KiB, key id absent), kind (a payload
 * of another kind), key (key id not declared), signature (wrong signature for the named key).
 */
export function verifySigned(domain: string, kind: SignedKind, payload: string, signature: string, keys: readonly PublicKey[]): Verified {
  const bytes = strictBase64url(payload, PAYLOAD_MAX_ENCODED);
  const signatureBytes = SIGNATURE_TEXT.test(signature) ? strictBase64url(signature, 86) : null;
  if (!bytes || !signatureBytes || signatureBytes.length !== 64) return { ok: false, code: 'malformed' };
  const read = readCanonical(bytes);
  if (!read) return { ok: false, code: 'malformed' };
  const keyId = read.value['keyId'];
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) return { ok: false, code: 'malformed' };
  if (read.value['kind'] !== kind) return { ok: false, code: 'kind' };
  const key = keys.find(k => k.id === keyId);
  if (!key) return { ok: false, code: 'key' };
  if (!verify(null, Buffer.concat([prefix(domain, kind), bytes]), key.key, signatureBytes)) return { ok: false, code: 'signature' };
  return { ok: true, value: read.value, canonical: read.text, digest: payloadDigest(read.text), keyId };
}

export interface SignedLine { payload: string; signature: string; value: JsonObject }

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The readable signed lines of comment bodies, one per comment at most: a comment with two marks or more, or whose
 * line cannot be read, gives none (it can neither carry an order nor cancel one).
 */
export function signedLines(domain: string, bodies: readonly string[]): SignedLine[] {
  const mark = new RegExp(`${escapeRegExp(domain)}-signed:`, 'g');
  const line = new RegExp(`<!-- ${escapeRegExp(domain)}-signed:1 ([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+) -->`);
  const lines: SignedLine[] = [];
  for (const body of bodies) {
    if ((body.match(mark)?.length ?? 0) !== 1) continue;
    const match = line.exec(body);
    const value = match ? unverifiedPayload(match[1]!) : null;
    if (match && value) lines.push({ payload: match[1]!, signature: match[2]!, value });
  }
  return lines;
}
