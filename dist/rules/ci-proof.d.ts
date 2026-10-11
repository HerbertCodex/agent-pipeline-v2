import type { ApvConfig } from '../config/load.js';
import type { GhRunner } from '../stack/github.js';
import type { CiProofSettings } from './config.js';
/**
 * The proof by the CI (docs/REGLES.md, « Preuve par la CI », issue #130). The check run of the job the base declares
 * (`rules.ciProof`) stands in for the local receipts of the checks it covers, only when:
 * - the change leaves unchanged, since the merge base, the workflow and every file that produces the proof (paths
 *   compared by Git, the scripts of package.json one by one); otherwise it leaves the CI lane: local proof required;
 * - the check run comes from the GitHub Actions application, at the exact commit, concluded in success, read through the
 *   API of the check runs; its run is one of the declared workflow (its id resolved to the path), at the same commit,
 *   for an event whose tested commit is the one of the run, and the check run is a job of that run.
 * The receipts the job leaves in its artifact are never read here: the measure only. Without the network or the API,
 * nothing is accepted: the rule falls back on the local proof.
 */
/** The only application whose check runs count: GitHub Actions. */
export declare const GITHUB_ACTIONS_APP = "github-actions";
/** Its identifier (the slug alone could be taken by another application of that name). */
export declare const GITHUB_ACTIONS_APP_ID = 15368;
export type CiProofState = 'accepted' | 'refused' | 'out_of_lane' | 'unavailable';
export interface CiCheckRun {
    id: number;
    url: string | null;
    runId: number;
    runAttempt: number;
    event: string;
    workflow: string;
}
export interface CiProofOutcome {
    /**
     * `accepted`: the check run proves `gates`; `refused`: no check run proves them (reasons); `out_of_lane`: the change
     * modifies what produces the proof, or the declaration does not match the workflow of the base; `unavailable`: the
     * API could not be read (offline, origin outside github.com, error, unexpected answer).
     */
    state: CiProofState;
    /** Checks the CI proves (accepted) or would prove: declared, without a clean local receipt, not excluded. */
    gates: string[];
    /** Checks declared that the CI cannot prove for this change, each with its reason. */
    excluded: {
        gate: string;
        reason: string;
    }[];
    /** Why the CI does not prove them (empty when accepted); the check runs ignored come first. */
    reasons: string[];
    /** The check run accepted, or the latest one examined. */
    checkRun: CiCheckRun | null;
    workflow: string;
    name: string;
    artifact: string | null;
}
export interface CiProofInput {
    repo: string;
    mergeBase: string;
    head: string;
    settings: CiProofSettings;
    /** Checks of the full suite without a clean local receipt at the commit (state missing or dirty). */
    pending: readonly string[];
    /** The configuration of the checks the proof uses (repeatChanged of each). */
    config: ApvConfig;
    /** `gh` (never APV_GH), or null offline. */
    gh: GhRunner | null;
    /** `owner/name` of the repository on github.com, or null. */
    repository: string | null;
}
/**
 * Whether the workflow text declares, under `jobs:`, the job `job` whose name (`name:`, else its key) is `name`: the check run
 * of the API names a job, and the declared key must be the one that produces it.
 */
export declare function declaresJob(text: string, job: string, name: string): boolean;
/**
 * Whether the CI proves, at `head`, the checks of `pending` that `rules.ciProof` covers. Never throws: an error of the API
 * is `unavailable`, and nothing is accepted then.
 */
export declare function verifyCiProof(input: CiProofInput): Promise<CiProofOutcome>;
/** Lines that say why the CI does not prove the checks, for the refusal of the rule preuve. */
export declare function ciProofLines(ci: CiProofOutcome): string[];
