import { type ApvConfig } from '../config/load.js';
import type { VerifyResult } from '../gates/verify.js';
/**
 * A test unstable at the release, unrelated to the change (docs/UNE-SUITE-PAR-PR.md, 3): a check of the full suite passed only
 * after the relaunch of its failed tests (`passed_after_retry`). Production no longer waits for an old test that fails at random
 * beside the change; the test is written as a finding (journal of the releases, follow-up of the findings) to be fixed apart.
 *
 * A relaunched test is unrelated when: its name gives its file (a path of the commit, `tests/a.spec.ts:12:5 › …`); that file is
 * neither added nor modified since production; and it is not among the test files the `affectedList` command of its check,
 * **read at production**, prints for the changes since production (the same computation as `affected`: the import graph of the
 * tests). Anything else blocks, as before: no test named (no `retryFailed.testPattern`, or no line matching it), a file the name
 * does not give, a check without `affectedList` at production, a list that fails, a test of a changed file or that the change
 * concerns. A failure that the relaunch did not cure, a repetition of a changed test that failed, a migration not confirmed:
 * still refused, elsewhere, as before. What blocks here, the operator alone can waive for the exact released commit
 * (`releaseWaiver`, « dérogation instable <commit> : <raison> »): published, each test written as a finding with his words.
 */
export interface UnstableTest {
    gateId: string;
    test: string;
    /** The files of the commit its name gives (one, usually); empty: none. */
    files: string[];
    runId: string;
    receipt: string;
    /** Failed passes out of the passes of the test: 1 out of 2 (first pass failed, relaunch passed). */
    failed: number;
    passes: number;
    /** Why it blocks the release, or null: unrelated to the change, written as a finding. */
    blocking: string | null;
}
/** `busy`: no copy to judge them in (the tests are judged later): never waived, whatever the operator typed. */
export interface UnstableVerdict {
    tests: UnstableTest[];
    blocking: string[];
    busy?: true;
}
/**
 * The waiver of the rule `instable` the operator typed for the released commit (docs/UNE-SUITE-PAR-PR.md, 3.1; decision of the
 * operator of 22 October 2026): « dérogation instable <12 premiers caractères du commit au moins> : <raison> », the very line
 * that waives the rule at the merge. Read in the operator journal (signed by the UserPromptSubmit hook, never by an agent) by
 * the same code as the waivers of the merge (`waiverFor`): for this exact commit only, never for another, never without a
 * reason nor with the template of the tool. It waives the blocking verdicts on checks that passed after the relaunch of their
 * failed tests (`passed_after_retry`) only: a failure the relaunch did not cure, a repetition that failed, a migration not
 * confirmed are refused before, the waiver never reaches them.
 */
export interface ReleaseWaiver {
    rule: 'instable';
    commit: string;
    at: string;
    reason: string;
    line: string;
    blocking: string[];
}
/** The waiver of `instable` for `sha` in the journal of the Git common directory `common`; `template`: one typed with `<ta raison>`. */
export declare function releaseWaiver(common: string, sha: string, blocking: readonly string[]): {
    waiver: ReleaseWaiver | null;
    template: boolean;
};
/**
 * The files of `tracked` a text names: a path of the commit as written, or the only file of the commit it ends (a runner prints
 * paths from its own root: `a.spec.ts` for `tests/e2e/a.spec.ts`). A suffix several files end: all of them when `all`, else none.
 */
export declare function pathsIn(text: string, tracked: readonly string[], all?: boolean): string[];
/**
 * The verdict on the unstable checks of `proof` at `commit`, released from `production`: each relaunched test, related or not.
 * `copy`: a prepared copy of the commit, where the `affectedList` commands run. `config`: the checks of the release (those of
 * production kept); `affectedList` is read at production only.
 */
export declare function classifyUnstable(input: {
    repo: string;
    copy: string;
    commit: string;
    production: string;
    config: ApvConfig;
    proof: VerifyResult;
    env: NodeJS.ProcessEnv;
    log: (line: string) => void;
}): Promise<UnstableVerdict>;
/** The line of the follow-up of a finding for an unstable test unrelated to the change. */
export declare const findingLine: (t: UnstableTest, commit: string, date: string) => string;
/** What the operator's waiver is said with, in the output and the follow-up: its date and reason. */
export declare const waiverWords: (w: ReleaseWaiver) => string;
/** The line of the follow-up of a test (or of a check, `t` null) published only by the waiver of the operator. */
export declare const waivedFindingLine: (w: ReleaseWaiver, date: string, t: UnstableTest | null, why: string) => string;
/** The waived findings: each blocking test, then each blocking reason no test carries (a check whose tests are not named). */
export declare function waivedFindings(w: ReleaseWaiver, tests: readonly UnstableTest[], date: string): string[];
/**
 * Appends the unstable tests unrelated to the change, and those the waiver of the operator published, to the follow-up of the findings (`.apv/state/suivi-constats.md` of the
 * checkout), once per test and commit. A failure is returned, never thrown: the release stands, its journal says it.
 */
export declare function writeFindings(root: string, commit: string, tests: readonly UnstableTest[], now?: Date, waiver?: ReleaseWaiver | null): string | null;
