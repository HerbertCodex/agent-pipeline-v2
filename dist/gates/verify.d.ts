import { type GateReceipt, type GateStage } from '../domain/contracts.js';
import type { ApvConfig } from '../config/load.js';
export interface VerifyOptions {
    repo: string;
    config: ApvConfig;
    /** Commit to verify: any revision Git resolves to a commit, compared by its full SHA. */
    commit: string;
    /** `full` (default): every declared check is required. `task`: the checks of stage task only. */
    stage?: GateStage;
}
/**
 * State of one required check at the commit:
 * - `passed`: its latest receipt on a clean tree with the current configuration succeeded;
 * - `failed`: that latest receipt did not succeed (a later failure always overrides an earlier success);
 * - `dirty`: receipts exist at this commit, but only with uncommitted changes (or an unknown tree state);
 * - `missing`: no receipt at this commit with the current configuration.
 */
export type EvidenceState = 'passed' | 'failed' | 'dirty' | 'missing';
export interface GateEvidence {
    gateId: string;
    state: EvidenceState;
    /** Status of the receipt retained, when there is one. */
    status: GateReceipt['status'] | null;
    receipt: string | null;
    runId: string | null;
    /** Receipts at this commit written for another configuration of the checks (ignored). */
    otherConfig: number;
    /** Receipts at this commit of the targeted variant (`affected`) of the check: never proof of it (ignored). */
    targeted: number;
}
export interface VerifyResult {
    repo: string;
    commit: string;
    stage: GateStage;
    configHash: string;
    required: string[];
    gates: GateEvidence[];
    /** Receipt files that could not be read or validated (ignored, reported). */
    unreadable: string[];
    ok: boolean;
}
/**
 * Whether the receipts prove that every required check passed on this exact commit, on a clean tree and with
 * the current configuration of the checks. Receipts of any run count (a task run proves its checks as well as a
 * full one), but for each check only the latest such receipt does: a failure is never hidden by an older success.
 * Receipts of a targeted run (`targeted`, the `affected` command of a full check) never count.
 */
export declare function verifyGates(options: VerifyOptions): Promise<VerifyResult>;
