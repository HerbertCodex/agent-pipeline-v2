import type { OrderStep } from './order.js';
/** True when `path` is on the fixed refusal list of APV, compared without case (a checkout on a case-insensitive disk). */
export declare function refusedPath(path: string): boolean;
/** Paths of the refusal list a declared glob must never cover (checked by the loader). */
export declare const REFUSED_PROBES: string[];
export declare const SLUG: RegExp;
/** A slug used in the probes of the loader: any slug the order may sign is replaced the same way. */
export declare const PROBE_SLUG = "exemple";
/** The globs of a step with `{slug}` replaced; null when a glob names `{slug}` and the order signed no readable slug. */
export declare function stepGlobs(globs: readonly string[], slug: unknown): string[] | null;
/** The changed paths a step may not merge: refused by APV, or outside the allow list. */
export declare function forbiddenPaths(changed: readonly string[], allowed: readonly string[]): {
    refused: string[];
    outside: string[];
};
export type StepPaths = Record<OrderStep, string[]>;
/** One entry of `git diff --raw -z --no-renames --no-abbrev`: the new mode, the new blob, the status letter and the path. */
export interface RawEntry {
    mode: string;
    blob: string;
    status: string;
    path: string;
}
/** The entries of a raw diff read with NUL separators; null when the output is not one. */
export declare function rawDiff(output: string): RawEntry[] | null;
