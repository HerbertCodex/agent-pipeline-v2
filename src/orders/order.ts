import { canonicalJson, signedLines, verifySigned, type JsonObject, type PublicKey, type VerifyRefusal } from './envelope.js';

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

export const ORDER_STEPS = ['publication', 'article'] as const;
export type OrderStep = typeof ORDER_STEPS[number];

/** Longest life of an order: 7 days. */
export const ORDER_MAX_TTL_MS = 7 * 24 * 3600 * 1000;
export const COMMIT = /^[0-9a-f]{40}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PR_MAX = 999_999_999;

export type OrderRefusal = VerifyRefusal | 'repo' | 'pr' | 'expired' | 'nonce_conflict' | 'decision_conflict' | 'decision_missing' | 'superseded' | 'head_moved';

export interface PublishOrder {
  repo: string; articlePr: number; articleSha: string; decisionRef: string; decisionSeq: number;
  issuedAt: string; expiresAt: string; nonce: string; keyId: string;
  /** The whole signed payload, given as is to the verification command of the project. */
  payload: JsonObject;
}
export interface VerifiedOrder { order: PublishOrder; payload: string; signature: string; digest: string }

interface Decision { repo: string; pr: number; decision: string; articleSha: string; requestId: string; seq: number; choices: string | null; canonical: string }

const isPr = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= PR_MAX;
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const text = (v: unknown, pattern: RegExp): v is string => typeof v === 'string' && pattern.test(v);
const instant = (v: unknown): v is string => text(v, ISO_MS) && new Date(Date.parse(v)).toISOString() === v;
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The fields APV reads of a signed order, or null when one is missing or out of its bounds. */
export function readOrder(value: JsonObject): PublishOrder | null {
  const v = value;
  if (v['format'] !== 1 || v['kind'] !== 'publish_order') return null;
  if (!text(v['repo'], REPO) || !isPr(v['articlePr']) || !text(v['articleSha'], COMMIT) || !text(v['decisionRef'], UUID) || !isSeq(v['decisionSeq'])) return null;
  if (!instant(v['issuedAt']) || !instant(v['expiresAt']) || !text(v['nonce'], UUID) || typeof v['keyId'] !== 'string') return null;
  const life = Date.parse(v['expiresAt']) - Date.parse(v['issuedAt']);
  if (life <= 0 || life > ORDER_MAX_TTL_MS) return null;
  return { repo: v['repo'], articlePr: v['articlePr'], articleSha: v['articleSha'], decisionRef: v['decisionRef'], decisionSeq: v['decisionSeq'],
    issuedAt: v['issuedAt'], expiresAt: v['expiresAt'], nonce: v['nonce'], keyId: v['keyId'], payload: v };
}

function readDecision(value: JsonObject, canonical: string): Decision | null {
  const v = value;
  if (v['format'] !== 1 || v['kind'] !== 'decision' || !text(v['repo'], REPO) || !isPr(v['pr']) || typeof v['decision'] !== 'string') return null;
  if (!text(v['articleSha'], COMMIT) || !text(v['requestId'], UUID) || !isSeq(v['seq'])) return null;
  return { repo: v['repo'], pr: v['pr'], decision: v['decision'], articleSha: v['articleSha'], requestId: v['requestId'], seq: v['seq'],
    choices: v['choices'] === undefined ? null : canonicalJson(v['choices']), canonical };
}

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
export type OrderVerdict = ({ ok: true } & VerifiedOrder) | { ok: false; code: OrderRefusal };

/**
 * The order `nonce` among the comments: authenticated by a declared key, then bound to the repository, the pull request,
 * the time, the last signed decision of the pull request and its head. The first refusal is given.
 */
export function verifyOrder(input: OrderInput): OrderVerdict {
  const refuse = (code: OrderRefusal): OrderVerdict => ({ ok: false, code });
  const lines = signedLines(input.domain, input.bodies);
  const candidates = lines.filter(l => l.value['kind'] === 'publish_order' && l.value['nonce'] === input.nonce);
  if (!candidates.length) return refuse('malformed');
  const checked = candidates.map(line => ({ line, verdict: verifySigned(input.domain, 'publish_order', line.payload, line.signature, input.keys) }));
  const authentic = checked.filter(c => c.verdict.ok);
  // Identical copies are tolerated; two authentic payloads under one nonce are not (the signer never does it).
  if (new Set(authentic.map(c => c.line.payload)).size > 1) return refuse('nonce_conflict');
  const first = authentic[0];
  if (!first || !first.verdict.ok) {
    const failed = checked[0]!.verdict;
    return refuse(failed.ok ? 'malformed' : failed.code);
  }
  const order = readOrder(first.verdict.value);
  if (!order) return refuse('malformed');
  if (!sameRepo(order.repo, input.repo)) return refuse('repo');
  if (order.articlePr !== input.pr) return refuse('pr');
  if (Date.parse(order.expiresAt) <= input.now) return refuse('expired');

  const decisions: Decision[] = [];
  for (const line of lines.filter(l => l.value['kind'] === 'decision')) {
    const verdict = verifySigned(input.domain, 'decision', line.payload, line.signature, input.keys);
    const decision = verdict.ok ? readDecision(verdict.value, verdict.canonical) : null;
    if (decision && sameRepo(decision.repo, input.repo) && decision.pr === input.pr) decisions.push(decision);
  }
  const bySeq = new Map<number, Set<string>>();
  for (const d of decisions) bySeq.set(d.seq, (bySeq.get(d.seq) ?? new Set<string>()).add(d.canonical));
  if ([...bySeq.values()].some(payloads => payloads.size > 1)) return refuse('decision_conflict');
  const own = decisions.find(d => d.seq === order.decisionSeq && d.requestId === order.decisionRef);
  if (!own) return refuse('decision_missing');
  const last = decisions.reduce((max, d) => (d.seq > max.seq ? d : max));
  const choices = order.payload['choices'] === undefined ? null : canonicalJson(order.payload['choices']);
  if (last.seq !== own.seq || own.decision !== 'validate' || own.articleSha !== order.articleSha || own.choices !== choices) return refuse('superseded');
  if (order.articleSha !== input.head) return refuse('head_moved');
  return { ok: true, order, payload: first.line.payload, signature: first.line.signature, digest: first.verdict.digest };
}

export type AttestationRefusal = VerifyRefusal | 'challenge' | 'order';
/**
 * An attestation of the production for `order` and the challenge APV drew: signed by a declared key under the kind
 * `publish_attestation`, for the same repository, pull request, commit, order and decision.
 */
export function checkAttestation(domain: string, keys: readonly PublicKey[], signed: string, order: PublishOrder, challenge: string):
  { ok: true } | { ok: false; code: AttestationRefusal } {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(signed);
  if (!match) return { ok: false, code: 'malformed' };
  const verdict = verifySigned(domain, 'publish_attestation', match[1]!, match[2]!, keys);
  if (!verdict.ok) return verdict;
  const v = verdict.value;
  if (v['format'] !== 1) return { ok: false, code: 'malformed' };
  if (v['challenge'] !== challenge) return { ok: false, code: 'challenge' };
  const same = typeof v['repo'] === 'string' && sameRepo(v['repo'], order.repo) && v['articlePr'] === order.articlePr && v['articleSha'] === order.articleSha
    && v['orderNonce'] === order.nonce && v['decisionSeq'] === order.decisionSeq;
  return same ? { ok: true } : { ok: false, code: 'order' };
}

/**
 * A merge commit made by APV on order, read on the first-parent history of the target: two parents, the trailer
 * `Apv-Order`, `Apv-Order-Step`, `Apv-Order-Sha256` and `Apv-Merged-Head` read by Git as trailers (the last paragraph of
 * the message), the merged head being the second parent. A trailer copied into an ordinary commit (a squash) is not one.
 */
export interface OrderMergeCommit {
  sha: string; firstParent: string; nonce: string; step: OrderStep; digest: string; head: string;
  /** The whole message, trimmed: a merge APV made has exactly the message of `mergeMessage`. */
  message: string;
}

/** The format of `git log` that `orderMergeCommits` reads. */
export const ORDER_LOG_FORMAT = '--format=%H%x1f%P%x1f%(trailers:key=Apv-Order,key=Apv-Order-Step,key=Apv-Order-Sha256,key=Apv-Merged-Head,unfold)%x1f%B%x1e';

/** The message of the merge commit of a step: a title, then the trailer (nonce, step, digest of the order, merged head). */
export function mergeMessage(input: { pr: number; step: OrderStep; nonce: string; digest: string; head: string }): string {
  return [`Fusion sur ordre de l'opérateur : PR #${input.pr} (étape ${input.step})`, '',
    `Apv-Order: ${input.nonce}`, `Apv-Order-Step: ${input.step}`, `Apv-Order-Sha256: ${input.digest}`, `Apv-Merged-Head: ${input.head}`, ''].join('\n');
}

/** The merge commits on order of a `git log --first-parent ORDER_LOG_FORMAT` output, newest first. */
export function orderMergeCommits(log: string): OrderMergeCommit[] {
  const out: OrderMergeCommit[] = [];
  for (const record of log.split('\x1e').map(r => r.trim()).filter(Boolean)) {
    const [sha, parents, trailers = '', message = ''] = record.split('\x1f');
    const list = (parents ?? '').split(' ').filter(Boolean);
    if (!sha || list.length !== 2) continue;
    const one = (key: string, pattern: string): string | null => {
      const found = [...trailers.matchAll(new RegExp(`^${key}: (${pattern})$`, 'gm'))];
      return found.length === 1 ? found[0]![1]! : null;
    };
    const nonce = one('Apv-Order', '[0-9a-f-]{36}');
    const step = one('Apv-Order-Step', 'publication|article') as OrderStep | null;
    const digest = one('Apv-Order-Sha256', '[0-9a-f]{64}');
    const head = one('Apv-Merged-Head', '[0-9a-f]{40}');
    if (nonce && UUID.test(nonce) && step && digest && head && head === list[1]) out.push({ sha, firstParent: list[0]!, nonce, step, digest, head, message: message.trim() });
  }
  return out;
}
