import { type ReuseDocument, type ReuseProposal } from '../reuse/detect.js';
import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv init [--name <nom>] [--repo <chemin>] [--json]\n\nCr\u00E9e ce qui manque dans .apv/ sans jamais \u00E9craser un fichier existant (la commande peut \u00EAtre relanc\u00E9e) :\nconfig.json (nom du projet, contr\u00F4les vides), DECISIONS.json (registre vide), brief.md (consigne commune\ndes implementers, depuis le mod\u00E8le de la comp\u00E9tence chef-de-projet), specs/, state/ et .gitignore\n(fichiers machine) et la carte du code (.apv/code-map.md, comme apv map). La configuration cr\u00E9\u00E9e d\u00E9clare les\ncontr\u00F4les code-map (apv map --check) et, pour un projet web, reuse (apv reuse check) avec la section reuse\nd\u00E9tect\u00E9e (dossiers partag\u00E9s, composant qui remplace chaque \u00E9l\u00E9ment natif r\u00E9serv\u00E9, langue, branche de r\u00E9f\u00E9rence)\net structure (apv structure check) : les contr\u00F4les qu'exigent les r\u00E8gles avant fusion (docs/REGLES.md). Une\nconfiguration existante n'est jamais modifi\u00E9e : les contr\u00F4les requis qui lui manquent sont list\u00E9s.\nSi la configuration d\u00E9clare le dossier des maquettes valid\u00E9es (design.dir) ou si ce\ndossier existe, ajoute \u00E0 .gitattributes \u00AB <dossier>/*.html -whitespace \u00BB quand Git ne l'applique pas d\u00E9j\u00E0. Liste ce qui est cr\u00E9\u00E9 et ce qui existait d\u00E9j\u00E0. Refuse hors d'un d\u00E9p\u00F4t Git.\nLe nom du projet est --name, sinon le nom du dossier du d\u00E9p\u00F4t.\nSortie : 0 succ\u00E8s, 1 hors d'un d\u00E9p\u00F4t Git ou mod\u00E8le de consigne introuvable, 2 appel incorrect.";
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
    reuse: ReuseSetup;
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
    /** The code map (`.apv/code-map.md`), written last when it does not exist. */
    map?: {
        path: string;
        content: () => string;
    };
}
/** Writes the `.apv/` skeleton in a fixed order: directory, configuration, ledger, brief, specs, state, .gitignore. */
export declare function writeApvSkeleton(writer: ApvWriter, name: string, template: string, content?: InitContent): void;
/** What `apv init` and `apv onboard` set up for the reuse of the existing components (docs/REUSE.md). */
export interface ReuseSetup {
    /** Web interface detected, and why. */
    web: boolean;
    signals: string[];
    /** Gates added to the created configuration (`reuse` for a web project, `structure` and `code-map` always); empty when it existed. */
    gates: string[];
    /** The `reuse` section written, or null. */
    section: ReuseDocument | null;
    /** Code map: its path, or null when the configuration is unreadable or the map could not be built (then `apv map`). */
    map: string | null;
    /** Why the map was not written, or that it is partial (repository beyond the inventory limit). */
    mapNote: string | null;
    /** The generated checks call `apv` by name: false when it is not on the PATH of this machine. */
    apvOnPath: boolean;
    /** Architecture map: its path when created (or to be created), null when it existed; why it could not be written. */
    architecture?: {
        file: string;
        status: 'created' | 'existing' | 'failed';
        note: string | null;
    };
    /** Checks the rules before a merge require (rule `controles`) that an existing configuration lacks, or declares optional. */
    missingRequired: string[];
}
/** The required checks an existing configuration lacks (rule `controles` of `apv rules check`); empty when unreadable or absent. */
export declare function missingRequired(repo: string, web: boolean): string[];
/**
 * The configuration of a new project: its name, the checks of the reuse (`reuse` for a web project, `code-map`
 * always, both at the task stage so that they also run in the full suite) and the detected `reuse` section.
 */
export declare function reuseConfig(name: string, proposal: ReuseProposal): {
    document: Record<string, unknown>;
    gates: string[];
};
/** The code map of the repository under `config` (the one about to be written, or the existing one); null when unreadable. */
export declare function initialMap(repo: string, configText: string | undefined): Promise<{
    path: string | null;
    text: string;
    partial: boolean;
    error?: string;
    crowded?: {
        folder: string;
        code: number;
        groups: string[];
    }[];
} | null>;
export declare function initProject(repo: string, name: string, pluginRoot?: string): Promise<InitResult>;
/**
 * The architecture map (docs/STRUCTURE.md), written when it does not exist, never touched when it does: generated parts
 * filled, written parts as drafts to complete with the operator. With a dry run, only said. Never blocks the setup.
 */
export declare function initialArchitecture(repo: string, writer: ApvWriter): Promise<NonNullable<ReuseSetup['architecture']>>;
/** The map fields of the setup, from what `initialMap` returned. */
export declare function mapFields(map: Awaited<ReturnType<typeof initialMap>>): Pick<ReuseSetup, 'map' | 'mapNote' | 'apvOnPath'>;
/** Lines of the reuse setup for the text output of `apv init` and `apv onboard`. */
export declare function reuseLines(reuse: ReuseSetup): string[];
export declare function run(args: string[], io: CommandIO): Promise<number>;
