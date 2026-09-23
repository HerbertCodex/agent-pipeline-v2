import { type Finding } from './checks.js';
/**
 * `select('*')`, `select('id, events(*)')`, `.select()` without argument (supabase-js returns every
 * column) and `select *` in SQL strings. `select('*', { count: 'exact', head: true })` only counts
 * rows and is accepted.
 */
export declare function scanSelectStar(file: string, text: string): Finding[];
export declare function scanCode(root: string, globs: readonly string[], exclude: readonly string[]): {
    files: string[];
    findings: Finding[];
};
