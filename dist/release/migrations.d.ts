/**
 * The migrations a release would put online (`release.migrations`, docs/CLI.md « apv release »): the operator applies them
 * to the production database himself, then types « migration <nom ou version> appliquée » in a Claude Code session. The
 * sentence is read in the operator journal (signed by the UserPromptSubmit hook, never by an agent), as the waivers are.
 */
export interface Migrations {
    /** Added since production, not confirmed yet: nothing is released. */
    pending: string[];
    /** Added since production, confirmed by the operator. */
    confirmed: string[];
    /** Changed, removed or renamed since production: a published migration never changes. */
    modified: string[];
}
/** The numeric prefix of the file name (`20261019120000_x.sql` gives `20261019120000`), or null. */
export declare const migrationVersion: (file: string) => string | null;
/** The sentence the operator types once `file` is applied in production (the version when the name has one). */
export declare const confirmationSentence: (file: string) => string;
/**
 * The migrations matching `patterns` between `production` and `sha` (`git diff --name-status --no-renames`), the added ones
 * split by the operator's confirmation. The tool never shows a confirmation as a sentence of its own (always quoted inside a
 * longer one), so a refusal pasted back is no confirmation: the journal keeps hashes of whole sentences.
 */
export declare function releaseMigrations(repo: string, common: string, patterns: readonly string[], production: string, sha: string): Migrations;
/** What a release says of its migrations; empty when it has none. */
export declare function migrationLines(m: Migrations): string[];
/** Why a release waits: what to apply, then what to type (quoted, never a sentence alone). */
export declare const pendingReason: (pending: readonly string[]) => string;
export declare const modifiedReason: (modified: readonly string[]) => string;
