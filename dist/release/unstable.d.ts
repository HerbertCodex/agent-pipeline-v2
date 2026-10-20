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
 * still refused, elsewhere, as before.
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
export interface UnstableVerdict {
    tests: UnstableTest[];
    blocking: string[];
}
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
/**
 * Appends the unstable tests unrelated to the change to the follow-up of the findings (`.apv/state/suivi-constats.md` of the
 * checkout), once per test and commit. A failure is returned, never thrown: the release stands, its journal says it.
 */
export declare function writeFindings(root: string, commit: string, tests: readonly UnstableTest[], now?: Date): string | null;
