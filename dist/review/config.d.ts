import { type Infer } from '../domain/schema.js';
/**
 * Settings of `apv review plan` in the `review` section of `.apv/config.json` (docs/CONFIGURATION.md, « Revues »):
 * which paths hold the interface, the data, the personal data, the legal texts, what is neutral (tests,
 * documentation), which words in the changed lines keep a domain, and which domains the project always wants.
 * Each key given replaces its default list; absent keys keep the defaults below.
 */
/** The default review domains of `/apv:review` (same list as `REVIEWS` of the run state). */
export declare const REVIEW_DOMAINS: readonly ["securite", "fidelite", "donnees", "rgpd"];
export type ReviewDomainName = typeof REVIEW_DOMAINS[number];
/** The review that no diff, no configuration and no option ever skips. */
export declare const ALWAYS_REVIEWED: ReviewDomainName;
/** Path classes of a changed file; `neutral` counts only for a file that matches no other class. */
export declare const PATH_CLASSES: readonly ["ui", "data", "migrations", "personal", "legal", "neutral"];
export type PathClass = typeof PATH_CLASSES[number];
/** Generic defaults, for any stack: a project with other conventions declares its own lists. */
export declare const DEFAULT_REVIEW_PATHS: Record<PathClass, readonly string[]>;
/**
 * Words (case-insensitive substrings) that, in the changed lines of an interface or data file, keep a domain:
 * `data` keeps the data review (a query written in a page), `personal` keeps the GDPR review (a tracker, a cookie,
 * a new personal field). A false alarm keeps a review: the direction of prudence.
 */
export declare const DEFAULT_REVIEW_TERMS: {
    data: readonly string[];
    personal: readonly string[];
};
export declare const reviewPathsSchema: import("../domain/schema.js").Schema<{
    readonly ui: string[] | undefined;
    readonly data: string[] | undefined;
    readonly migrations: string[] | undefined;
    readonly personal: string[] | undefined;
    readonly legal: string[] | undefined;
    readonly neutral: string[] | undefined;
}>;
export declare const reviewTermsSchema: import("../domain/schema.js").Schema<{
    readonly data: string[] | undefined;
    readonly personal: string[] | undefined;
}>;
/** Domains always kept, whatever the diff: `securite` is kept anyway, and no key can skip it. */
export declare const reviewAlwaysSchema: import("../domain/schema.js").Schema<("securite" | "fidelite" | "donnees" | "rgpd")[]>;
export type ReviewPaths = Infer<typeof reviewPathsSchema>;
export type ReviewTerms = Infer<typeof reviewTermsSchema>;
/** What `apv review plan` reads of a configuration: the paths and terms of each class, defaults for what is absent. */
export interface ReviewPlanSettings {
    paths: Record<PathClass, string[]>;
    terms: {
        data: string[];
        personal: string[];
    };
    always: ReviewDomainName[];
}
export declare function reviewPlanSettings(section: {
    paths?: ReviewPaths | undefined;
    terms?: ReviewTerms | undefined;
    always?: ReviewDomainName[] | undefined;
} | undefined): ReviewPlanSettings;
