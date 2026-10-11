import { errorMessage } from '../domain/errors.js';
import { attestationUrl } from './config.js';
import type { PublicKey } from './envelope.js';
import { checkAttestation, type PublishOrder } from './order.js';

/**
 * The attestation of the production (docs/REGLES.md, « Fusion sur ordre signé »): just before each merge on order, APV
 * draws a random challenge and asks the address the base declares whether the order is still open (given, not expired,
 * last decision, not merged). Only the production can say it: a comment deleted on GitHub cannot reopen an order there.
 * The answer is signed and bound to the challenge: an old attestation, one asked in advance or one of another order is
 * refused. No secret is sent; the request carries the nonce of the order and the challenge only.
 */

/** Largest answer read: an attestation is a few hundred bytes. */
export const ATTESTATION_MAX_BYTES = 16 * 1024;
/** Reasons a production gives for a closed order (404), repeated as they are; any other text is not. */
const CLOSED = ['superseded', 'expired', 'merged', 'not_ordered', 'unknown'] as const;

export type Fetcher = (url: string, init: { signal: AbortSignal; redirect: 'error'; headers: Record<string, string> }) => Promise<Response>;

export interface AttestationRequest {
  template: string; timeoutMs: number; domain: string; keys: readonly PublicKey[]; order: PublishOrder; challenge: string;
  fetch?: Fetcher;
}
/** `reason`: what the production answered, or why it could not be read (`unavailable`, `signature`, `challenge`...). */
export type AttestationResult = { ok: true } | { ok: false; reason: string };

/** The body of an answer, read up to `max` bytes; null beyond. */
async function boundedText(response: Response, max: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function field(text: string | null, name: string): unknown {
  if (text === null) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined;
  } catch { return undefined; }
}

/** Asks the production for an attestation of `order` bound to `challenge`, and checks it. Never throws. */
export async function requestAttestation(request: AttestationRequest): Promise<AttestationResult> {
  const fetcher: Fetcher = request.fetch ?? ((url, init) => fetch(url, init));
  const url = attestationUrl(request.template, request.order.nonce, request.challenge);
  let response: Response;
  let body: string | null;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(request.timeoutMs), redirect: 'error', headers: { accept: 'application/json' } });
    body = await boundedText(response, ATTESTATION_MAX_BYTES);
  } catch (error) {
    return { ok: false, reason: `unavailable (${errorMessage(error).replace(/\s+/g, ' ').slice(0, 200)})` };
  }
  if (response.status === 404) {
    const code = field(body, 'code');
    return { ok: false, reason: typeof code === 'string' && (CLOSED as readonly string[]).includes(code) ? code : 'refusée (404)' };
  }
  if (response.status !== 200) return { ok: false, reason: `unavailable (HTTP ${response.status})` };
  const signed = field(body, 'signed');
  if (typeof signed !== 'string') return { ok: false, reason: 'malformed' };
  const verdict = checkAttestation(request.domain, request.keys, signed, request.order, request.challenge);
  return verdict.ok ? { ok: true } : { ok: false, reason: verdict.code };
}
