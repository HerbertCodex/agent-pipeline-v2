import type { Git } from '../execution/git.js';
import type { RepeatSettings } from './repeat.js';
import { type LocalReceipts } from './reuse-proof.js';
/**
 * The credit of the repetition of the changed test files at the release (docs/UNE-SUITE-PAR-PR.md, 2.2). Each pull request
 * repeats the test files it adds or modifies in its full suite on the branch (`apv gates run --stage full --fresh-copy`); the
 * release, which counts the changed files since production (several pull requests), does not repeat them again: a file is
 * credited when a complete green receipt of the same check repeated it, green, at the same content. Only `apv release` asks
 * for it (`repeatCredits`): on a branch, every changed test file is repeated as before.
 *
 * A credit holds when, for the file, a receipt of the same check, read from the worktree or from an intact run of the shared
 * store: is `passed` at first pass, complete (never targeted, never an early check), of stage full, on a clean tree; repeated
 * the file (`repeat.status` passed, the file among `repeat.files`) at least as many times as the check asks now, with the same
 * repetition command, load arguments and test pattern (read in the configuration of its commit); and its commit has the file
 * with the same blob and mode as the commit judged. No receipt of the check, of any stage, whose repetition of the file at the
 * same blob failed, ran out of time or was cancelled: an instability once seen is never credited away. Nothing of a receipt
 * of the release is trusted: the credits are found again here, from Git and the store, by `apv release` and `verify`.
 */
export interface RepeatCredit {
    file: string;
    blob: string;
    runId: string;
    receipt: string;
    commit: string;
}
/**
 * The credits of `files` (changed test files the check would repeat at `commit`) for the check `gateId`: a map from each
 * credited file to the receipt that repeated it at the same content. A file without a credit is repeated.
 */
export declare function repeatCredits(input: {
    git: Git;
    repo: string;
    commit: string;
    gateId: string;
    settings: RepeatSettings;
    files: readonly string[];
    store: string;
    local: LocalReceipts;
}): Promise<Map<string, RepeatCredit>>;
