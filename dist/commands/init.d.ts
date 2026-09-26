import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv init [--name <nom>] [--repo <chemin>] [--json]\n\nCr\u00E9e ce qui manque dans .apv/ sans jamais \u00E9craser un fichier existant (la commande peut \u00EAtre relanc\u00E9e) :\nconfig.json (nom du projet, contr\u00F4les vides), DECISIONS.json (registre vide), brief.md (consigne commune\ndes implementers, depuis le mod\u00E8le de la comp\u00E9tence chef-de-projet), specs/, state/ et .gitignore\n(fichiers machine). Si la configuration d\u00E9clare le dossier des maquettes valid\u00E9es (design.dir) ou si ce\ndossier existe, ajoute \u00E0 .gitattributes \u00AB <dossier>/*.html -whitespace \u00BB quand Git ne l'applique pas d\u00E9j\u00E0. Liste ce qui est cr\u00E9\u00E9 et ce qui existait d\u00E9j\u00E0. Refuse hors d'un d\u00E9p\u00F4t Git.\nLe nom du projet est --name, sinon le nom du dossier du d\u00E9p\u00F4t.\nSortie : 0 succ\u00E8s, 1 hors d'un d\u00E9p\u00F4t Git ou mod\u00E8le de consigne introuvable, 2 appel incorrect.";
/** Root of the plugin, resolved from the compiled tool (`dist/commands/init.js`). */
export declare const PLUGIN_ROOT: string;
export declare const BRIEF_TEMPLATE = "skills/chef-de-projet/references/brief-type.md";
/** The brief model is the fenced `markdown` block of the reference; the whole file when it has none. */
export declare function briefFromTemplate(template: string, name: string): string;
export interface InitResult {
    repo: string;
    name: string;
    created: string[];
    existing: string[];
    completed: string[];
}
/** Reads the brief model shipped with the plugin; refused before anything is written. */
export declare function readBriefTemplate(pluginRoot?: string): string;
/**
 * Creates what `.apv/` lacks, never replacing an existing file, and records what it did. With `dryRun`, the
 * same decisions are taken and recorded, but nothing is written. Shared by `apv init` and `apv onboard`.
 */
export declare class ApvWriter {
    readonly repo: string;
    readonly dryRun: boolean;
    readonly created: string[];
    readonly existing: string[];
    readonly completed: string[];
    constructor(repo: string, dryRun?: boolean);
    dir(path: string): void;
    /** Writes `content()` unless the file exists; returns true when the file is (or would be) created. */
    file(path: string, content: () => string): boolean;
    /**
     * The `.gitattributes` line of the validated mockups, when the configuration declares their folder (`design.dir`)
     * or the folder exists: registered under their sha256, they must stay out of `git diff --check`. An unreadable
     * configuration is left to `apv status` and the other commands: nothing is written then.
     */
    designAttributes(): void;
    gitignore(): void;
}
export interface InitContent {
    /** Content of `.apv/config.json` when it is created; by default the name and no gate. */
    config?: () => string;
    /** Files written right after the configuration (the ledger and its readable version); by default an empty ledger. */
    ledger?: {
        path: string;
        content: () => string;
    }[];
}
/** Writes the `.apv/` skeleton in a fixed order: directory, configuration, ledger, brief, specs, state, .gitignore. */
export declare function writeApvSkeleton(writer: ApvWriter, name: string, template: string, content?: InitContent): void;
export declare function initProject(repo: string, name: string, pluginRoot?: string): InitResult;
export declare function run(args: string[], io: CommandIO): Promise<number>;
