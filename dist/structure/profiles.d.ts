/**
 * Tree conventions of the common stacks (docs/STRUCTURE.md, « Profils »). The split of a flat folder, the architecture map
 * and the messages of `apv structure check` cite them: a proposal follows a convention a developer of the stack already
 * knows, never a layout invented by the tool. Each convention links to the official documentation of its stack.
 */
/** A convention: a short name, what it says, and where the stack documents it. */
export interface Convention {
    id: string;
    label: string;
    rule: string;
    url: string;
}
/** A folder or file the stack knows by name, with its role. `*` matches one path segment. */
export interface KnownPath {
    path: string;
    role: string;
    convention: string;
}
export interface StackProfile {
    id: string;
    label: string;
    /** Folders whose subfolders the architecture map describes (levels 1 and 2 below them), besides the repository root. */
    anchors: string[];
    /** Folders of file-based routes: their subfolders are URL segments, described as routes, never split. */
    routeRoots: string[];
    /** Folders of components: the generic ones (`ui`) apart from the feature ones. */
    componentRoots: string[];
    conventions: Convention[];
    known: KnownPath[];
    /** Entry points: globs of files the framework calls by name (hooks, layouts, middleware). */
    entries: KnownPath[];
}
/** Folders and files every project may have, whatever its stack: migrations, scheduled tasks, CI. */
export declare const COMMON_KNOWN: KnownPath[];
export declare const PROFILES: readonly StackProfile[];
/** A profile by id; the generic one for an unknown id. */
export declare function profileById(id: string): StackProfile;
/** The stack of the repository, from its dependencies and marker files; `generic` when none is recognised. */
export declare function detectProfile(repo: string, files?: readonly string[]): StackProfile;
/** The convention of an id, in this profile (or the common folders); null when unknown. */
export declare function conventionOf(profile: StackProfile, id: string): Convention | null;
/** `*` matches one path segment (never a `/`). */
export declare function segmentGlob(pattern: string): RegExp;
/** The known path (folder or file) that describes `path`, or null. */
export declare function knownPath(profile: StackProfile, path: string, list?: readonly KnownPath[]): KnownPath | null;
