/**
 * The migrations a release would put online (`release.migrations`, docs/CLI.md « apv release »): the operator applies them
 * to the production database himself, then types « migration <nom ou version> appliquée » in a Claude Code session. The
 * sentence is read in the operator journal (signed by the UserPromptSubmit hook, never by an agent), as the waivers are.
 */
export interface Migrations {
    /** Added since production, not confirmed yet: nothing is released. */
    pending: string[];
    /** The sentence to type for each pending migration, in the same order. */
    toType: string[];
    /** Added since production, confirmed by the operator. */
    confirmed: string[];
    /** Changed, removed or renamed since production: a published migration never changes. */
    modified: string[];
    /** Symbolic links among the migrations at the released commit: refused, their target changes unseen. */
    links: string[];
}
/** The numeric prefix of the file name (`20261019120000_x.sql` gives `20261019120000`), or null. */
export declare const migrationVersion: (file: string) => string | null;
/** A pattern of `release.migrations` as Git paths: a leading `./` dropped (as `expandGlobs` does). */
export declare const migrationPattern: (pattern: string) => RegExp;
/** The sentence the operator types once `file` is applied in production: its shortest name no other migration has. */
export declare const confirmationSentence: (file: string, all?: readonly string[]) => string;
/**
 * The migrations matching `patterns` between `production` and `sha` (`git diff --name-status --no-renames`), the added ones
 * split by the operator's confirmation; the symbolic links among the migrations at `sha`. The tool never shows a
 * confirmation as a sentence of its own (always quoted inside a longer one), and the journal keeps hashes of whole
 * sentences, never of questions nor quotes: a refusal pasted back is no confirmation.
 */
export declare function releaseMigrations(repo: string, common: string, patterns: readonly string[], production: string, sha: string): Migrations;
/** What a release says of its migrations; empty when it has none. */
export declare function migrationLines(m: Migrations): string[];
/** Why a release waits: what to apply, then what to type (quoted, never a sentence alone). */
export declare const pendingReason: (m: Migrations) => string;
/** Why a release is refused: a migration that is a symbolic link, or a published migration changed. */
export declare function refusedReason(m: Migrations): string | null;
