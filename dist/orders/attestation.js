import { errorMessage } from '../domain/errors.js';
import { attestationUrl } from './config.js';
import { checkAttestation } from './order.js';
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
const CLOSED = ['superseded', 'expired', 'merged', 'not_ordered', 'unknown'];
/** Tries of one attestation when the production answers 429 (too many requests), and the longest wait accepted. */
export const ATTESTATION_TRIES = 3;
export const ATTESTATION_MAX_WAIT_MS = 10_000;
/** Wait after a 429 without Retry-After: 1 s, then 2 s. */
const BACKOFF_MS = [1_000, 2_000];
/** The wait a 429 asks for (Retry-After in seconds or as a date), in ms; null when absent or unreadable. */
function retryAfter(response, now = Date.now()) {
    const value = response.headers.get('retry-after');
    if (!value)
        return null;
    if (/^\d+$/.test(value.trim()))
        return Number(value.trim()) * 1000;
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : Math.max(0, at - now);
}
/** The body of an answer, read up to `max` bytes; null beyond. */
async function boundedText(response, max) {
    const reader = response.body?.getReader();
    if (!reader)
        return '';
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > max) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}
function field(text, name) {
    if (text === null)
        return undefined;
    try {
        const value = JSON.parse(text);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value[name] : undefined;
    }
    catch {
        return undefined;
    }
}
/** Asks the production for an attestation of `order` bound to `challenge`, and checks it. Never throws. */
export async function requestAttestation(request) {
    const fetcher = request.fetch ?? ((url, init) => fetch(url, init));
    const sleep = request.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
    const url = attestationUrl(request.template, request.order.nonce, request.challenge);
    let response;
    let body;
    // A 429 (the production limits its requests) is tried again after the wait it asks for, a few times and never longer
    // than ATTESTATION_MAX_WAIT_MS: same challenge, no attestation was given (review of #226).
    for (let attempt = 1;; attempt += 1) {
        try {
            response = await fetcher(url, { signal: AbortSignal.timeout(request.timeoutMs), redirect: 'error', headers: { accept: 'application/json' } });
            body = await boundedText(response, ATTESTATION_MAX_BYTES);
        }
        catch (error) {
            return { ok: false, reason: `unavailable (${errorMessage(error).replace(/\s+/g, ' ').slice(0, 200)})` };
        }
        if (response.status !== 429)
            break;
        const asked = retryAfter(response);
        if (asked !== null && asked > ATTESTATION_MAX_WAIT_MS)
            return { ok: false, reason: `unavailable (HTTP 429, nouvel essai demandé dans ${Math.ceil(asked / 1000)} s : au-delà de ${ATTESTATION_MAX_WAIT_MS / 1000} s, relancer plus tard)` };
        if (attempt >= ATTESTATION_TRIES)
            return { ok: false, reason: `unavailable (HTTP 429 à ${ATTESTATION_TRIES} essais : relancer plus tard)` };
        await sleep(asked ?? BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1));
    }
    if (response.status === 404) {
        const code = field(body, 'code');
        return { ok: false, reason: typeof code === 'string' && CLOSED.includes(code) ? code : 'refusée (404)' };
    }
    if (response.status !== 200)
        return { ok: false, reason: `unavailable (HTTP ${response.status})` };
    const signed = field(body, 'signed');
    if (typeof signed !== 'string')
        return { ok: false, reason: 'malformed' };
    const verdict = checkAttestation(request.domain, request.keys, signed, request.order, request.challenge);
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.code };
}
//# sourceMappingURL=attestation.js.map