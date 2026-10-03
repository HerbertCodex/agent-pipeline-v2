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
    /** Why the files of Claude Code could not be read (they exist but are not what is expected), or null. */
    unreadable: string | null;
    /** The hooks are turned off for every plugin (`disableAllHooks` in the settings of the account or the project). */
    hooksDisabled: boolean;
    /** The tool running this command: version and commit (null outside a checkout). */
    tool: {
        root: string;
        version: string | null;
        sha: string | null;
    };
    /** Merge rules the running tool applies that the installed plugin does not know (its hooks may not satisfy them). */
    unknownToPlugin: CatalogRule[];
    /**
     * The installed plugin is older than the running tool in what it runs (hooks, agents, skills): its commit differs and
     * those files changed since, or it cannot be compared (installed from a commit this checkout does not have).
     */
    pluginBehind: 'changed' | 'unknown' | null;
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
/** Parses a catalog; null when it is not one. Ids and needs that are not plain names are left out; texts are cleaned. */
export declare function parseCatalog(text: string | null): Catalog | null;
/** Compares two versions `x.y.z[-tag.n]`: negative, zero or positive. A version without tag comes after its tags. */
export declare function compareVersions(a: string, b: string): number;
/** The rules of `next` that `known` does not have: by id when `known` has a catalog, else by the version they come with. */
export declare function newRules(next: Catalog | null, known: Catalog | null, knownVersion: string | null): CatalogRule[];
/** The folder of the configuration of Claude Code: CLAUDE_CONFIG_DIR, else `.claude` in the HOME of the environment. */
export declare function claudeDir(env: NodeJS.ProcessEnv): string;
/**
 * The install of the plugin for this account, or null: an entry `apv@<marketplace>` of installed_plugins.json for the
 * account (scope user) or for this project (its projectPath), the enabled one first. Enabled when a settings file says so
 * (`claude plugin install` writes it; the last file wins); absent: off. Throws when the file exists but cannot be read.
 */
export declare function pluginInstall(dir: string, repo?: string | null): PluginInstall | null;
/** The folder of a marketplace added from a directory (`claude plugin marketplace add <dossier>`), or null. */
export declare function marketplaceDir(dir: string, key: string): string | null;
export declare function pluginStatus(repo: string, env: NodeJS.ProcessEnv, toolRoot?: string): PluginStatus;
/** The lines of `apv status` on the plugin: always one, and the warnings that need the operator. */
export declare function pluginLines(s: PluginStatus): string[];
