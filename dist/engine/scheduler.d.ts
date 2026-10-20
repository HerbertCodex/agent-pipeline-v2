import type { Gate, GateReceipt } from '../domain/contracts.js';
export interface ScheduleOptions {
    concurrency: number;
    failFast: boolean;
    signal: AbortSignal;
    execute: (gate: Gate, signal: AbortSignal) => Promise<GateReceipt>;
    blocked: (gate: Gate, reason: string) => GateReceipt;
    /**
     * Whether a receipt of this schedule counts as passed (default `success`). A caller that wrote a receipt `cached` after
     * checking its reuse (src/gates/reuse-proof.ts) says so here; nothing else ever counts a receipt `cached` as a success.
     */
    succeeded?: (receipt: GateReceipt) => boolean;
}
/**
 * A receipt that counts as passed: executed and passed, `passed_after_retry` too (every test passed on the exact code; shown
 * apart as unstable). A receipt `cached` never counts by itself: it proves nothing until its reuse is checked against Git and
 * the store (checkReuse, src/gates/reuse-proof.ts), and only the caller that checked it counts it (`succeeded`).
 */
export declare const success: (r: GateReceipt) => boolean;
/** Ready queue with dependencies, named resources and shared-workspace read/write exclusion.
 * Only explicitly read-only gates overlap; a writer excludes readers too. An error never
 * leaves sibling processes running: all active promises are drained before throw. */
export declare function schedule(gates: Gate[], options: ScheduleOptions): Promise<GateReceipt[]>;
