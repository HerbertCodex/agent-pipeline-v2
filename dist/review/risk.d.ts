/**
 * Risk level of a diff (`apv review plan`, `apv gates run --since`). Pilot project, 3 October 2026: a pull request of
 * tests and interface texts went through four reviews, a loop of corrections and two full suites of 30 minutes. The
 * level says whether a change only touches what cannot change the behavior of the product on its own:
 * - `faible`: tests and test tooling, documentation, interface texts without new markup (or a file that no class
 *   describes whose changed lines are only prose strings), mockups;
 * - `eleve`: everything else (migration, schema, data, personal data, export, tracker, legal text, sensitive path of
 *   the high lane such as authentication, session, permissions or security configuration, server code or configuration,
 *   new markup or code, a file moved, a term of data or GDPR in the changed lines, a file no class describes): the
 *   review plan then behaves exactly as before the level existed.
 * The level never removes the security review, which every plan keeps.
 */
/**
 * A line reduced to its structure: string literals and text nodes replaced, whitespace dropped; the string literals
 * (attribute values included) and the text nodes taken out apart.
 */
interface Skeleton {
    shape: string;
    literals: string[];
    nodes: string[];
    contexts: string[];
}
/**
 * The structure of one changed line. String literals (`'…'`, `"…"`, a template without `${`) become `S`; in a markup
 * file, the text between two tags (and before the first or after the last tag) becomes `T`, and a line with no tag and
 * nothing that looks like code is a text node. A comment line counts as prose. Null: a line that cannot be read
 * safely (a string left open, a template with an expression).
 */
export declare function skeleton(line: string, markup: boolean): Skeleton | null;
export declare const isTextShape: (shape: string) => boolean;
/**
 * Prose, not a value the code acts on: a space and a letter, and nothing of an address, a markup, an expression or a
 * path (`role: 'admin'`, a URL, a CSS selector or a header value stay code). A one-word label is not prose: the file
 * keeps its review.
 */
export declare function isProse(text: string): boolean;
/**
 * True when the changed lines of a file only change prose: interface texts, strings of a messages module, comments.
 * The removed and added lines, reduced to their structure, are the same multiset once the lines that only carry prose
 * are set aside; every changed string literal (attribute values included) reads as prose. A new tag, attribute, expression,
 * call or any other code is a change of structure. A file added or deleted whole has a structure that changes.
 */
export declare function textOnly(patch: {
    binary: boolean;
    removed: string[];
    added: string[];
}, path: string): boolean;
/** Risk level of a diff. */
export type RiskLevel = 'faible' | 'eleve';
export declare const RISK_LEVELS: readonly RiskLevel[];
export declare const RISK_LABEL: Readonly<Record<RiskLevel, string>>;
export interface DiffRisk {
    level: RiskLevel;
    /** One sentence: what makes the level, with the number of files of each reason. */
    reason: string;
    /** Files of a high risk, with their reason (50 at most), and how many in all. */
    files: {
        path: string;
        why: string;
    }[];
    fileCount: number;
}
/** The level of a diff from the risk of each of its files: high as soon as one file is. */
export declare function diffRisk(files: readonly {
    path: string;
    risk: RiskLevel;
    riskWhy: string;
}[], shown?: number): DiffRisk;
export {};
