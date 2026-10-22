import type { ApvConfig } from '../config/load.js';
/** The directory of the fresh copy of `tree` (40 or 64 hexadecimal characters): `<common>/apv/fresh/<16 first>`. */
export declare const freshCopyDir: (common: string, tree: string, slot?: string) => string;
/**
 * Removes the copies left in `<common>/apv/fresh` by an earlier pass (a removal that failed, a pass killed), locked ones included,
 * at the start of `apv release auto`. A copy whose lease is held (another release at work) is left alone. Returns the removed ones.
 */
export declare function removeStaleCopies(repo: string, common: string, log?: (line: string) => void): Promise<string[]>;
/**
 * Runs `fn` in the fresh copy of `sha` (made, then removed whatever happens), or returns `busy` when another copy of the
 * same tree is in use. A directory left by an interrupted run is removed first (it is a copy, never a working tree).
 */
export declare function withFreshCopy<T>(repo: string, common: string, sha: string, fn: (dir: string) => Promise<T>, log?: (line: string) => void, slot?: string): Promise<T | {
    busy: string;
}>;
/**
 * The stacks a full suite in a fresh copy is given, as `apv gates run --stacks`: those forced, else the first declared whose
 * lock is free (a lock file held by someone else is busy); none declared: none given (`ids` undefined); all busy: `busy`,
 * with the first declared stack (the release comes back later).
 */
export declare function pickStacks(config: ApvConfig, common: string, forced: string[] | undefined): {
    ids: string[] | undefined;
} | {
    busy: string;
    first: string;
};
