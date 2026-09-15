import { type Infer } from './schema.js';
export declare const roleNames: readonly ["setup", "product", "implementer", "qa"];
export type RoleName = typeof roleNames[number];
export declare const skillNames: readonly ["clean-code", "design-patterns", "refactoring", "security", "tdd", "ui-design"];
export declare const projectTypes: readonly ["unknown", "backend", "frontend", "mobile", "fullstack", "library"];
export declare const skillsSchema: import("./schema.js").Schema<{
    readonly enabled: ("clean-code" | "design-patterns" | "refactoring" | "security" | "tdd" | "ui-design")[];
    readonly projectType: "unknown" | "backend" | "frontend" | "mobile" | "fullstack" | "library";
    readonly maxContextBytes: number;
}>;
export type SkillsConfig = Infer<typeof skillsSchema>;
/** How a declaration line decides whether the symbol is part of the module's public surface. */
export declare const exportRules: readonly ["always", "marker", "capitalized", "not-underscore", "unless-hidden"];
/**
 * A declarative language profile. The controller knows languages by file extension and
 * declaration grammar only; it never encodes a framework. Unknown technologies fall back to
 * file-level units, and projects can add or override profiles in `knowledge.languages`.
 *
 * `pattern` is a JavaScript regular expression applied to one source line. It must capture the
 * symbol in a named group `name`; optional groups `export` (rule `marker`) and `hidden`
 * (rule `unless-hidden`) drive public-surface detection. `prefilter` is a POSIX ERE handed
 * to `git grep` so that only candidate lines are read.
 */
export declare const languageProfileSchema: import("./schema.js").Schema<{
    readonly id: string;
    readonly extensions: string[];
    readonly prefilter: string;
    readonly declarations: {
        readonly kind: string;
        readonly pattern: string;
        readonly exported: "always" | "marker" | "capitalized" | "not-underscore" | "unless-hidden";
    }[];
}>;
export type LanguageProfile = Infer<typeof languageProfileSchema>;
export declare const knowledgeSchema: import("./schema.js").Schema<{
    readonly languages: {
        readonly id: string;
        readonly extensions: string[];
        readonly prefilter: string;
        readonly declarations: {
            readonly kind: string;
            readonly pattern: string;
            readonly exported: "always" | "marker" | "capitalized" | "not-underscore" | "unless-hidden";
        }[];
    }[];
}>;
export type KnowledgeConfig = Infer<typeof knowledgeSchema>;
