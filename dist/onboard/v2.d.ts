/**
 * What APV3 reads from a V2 `pipeline.v2.json` (spec, section 14): gates, risk, validation rules, skills and
 * the passed environment. Everything else (agents, budgets, delays, model profiles, tuning) belonged to the
 * removed controller and is listed as ignored, never copied.
 */
export declare const V2_KEPT_SECTIONS: readonly ["gates", "risk", "validationRules", "skills"];
export declare const V2_KEPT: readonly ["gates", "risk", "validationRules", "skills", "environment.passEnv"];
export interface V2ConfigImport {
    file: string;
    /** The `.apv/config.json` document: the project name, then the kept sections exactly as V2 wrote them. */
    config: Record<string, unknown>;
    kept: string[];
    ignored: string[];
    gates: string[];
}
/** Picks the kept sections of a V2 configuration and validates them as a V3 configuration; refuses with every problem. */
export declare function importV2Config(repo: string, name: string): V2ConfigImport;
export interface V2LedgerImport {
    file: string;
    /** The V2 file byte for byte: the V3 ledger has the same format (same schema, same `apv ledger validate`). */
    text: string;
    markdown: string;
    decisions: number;
    hash: string;
}
/** Reads the V2 ledger; a file `apv ledger validate` would refuse is refused with every problem, never converted. */
export declare function importV2Ledger(repo: string): V2LedgerImport;
/**
 * V2 keeps its specs in its state database, outside the repository. Spec files a project kept (the `--file`
 * proposals of `apv2 spec draft`) are looked for in these folders, and in the folder given by `--specs`.
 */
export declare const V2_SPEC_DIRS: readonly [".agent-pipeline/specs", "specs", "docs/specs"];
export declare const MAX_SPEC_BYTES: number;
export interface SpecCandidate {
    /** Path shown to the operator: relative to the repository when inside it. */
    file: string;
    path: string;
    id: string;
    /** Operator request kept next to the spec (`<id>-request.txt`), or null. */
    requestFile: string | null;
    /** Document to write in `.apv/specs/<id>.json`, or null when the file is refused before validation. */
    content: string | null;
    document: unknown;
    reasons: string[];
}
/** Kebab-case id of a spec file: its name without `.json` nor the `-import` suffix of V2 proposals. */
export declare function specIdOf(fileName: string): string;
/** Spec files of the folders: JSON files only, read and paired with their request; nothing is validated here. */
export declare function findSpecCandidates(repo: string, dirs: string[]): SpecCandidate[];
/** Files of `.agent-pipeline/` that APV3 does not take over (roles, skills, architecture notes): the plugin provides them. */
export declare function v2FilesNotImported(repo: string): string[];
export declare const specFileName: (id: string) => string;
