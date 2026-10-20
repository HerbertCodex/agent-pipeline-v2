/** A gate read from a project file, proposed with `mandatory: false` until the operator reviews it. */
export interface DetectedGate {
    id: string;
    command: string[];
    source: string;
    note: string;
}
/**
 * Gates a project already declares through its own files: package.json scripts, Makefile targets, tools
 * configured in pyproject.toml. Only commands the project has; nothing is invented. First source wins per id.
 */
export declare function detectGates(repo: string): DetectedGate[];
/**
 * Hints of an existing preview (package.json scripts and files of `scripts/` named preview or aperçu). They are
 * shown, never turned into a `preview` section: its build, migrations and seed are the operator's to describe.
 */
export declare function previewHints(repo: string): string[];
