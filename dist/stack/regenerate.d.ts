import { type DecisionLedger } from '../lifecycle/decisions.js';
import type { LotGit } from './batch.js';
/**
 * The files APV itself generates and that two pull requests of a batch may both have changed (decision D1 of the pilot
 * project, 3 October 2026: each implementer regenerates and commits the code map in his commit): the code map (`map.file`),
 * the decision ledger (`.apv/DECISIONS.json`, or its V2 place) and its readable version (`.apv/DECISIONS.md`). A merge
 * of the batch that stops on them is not a conflict of the code: the files are regenerated from the merged tree (the
 * ledger by the union of its decisions, the map by `apv map`), never resolved by hand (docs/REUSE.md). Anything else in
 * conflict keeps the pull request out of the batch.
 */
/** The generated files of a copy at `dir`, from its configuration (unreadable: the default map file). */
export declare function generatedFiles(dir: string): {
    map: string;
    ledger: string;
    ledgerMarkdown: string;
};
/**
 * The union of two ledgers that diverged from `base` (null when the file is new on both sides), symmetric (the result is
 * the same whichever side is « ours »): a decision kept by both is kept in the order of the base, a decision changed on
 * one side only takes that change, a decision deleted on one side and untouched on the other goes, a decision added on
 * one side (or identically on both) is appended, added decisions sorted by id. A decision changed, or added differently,
 * on both sides is a real conflict: nothing is merged.
 */
export declare function mergeLedgers(base: DecisionLedger | null, ours: DecisionLedger, theirs: DecisionLedger): {
    ledger: DecisionLedger;
} | {
    conflict: string;
};
export type Regenerated = {
    ok: true;
    files: string[];
} | {
    ok: false;
    reason: string;
};
/**
 * Resolves a merge of `dir` stopped on `conflicted` paths when every one of them is a generated file: the ledger by the
 * union of its decisions (stages 1, 2 and 3 of the index), its Markdown from the merged ledger, the code map (and the
 * generated parts of the architecture map) by `apv map` on the merged tree. The files written are returned, to be added
 * and committed by the caller; a conflict on any other file, or a real conflict of the ledger, resolves nothing.
 */
export declare function resolveGeneratedConflicts(git: LotGit, dir: string, conflicted: readonly string[]): Promise<Regenerated>;
/**
 * After a merge without conflict: the code map (and the generated parts of the architecture map) of `dir`, regenerated
 * when stale (two pull requests whose maps merged textually but no longer describe the merged code). The files written;
 * empty when up to date, or when the project has no map (nothing is created here).
 */
export declare function regenerateStaleMap(dir: string): Promise<Regenerated>;
