import { type ApvConfig } from '../config/load.js';
import type { DiffRisk } from '../review/risk.js';
/**
 * Incremental proof after corrections (`apv gates run --stage task --since <commit prouvé>`). Pilot project, 3 October
 * 2026: a pull request of tests and texts ran the full suite of 30 minutes after each round of corrections. A round of
 * corrections that follows a commit with a green full proof, and whose diff since that commit is of low risk (the
 * classification of `apv review plan`, src/review/risk.ts), runs the checks of the task stage from that commit: the
 * targeted commands (`affected`, `{{baseSha}}` = the proven commit) and the repetition of the changed test files
 * (`repeatChanged`). It never proves the full suite: `apv gates verify` and `apv rules check` still require the full
 * suite at the exact commit merged, run once on the final commit.
 */
export interface SinceCheck {
    /** The proven commit (full SHA). */
    commit: string;
    head: string;
    /** Checks proven by the full suite at the proven commit. */
    proven: string[];
    risk: DiffRisk;
}
/**
 * Refuses (`GATE_SINCE`) unless: the working tree is clean (an uncommitted change would escape the classification),
 * HEAD strictly descends from `since`, the full suite is proven at `since` with this configuration of the checks and
 * without any check passed only after a relaunch, and the diff from `since` to HEAD is of low risk, classified with the
 * review settings read at `since` (a correction never reclassifies its own files).
 */
export declare function checkSince(repo: string, config: ApvConfig, configFile: string | null, since: string): Promise<SinceCheck>;
