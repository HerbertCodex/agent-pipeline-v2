import type { Gate, GateReceipt } from '../domain/contracts.js';
export interface ScheduleOptions {
    concurrency: number;
    failFast: boolean;
    signal: AbortSignal;
    execute: (gate: Gate, signal: AbortSignal) => Promise<GateReceipt>;
    blocked: (gate: Gate, reason: string) => GateReceipt;
}
export declare const success: (r: GateReceipt) => boolean;
/** Ready queue with dependencies, named resources and shared-workspace read/write exclusion.
 * Only explicitly read-only gates overlap; a writer excludes readers too. An error never
 * leaves sibling processes running: all active promises are drained before throw. */
export declare function schedule(gates: Gate[], options: ScheduleOptions): Promise<GateReceipt[]>;
