import type { Run } from '../domain/contracts.js';
interface Event {
    at: number;
    type: string;
    data: unknown;
}
/** Phase durations are observations, not additive CPU times or latency promises. */
export declare function phaseTimings(docEvents: Event[], runs: {
    run: Run;
    events: Event[];
}[], now: number): {
    phases: {
        phase: string;
        durationMs: number;
    }[];
    preflightMs: number;
    active: {
        role: string;
        elapsedMs: number;
        runId: string | null;
    }[];
    historicalPartial: boolean;
    note: string;
};
export {};
