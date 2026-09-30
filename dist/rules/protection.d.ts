import type { GhRunner } from '../stack/github.js';
/**
 * Whether GitHub protects the default branch: a PR required before merging, no force-push, administrators included. It
 * is the only barrier outside the machine (docs/REGLES.md, « Ce que l'outil garantit »). Never a refusal: `apv status`,
 * `apv rules check` and `apv stack merge` say it once. A private repository on the free plan has neither branch
 * protection nor rulesets: then the guards of the plugin and the merge audit (`apv audit merges`) stand in for it.
 */
export type ProtectionState = 'ok' | 'weak' | 'absent' | 'unavailable' | 'unknown';
export interface Protection {
    state: ProtectionState;
    repository: string | null;
    branch: string | null;
    missing: string[];
    message: string;
}
/** The repository `owner/name` of the `origin` remote when it is on github.com, else null. */
export declare function githubRepository(repo: string): string | null;
export declare function branchProtection(repo: string, gh: GhRunner): Promise<Protection>;
