/**
 * What `apv status` says of the plugin (projet pilote, 3 octobre 2026) : a project under APV whose plugin is not loaded
 * in Claude Code runs without its hooks (no seal, no journal, no guard) and nothing said it for days; and an update of the
 * tool brought merge rules that the installed plugin could not satisfy (`apv rules check` refused every merge in the
 * night). Both are said here, with the commands to run, before they block.
 */
/** A merge rule of the catalog `docs/merge-rules.json`: its id, the version that brings it, what it needs. */
export interface CatalogRule {
    id: string;
    since: string;
    needs: string[];
    summary: string;
}
export interface Catalog {
    needs: Record<string, string>;
    rules: CatalogRule[];
}
/** The plugin as Claude Code installed it for this account: `~/.claude/plugins/installed_plugins.json` and `settings.json`. */
export interface PluginInstall {
    key: string;
    version: string | null;
    sha: string | null;
    installPath: string | null;
    enabled: boolean;
}
export interface PluginStatus {
    /** The project is under APV (`.apv/` or a configuration). */
    project: boolean;
    /** The install of the plugin, null when Claude Code knows none. */
    install: PluginInstall | null;
    /** The tool running this command: version and commit (null outside a checkout). */
    tool: {
        root: string;
        version: string | null;
        sha: string | null;
    };
    /** Merge rules the running tool applies that the installed plugin does not know (its hooks may not satisfy them). */
    unknownToPlugin: CatalogRule[];
    /** Merge rules of the next version of the tool (the upstream branch of its checkout, as last fetched), not in this one. */
    upcoming: {
        ref: string;
        behind: number;
        rules: CatalogRule[];
    } | null;
    needs: Record<string, string>;
}
/** The root of the running tool: `dist/rules/plugin-status.js`, two folders up. */
export declare const TOOL_ROOT: string;
/** Parses a catalog; null when it is not one. */
export declare function parseCatalog(text: string | null): Catalog | null;
/** Compares two versions `x.y.z[-tag.n]`: negative, zero or positive. A version without tag comes after its tags. */
export declare function compareVersions(a: string, b: string): number;
/** The rules of `next` that `known` does not have: by id when `known` has a catalog, else by the version they come with. */
export declare function newRules(next: Catalog | null, known: Catalog | null, knownVersion: string | null): CatalogRule[];
/** The folder of the configuration of Claude Code: CLAUDE_CONFIG_DIR, else ~/.claude. */
export declare function claudeDir(env: NodeJS.ProcessEnv): string;
/**
 * The install of the plugin for this account, or null: the entry `apv@<marketplace>` of installed_plugins.json, enabled
 * when the settings of the account (then those of the project, which take precedence) do not turn it off.
 */
export declare function pluginInstall(dir: string, repo?: string | null): PluginInstall | null;
/** The folder of a marketplace added from a directory (`claude plugin marketplace add <dossier>`), or null. */
export declare function marketplaceDir(dir: string, key: string): string | null;
export declare function pluginStatus(repo: string, env: NodeJS.ProcessEnv, toolRoot?: string): PluginStatus;
/** The lines of `apv status` on the plugin: always one, and the warnings that need the operator. */
export declare function pluginLines(s: PluginStatus): string[];
