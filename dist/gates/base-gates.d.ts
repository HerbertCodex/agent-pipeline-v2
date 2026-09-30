import { type ApvConfig } from '../config/load.js';
/**
 * The checks of the base (docs/CLI.md, « Contrôles de la base »). A candidate commit carries its
 * own `.apv/config.json`: read alone, it could drop or loosen the checks that prove it. `apv gates run` and
 * `apv gates verify` therefore read the checks of the base (the merge base of the reference and the commit) and keep
 * EVERY one of them, mandatory or not, with its base definition: removed, made optional or changed by the candidate, it
 * is still run as the base defined it, and the difference is said. The candidate can only add checks or harden them (a
 * new check, a check made mandatory, nothing else changed). A change of these checks goes through a pull request of configuration alone, proven by the
 * checks of its base, then merged by the operator.
 */
export type GateDifferenceKind = 'removed' | 'optional' | 'changed' | 'dependency';
export interface GateDifference {
    id: string;
    kind: GateDifferenceKind;
}
export interface BaseGates {
    /** The reference read (`--against`, `--base`, else the default branch of the remote), or null when none resolves. */
    reference: string | null;
    /** The merge base of the reference and the commit, whose configuration was read; null without reference. */
    mergeBase: string | null;
    /** `<sha>:.apv/config.json` read at the merge base, or null when the base has none (nothing to keep). */
    file: string | null;
    differences: GateDifference[];
    /** What could not be verified about the reference (the remote could not be read, a local ref behind it). */
    warnings: string[];
}
/** The checks of `candidate` with every mandatory check of `base` kept in its base definition (and what it depends on). */
export declare function enforceBaseGates(candidate: ApvConfig, base: ApvConfig): {
    config: ApvConfig;
    differences: GateDifference[];
};
/**
 * Reads the checks of the base of `head` and keeps its mandatory ones. The reference is `reference` when given, else
 * the default branch of the remote (`origin/HEAD`, `origin/main`, `origin/master`); without one, or when the base has no
 * configuration of its own, the candidate's checks are used as they are (`file` null).
 */
export declare function applyBaseGates(repo: string, candidate: ApvConfig, head: string, reference: string | null, options?: RemoteCheck): {
    config: ApvConfig;
    base: BaseGates;
};
export interface RemoteCheck {
    /** Reads the commit a remote branch points to (`git ls-remote`), null when the remote cannot be read. Tests inject it. */
    lsRemote?: (repo: string, remote: string, branch: string) => string | null;
    /**
     * `gates verify`: a reference behind the remote is refused (a base moved back on purpose would otherwise be accepted);
     * `gates run` only warns.
     */
    strict?: boolean;
}
/** Lines for the text output: the warnings on the reference, and the checks kept, if any. */
export declare function baseGatesLines(base: BaseGates): string[];
/** One line for the text output, or none when the candidate keeps every check of its base. */
export declare function baseGatesLine(base: BaseGates): string | null;
