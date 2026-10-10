import { type Infer } from '../domain/schema.js';
/**
 * The rules the tool enforces before a merge (`apv rules check`, `apv stack merge`, `apv stack batch --merge`), docs/REGLES.md.
 * Every rule applies to every project: none can be switched off by the configuration. The only way past a refusal is
 * the correction it asks for, or a waiver the operator writes himself (src/rules/operator.ts).
 */
export declare const MERGE_RULES: readonly ["preuve", "instable", "relecture", "captures", "controles", "maquette"];
export type MergeRule = typeof MERGE_RULES[number];
/** What each rule protects, in a few words (texts of the refusals and of docs/REGLES.md). */
export declare const RULE_TITLES: Readonly<Record<MergeRule, string>>;
export declare const CAPTURE_VIEWPORTS: readonly ["desktop", "phone", "tablet"];
export type CaptureViewport = typeof CAPTURE_VIEWPORTS[number];
export declare const CAPTURE_THEMES: readonly ["light", "dark"];
export type CaptureTheme = typeof CAPTURE_THEMES[number];
/** Captures required by default for a change of interface: computer and phone, light and dark theme. */
export declare const DEFAULT_CAPTURE_VIEWPORTS: readonly CaptureViewport[];
export declare const DEFAULT_CAPTURE_THEMES: readonly CaptureTheme[];
/**
 * Kinds of files of the lane without code (`voie sans code`, src/rules/docs-only.ts): a closed list, fixed by the tool. A
 * project can only narrow it (`rules.docsOnly.kinds`, `exclude`) or switch the lane off (`enabled: false`): never widen it.
 * `.apv/state/**` is not a kind: the session hook injects it into the context of every session (`resume.md`, the runs),
 * so it is read as instructions (security review of PR #121).
 */
export declare const DOCS_ONLY_KINDS: readonly ["decisions", "mockups", "drafts", "specs", "journal", "docs"];
export type DocsOnlyKind = typeof DOCS_ONLY_KINDS[number];
export declare const rulesSchema: import("../domain/schema.js").Schema<{
    readonly captures: {
        readonly viewports: ("phone" | "desktop" | "tablet")[] | undefined;
        readonly themes: ("light" | "dark")[] | undefined;
    } | undefined;
    readonly requiredGates: {
        readonly id: string;
        readonly command: string[];
    }[] | undefined;
    readonly journalDays: number | undefined;
    readonly screens: string[] | undefined;
    readonly docsOnly: {
        readonly enabled: boolean | undefined;
        readonly kinds: ("decisions" | "mockups" | "drafts" | "specs" | "journal" | "docs")[] | undefined;
        readonly exclude: string[] | undefined;
    } | undefined;
    readonly ciProof: {
        readonly workflow: string;
        readonly job: string;
        readonly name: string;
        readonly gates: string[];
        readonly protectedPaths: string[] | undefined;
        readonly artifact: string | undefined;
    } | undefined;
}>;
export type RulesSection = Infer<typeof rulesSchema>;
export interface RequiredGate {
    id: string;
    command: string[];
    source: 'apv' | 'config';
}
export interface RulesSettings {
    captures: {
        viewports: CaptureViewport[];
        themes: CaptureTheme[];
    };
    requiredGates: RequiredGate[];
    screens: string[];
    /** The lane without code: off, or the kinds it accepts and the paths it excludes. */
    docsOnly: {
        enabled: boolean;
        kinds: DocsOnlyKind[];
        exclude: string[];
    };
    /** The proof by the CI, or null when the project does not declare it (local proof only). */
    ciProof: CiProofSettings | null;
}
/**
 * Files that produce the proof of the CI, always protected besides the declared workflow: the workflows and local actions
 * (a reusable workflow or a composite action runs in the job), the scripts of the end-to-end and dynamic tests, the
 * configuration of Playwright and of npm (`script-shell` replaces the shell of every script), the whole package.json (a
 * script `test:*` calls others, npm runs `pre`/`post` and installation scripts by itself) and the lock files, the
 * configuration of the build tools (executed by `prepare` and the tests). The files these name or import are added by the rule.
 */
export declare const CI_PROTECTED_DEFAULTS: readonly string[];
export interface CiProofSettings {
    workflow: string;
    job: string;
    name: string;
    gates: string[];
    /** The workflow, the defaults and what the project adds, deduplicated. */
    protectedPaths: string[];
    artifact: string | null;
}
/** Effective settings of a `rules` section: the defaults, completed by what the project adds. Throws a CONFIG error. */
export declare function rulesSettings(section: RulesSection | undefined, builtIn: readonly RequiredGate[]): RulesSettings;
