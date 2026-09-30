import { type ChangeBase, type Changes } from './changes.js';
import { type MapSection, type ReuseRule, type ReuseSection, type ReuseSeverity } from './config.js';
export interface ReuseFinding {
    rule: ReuseRule;
    severity: 'warning' | 'error';
    /** Added or modified by the change (always true without base). */
    isNew: boolean;
    /** `error` and new: makes the check fail. */
    blocking: boolean;
    path: string;
    line: number;
    endLine?: number;
    message: string;
    /** The other copy of a duplicated block, or the shared component a name doubles. */
    other?: {
        path: string;
        line: number;
        endLine?: number;
    };
}
export interface RuleSummary {
    severity: ReuseSeverity;
    active: boolean;
    note: string | null;
    new: number;
    existing: number;
}
export interface ReuseReport {
    ok: boolean;
    base: ChangeBase;
    analyzedFiles: number;
    rules: Record<ReuseRule, RuleSummary>;
    findings: ReuseFinding[];
    primitives: {
        sources: string[];
        count: number;
    };
    /** Files a tool writes (by name or first lines), left out of every rule: their count and the first 20. */
    generated: {
        count: number;
        files: string[];
    };
    /**
     * Files left out: by `reuse.ignore`, or by a default exclusion for a file already there at the base. `changed`: every
     * one the change creates or modifies, never truncated; `existing`: the first 20 of the others; `count`: all.
     */
    excluded: {
        count: number;
        changed: string[];
        existing: string[];
    };
}
export interface ReuseConfig {
    reuse?: ReuseSection | undefined;
    map?: MapSection | undefined;
    design?: {
        dir?: string | undefined;
    } | undefined;
}
export interface CheckOptions {
    /** `--base`: any commit-ish; else `reuse.reference`; else no base (everything counts as new). */
    base?: string;
    /** Precomputed changes (tests, onboarding). */
    changes?: Changes;
}
/**
 * `apv reuse check` (docs/REUSE.md): what a change adds against the existing components of the project. Every rule
 * reports what the change adds (new) and what was already there (existing, never blocking), so that a project with a
 * history adopts the check without first cleaning everything.
 */
export declare function checkReuse(repo: string, config: ReuseConfig, options?: CheckOptions): Promise<ReuseReport>;
