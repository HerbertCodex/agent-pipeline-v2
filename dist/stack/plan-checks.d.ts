import type { LotGit } from './batch.js';
/**
 * What `apv stack plan` reads in the code of a stack, before any suite (lessons of the evening of 2 October 2026):
 * - the test files each stage adds or modifies for each check that repeats them (`repeatChanged`): the suite of the top of
 *   a stack repeats all of them, and over `repeatChanged.maxFiles` it is refused before it starts. Each stage counts from
 *   the target to the head of its pull request; the stages over the ceiling are named, with the cut that keeps every
 *   part under it (prove and merge the first part, then the next one from the new target);
 * - a pull request that changes the configuration the reuse check watches (sections `reuse`, `map`, `design.dir`, the
 *   checks that judge the reuse, the mandatory checks): `apv reuse check` refuses it mixed with code, so in a stack it
 *   is merged alone first.
 * Nothing is changed: the target and the heads are fetched (`git fetch`), never checked out.
 */
export interface StageCount {
    gate: string;
    files: number;
    max: number;
}
export interface StageTests {
    pr: number;
    head: string;
    counts: StageCount[];
    over: boolean;
}
export interface StackChecks {
    /** False when the code could not be read (no checkout, fetch failed): `error` says why, nothing else is filled. */
    read: boolean;
    error: string | null;
    /** The checks that repeat their changed tests, with their ceiling, from the configuration of the target. */
    gates: {
        id: string;
        max: number;
    }[];
    /** Each stage of the stack, counted from the target to the head of its pull request. */
    stages: StageTests[];
    /** The parts of the stack, in order, that each stay under every ceiling (one part: nothing to cut). */
    parts: number[][];
    /** Pull requests that are over a ceiling on their own: to split, no cut of the stack helps. */
    alone: {
        pr: number;
        gate: string;
        files: number;
        max: number;
    }[];
    /** Pull requests that change the configuration watched by the reuse check, with what they change. */
    reuseConfig: {
        pr: number;
        changes: string[];
    }[];
}
export interface StackChecksInput {
    repo: string;
    git: LotGit;
    remote: string;
    target: string;
    prs: {
        number: number;
        head: string;
    }[];
    signal?: AbortSignal;
}
export declare function stackChecks(input: StackChecksInput): Promise<StackChecks>;
/** Lines of the report of `apv stack plan` about the code of the stack. */
export declare function stackChecksLines(checks: StackChecks, stackSize: number): string[];
