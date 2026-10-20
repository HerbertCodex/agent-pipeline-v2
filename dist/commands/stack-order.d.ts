import { type RulesInput } from '../rules/check.js';
import { type GhCall } from '../stack/github.js';
import { type OrderMergeReport, type RulesVerdict, type StepProof } from '../orders/merge.js';
import type { OrderLane } from '../rules/reduced-proof.js';
import type { CommandIO } from './io.js';
/** Options of `apv stack merge` that a merge on order never takes: its method, target and checks are fixed. */
declare const FOREIGN: readonly ["method", "target", "ready", "allow-behind", "reason", "keep-branches", "wait-ci"];
type OrderValues = {
    order?: string | undefined;
    json?: boolean | undefined;
} & Partial<Record<typeof FOREIGN[number], unknown>>;
export declare const ORDER_USAGE = "--order <r\u00E9f\u00E9rence>  (merge) fusion sur ordre sign\u00E9 de l'op\u00E9rateur, sans session de l'op\u00E9rateur : exactement deux PR,\n       la PR de publication puis la PR d'article qui porte l'ordre. Lit rules.operatorOrders \u00E0 la base de confiance (la cible avant\n       toute fusion sur cet ordre, fix\u00E9e pour tout le lancement) : ordre authentifi\u00E9\n       par une cl\u00E9 d\u00E9clar\u00E9e, non \u00E9chu, li\u00E9 \u00E0 la d\u00E9cision sign\u00E9e de plus grand num\u00E9ro, non consomm\u00E9 (pied Apv-Order de\n       l'histoire de la cible) ; t\u00EAte de publication descendante de la cible ; commande de v\u00E9rification du projet lanc\u00E9e\n       depuis une copie propre de la base de confiance ; r\u00E8gles de apv rules check \u00E0 la t\u00EAte fusionn\u00E9e ; attestation fra\u00EEche de la\n       production li\u00E9e \u00E0 un d\u00E9fi tir\u00E9 par APV ; commit de fusion de parents (cible, t\u00EAte) avec le pied Apv-Order, pouss\u00E9\n       sans force dans les maxAgeSeconds de l'attestation. Une \u00E9tape \u00E0 la fois, publication puis article ; d\u00E9j\u00E0 faites :\n       already_done (sortie 0). Jamais l'API de fusion de GitHub, jamais de pouss\u00E9e forc\u00E9e. Refus : code et raison.";
/**
 * The rules checked before a merge on order (src/rules/check.ts) at `head`, against the exact commit of the target APV
 * read and merges on (never a remote-tracking ref left stale), the proof by the CI (rules.ciProof of the base) read
 * through `ci.gh`, with the context of the reduced lane mergeOnOrder built for this try (docs/PREUVE-REDUITE.md): the
 * problems, empty when respected, and the proof taken (`reduced` only when the rule preuve accepted the reduced lane).
 */
export declare function orderRules(repo: string, ci: NonNullable<RulesInput['ci']>): (head: string, base: string, lane?: OrderLane) => Promise<RulesVerdict>;
/** Lines of the report of a merge on order. */
export declare function orderLines(report: OrderMergeReport, nonce: string): string[];
/** `APV_ALLOW_MERGE=1 apv stack merge <publication> <article> --order <nonce>`. */
export declare function stackMergeOnOrder(prs: number[], values: OrderValues, io: CommandIO, transcript: (bin: string, call: GhCall) => string, traceMerge: (cwd: string, merge: {
    pr: number;
    head: string;
    target: string;
    method: string;
    mergeCommit: string | null;
    proof?: StepProof;
}) => string | null): Promise<number>;
export {};
