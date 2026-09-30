/**
 * Split of a flat folder by proximity of use (docs/STRUCTURE.md, « Découpage d'un dossier à plat »). Deterministic and
 * explainable:
 * 1. the core of the folder (files a large part of it imports, or its model by convention) stays at its root;
 * 2. every other file is described by who uses it (the folders and routes of its importers), the files of the folder it
 *    is linked to by an import, and the words of its name and exports;
 * 3. the subfolders that already exist, in the folder or in a folder of the same domain elsewhere (`components/<domaine>/`
 *    for `lib/<domaine>/`), are described the same way and attract the files used like them (same split everywhere);
 * 4. files are grouped by similarity of those descriptions (weighted cosine, average linkage, most similar pair first);
 * 5. each group is named after the vocabulary the project already uses (existing or mirrored subfolder, its main module,
 *    a word its files share, the folder or route that uses it), and says why.
 * Nothing reads a file here: the import graph comes from the code map (src/knowledge/code-map.ts).
 */
/** Who imports whom, tests left out, and what each module exports. */
export interface UsageGraph {
    /** File -> files that import it. */
    importers: ReadonlyMap<string, readonly string[]>;
    /** File -> names it exports. */
    exports: ReadonlyMap<string, readonly string[]>;
}
/** A file of the folder with its companions and tests (they move with it). */
export interface SplitEntry {
    path: string;
    stem: string;
    files: readonly string[];
    component: boolean;
    tokens: readonly string[];
}
export interface SplitGroup {
    /** Subfolder name, relative to the folder. */
    dir: string;
    /** Main files, repository-relative. */
    members: string[];
    /** The subfolder already exists: the files join it. */
    existing: boolean;
    /** Why these files go together, in French, one sentence each. */
    reasons: string[];
    /** Conventions of the stack profile the group follows (ids of src/structure/profiles.ts). */
    conventions: string[];
    /** Where the name comes from: an existing subfolder, the same split elsewhere, the main module or component, a shared word, a declared domain, the folder or route that uses the group. */
    naming: 'existing' | 'mirror' | 'module' | 'component' | 'word' | 'domain' | 'place';
}
export interface SplitResult {
    /** Files that stay at the root of the folder: its core (imported by much of it) or its model by convention. */
    core: {
        path: string;
        reason: string;
    }[];
    groups: SplitGroup[];
    /** Files no group takes: left to the operator. */
    unplaced: string[];
}
export interface SplitContext {
    /** Every directory of the project (the vocabulary of existing folders). */
    dirs: ReadonlySet<string>;
    /** Every code file of the project: the existing subfolders are described by their files. */
    files: readonly string[];
    domains: readonly string[];
    maxFlatFiles: number;
    /** Entries of the folder that are not split (reserved, already placed by another rule): they count for the core. */
    others?: readonly SplitEntry[];
    /** Entries of the folder outside the split that stay at its root (entry points): they count against the threshold. */
    staying?: number;
    /** Groups already proposed for other flat folders (folder -> groups): a folder of the same domain follows the same split. */
    proposed?: ReadonlyMap<string, readonly {
        dir: string;
        members: readonly string[];
    }[]>;
}
/**
 * Proposes subfolders for the entries of `folder`. Pure and deterministic: the same entries and graph give the same
 * groups, in the same order, with the same names.
 */
export declare function proposeSplit(folder: string, entries: readonly SplitEntry[], graph: UsageGraph, context: SplitContext): SplitResult;
/** The usage graph of a code map: who imports each component and module, and what the modules export. */
export declare function usageFromMap(map: {
    components: readonly {
        path: string;
        usedBy: readonly string[];
    }[];
    modules: readonly {
        path: string;
        usedBy: readonly string[];
        exports: readonly {
            name: string;
        }[];
    }[];
}): UsageGraph;
