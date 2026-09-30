/**
 * The gate of `apv reuse check`, added by `apv init` and `apv onboard` to a web project (task stage: it also runs in the
 * full suite). What is new is counted from `{{baseSha}}`, the base of the run, which is part of the proof key of every
 * receipt: a moved remote-tracking ref (`git update-ref`) can never turn a copy into an existing block.
 */
export declare const REUSE_GATE: {
    readonly id: "reuse";
    readonly command: readonly ["apv", "reuse", "check", "--base", "{{baseSha}}"];
    readonly covers: readonly ["architecture"];
    readonly stage: "task";
    readonly readOnly: true;
    readonly mandatory: true;
};
/**
 * The gate of the code map, added to every project: it fails when `.apv/code-map.md` no longer matches the code. Full
 * stage: tasks never commit the map (parallel tasks would conflict on it); the integration regenerates it once per wave.
 */
export declare const MAP_GATE: {
    readonly id: "code-map";
    readonly command: readonly ["apv", "map", "--check"];
    readonly covers: readonly ["architecture"];
    readonly stage: "full";
    readonly readOnly: true;
    readonly mandatory: true;
};
/** True when an executable `apv` is on the PATH: the generated checks call it by that name. */
export declare function apvOnPath(path?: string): boolean;
/** Dependencies that make a project a web interface. */
export declare const WEB_DEPENDENCIES: RegExp;
/** The `reuse` section as `apv init` and `apv onboard` write it (validated by the schema of src/reuse/config.ts). */
export interface ReuseDocument {
    reference?: string;
    shared?: string[];
    native: {
        elements: Record<string, string | null>;
        allowedPaths?: string[];
    };
    styles?: {
        allowedPaths: string[];
    };
    typography?: {
        locale: string;
    };
}
export interface ReuseProposal {
    /** A web interface: dependencies or interface files found. */
    web: boolean;
    signals: string[];
    /** The proposed `reuse` section (only what differs from the defaults, plus the shared folders and the reference). */
    section: ReuseDocument;
    shared: string[];
    primitives: string[];
    styleSources: string[];
    locale: string | null;
    reference: string | null;
}
/** The branch changes go to: `origin/HEAD`, else `origin/main` or `origin/master`; null otherwise (to configure). */
export declare function detectReference(repo: string): string | null;
/** The language of the interface texts, from the `lang` of the document (`<html lang="fr">`, `lang: 'fr'`). */
export declare function detectLocale(repo: string): string | null;
/**
 * What `apv init` and `apv onboard` propose for the reuse check: whether the project is a web interface, its shared
 * component folders (the highest folders named components, ui, shared... that hold components, outside the routes), the
 * primitives folder (`ui`, `primitives`) where native elements are allowed, the shared component that replaces each
 * reserved element, its global stylesheets, the language of its texts and the reference branch.
 */
export declare function detectReuse(repo: string, files: readonly string[]): ReuseProposal;
