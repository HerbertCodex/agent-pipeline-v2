import type { ApvConfig } from '../config/load.js';
/** The directory of the fresh copy of `tree` (40 or 64 hexadecimal characters): `<common>/apv/fresh/<16 first>`. */
export declare const freshCopyDir: (common: string, tree: string) => string;
/**
 * Runs `fn` in the fresh copy of `sha` (made, then removed whatever happens), or returns `busy` when another copy of the
 * same tree is in use. A directory left by an interrupted run is removed first (it is a copy, never a working tree).
 */
export declare function withFreshCopy<T>(repo: string, common: string, sha: string, fn: (dir: string) => Promise<T>, log?: (line: string) => void): Promise<T | {
    busy: string;
}>;
/**
 * The stacks a full suite in a fresh copy is given, as `apv gates run --stacks`: those forced, else the first declared whose
 * lock is free (a lock file held by someone else is busy); none declared: none given (`ids` undefined); all busy: `busy`,
 * with the first declared stack (a suite on the branch waits for its lock, the release comes back later).
 */
export declare function pickStacks(config: ApvConfig, common: string, forced: string[] | undefined): {
    ids: string[] | undefined;
} | {
    busy: string;
    first: string;
};
