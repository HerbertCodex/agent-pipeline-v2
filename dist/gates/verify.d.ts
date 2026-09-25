import { type GateReceipt, type GateStage } from '../domain/contracts.js';
import type { ApvConfig } from '../config/load.js';
export interface VerifyOptions {
    repo: string;
    config: ApvConfig;
    /** Commit to verify: any revision Git resolves to a commit, compared by its full SHA. */
    commit: string;
    /**
     * `full` (default): every declared check is required, each proven by a complete (never targeted) receipt.
     * `task`: the checks of stage task, and the full checks that declare `affected`, each proven by its targeted
     * receipt (tests concerned by the changes since `base`) or by a complete one.
     */
    stage?: GateStage;
    /**
     * Stage task with targeted checks (required then): the commit the targeted tests must cover the changes from,
     * usually the last commit the full suite proved. A targeted receipt counts only when the base of its run is
     * this commit or one of its ancestors (it then covered at least these changes).
     */
    base?: string;
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
    /** Receipts at this commit of the targeted variant (`affected`) of the check: never proof of it at stage full. */
    targeted: number;
    /** Stage task: whether the check is required through its targeted variant (a full check that declares `affected`). */
    viaTargeted: boolean;
    /** The kind of the receipt retained: `full` (the whole check) or `targeted` (its `affected` command); null without one. */
    proof: 'full' | 'targeted' | null;
    /** Stage task: targeted receipts ignored because the base of their run does not cover `base` (another base, or none). */
    otherBase: number;
    /** Where the receipt retained was read (the worktree, or the shared store of the repository); null without one. */
    source: ReceiptSource | null;
}
export interface VerifyResult {
    repo: string;
    commit: string;
    stage: GateStage;
    /** Base the targeted receipts had to cover (stage task with targeted checks), or null. */
    base: string | null;
    configHash: string;
    required: string[];
    /** Required checks proven through their targeted variant (stage task). */
    targeted: string[];
    /** Stage task: full checks without a targeted variant, left to the full suite (not required, never proven here). */
    reserved: string[];
    gates: GateEvidence[];
    /** Receipt files that could not be read or validated (ignored, reported). */
    unreadable: string[];
    /** Shared store of the repository, read after the worktree (`<git common dir>/apv/receipts`). */
    store: string;
    /** Runs of the shared store refused as a whole (files altered or contradicting their manifest). */
    altered: AlteredRun[];
    ok: boolean;
}
/** Where a receipt was read: the `.apv/receipts/` of the worktree, or the shared store of the repository. */
export type ReceiptSource = 'local' | 'shared';
/** A run of the shared store refused as a whole: its files no longer match its manifest, or contradict it. */
export interface AlteredRun {
    runId: string;
    reason: string;
}
/**
 * Whether the receipts prove that every required check passed on this exact commit, on a clean tree and with
 * the current configuration of the checks. Receipts of any run count (a task run proves its checks as well as a
 * full one), but for each check only the latest such receipt does: a failure is never hidden by an older success.
 * At stage full, receipts of a targeted run (`targeted`, the `affected` command of a full check) never count.
 * At stage task, a full check that declares `affected` is required too: its targeted receipts count when their
 * run's base covers `base` (mandatory then), and so do its complete receipts; the latest of them decides.
 * Receipts are read from the worktree (`.apv/receipts/`), then from the shared store of the repository for the
 * runs the worktree does not have (a run proven in a worktree since removed): same requirements, and a shared
 * run counts only when intact (src/gates/store.ts).
 */
export declare function verifyGates(options: VerifyOptions): Promise<VerifyResult>;
