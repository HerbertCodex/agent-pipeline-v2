/** Whether `rel` is a repository-relative path that stays inside the repository, lexically. */
export declare function lexicallyInside(rel: string): boolean;
/**
 * The first component of `rel`, from the repository down to the file itself, that is a symbolic link, as a
 * repository-relative path; null when none is. The walk stops at the first missing component (what does not exist
 * yet is created as a real folder or file). A path that leaves the repository lexically counts as linked (`rel`).
 */
export declare function linkedComponent(repo: string, rel: string): string | null;
/** Refuses (`DESIGN_LINK`) a path of the repository that goes through a symbolic link: the write could land outside. */
export declare function assertNoLink(repo: string, rel: string, what: string): void;
/** After creating it: the real path of the folder `relDir` must be exactly the folder of the repository (`DESIGN_LINK`). */
export declare function assertRealFolder(repo: string, relDir: string): void;
/** Real path of `rel` when it exists and its real path is inside the real repository; null otherwise. */
export declare function realInside(repo: string, rel: string): string | null;
