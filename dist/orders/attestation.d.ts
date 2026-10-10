import type { PublicKey } from './envelope.js';
import { type PublishOrder } from './order.js';
/**
 * The attestation of the production (docs/REGLES.md, « Fusion sur ordre signé »): just before each merge on order, APV
 * draws a random challenge and asks the address the base declares whether the order is still open (given, not expired,
 * last decision, not merged). Only the production can say it: a comment deleted on GitHub cannot reopen an order there.
 * The answer is signed and bound to the challenge: an old attestation, one asked in advance or one of another order is
 * refused. No secret is sent; the request carries the nonce of the order and the challenge only.
 */
/** Largest answer read: an attestation is a few hundred bytes. */
export declare const ATTESTATION_MAX_BYTES: number;
export type Fetcher = (url: string, init: {
    signal: AbortSignal;
    redirect: 'error';
    headers: Record<string, string>;
}) => Promise<Response>;
export interface AttestationRequest {
    template: string;
    timeoutMs: number;
    domain: string;
    keys: readonly PublicKey[];
    order: PublishOrder;
    challenge: string;
    fetch?: Fetcher;
}
/** `reason`: what the production answered, or why it could not be read (`unavailable`, `signature`, `challenge`...). */
export type AttestationResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** Asks the production for an attestation of `order` bound to `challenge`, and checks it. Never throws. */
export declare function requestAttestation(request: AttestationRequest): Promise<AttestationResult>;
