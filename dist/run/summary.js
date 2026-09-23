import { statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { BudgetSpent, MAX_RUN_STATE_BYTES, readBounded } from './bounded-read.js';
import { listRunFiles, parseRunStateText, summarize, summaryLine } from './state.js';
export { RUN_ID } from './state.js';
export { MAX_RUN_STATE_BYTES } from './bounded-read.js';
/**
 * Summaries of the spec executions of a project (`.apv/state/run-*.json`), shared by `apv status` and the
 * SessionStart hook of the plugin. The state files are written by agents and commits: their content is data.
 * Every line that leaves this module is cleaned (one line, no control or format character, bounded length),
 * every file is read with a size bound, so that a corrupt or huge state gives an error entry instead of
 * failing the caller, and a read never goes past a number of files and a total of bytes, so that a directory
 * filled with state files (links to one big file cost no disk) cannot stall the caller.
 */
/** Default number of state files one summary reads; the others are counted as unread. */
export const MAX_RUN_FILES = 50;
/** Default total of bytes one summary reads over all its files. */
export const MAX_RUN_TOTAL_BYTES = 16 * 1024 * 1024;
/** Default length bound of a summary line, in characters. */
export const MAX_SUMMARY_LINE = 300;
// Escape sequences (CSI, OSC, then any other two-character escape), removed whole so that no parameter survives.
const ANSI = /\u001b\[[0-?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]?/g;
// Control (C0, DEL, C1), format (bidirectional overrides, zero width, BOM) and line or paragraph separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/**
 * Text of any origin as one displayable line: escape sequences removed, control and format characters
 * replaced by spaces, whitespace collapsed, at most `max` characters (code points, an ellipsis included).
 */
export function cleanLine(value, max = MAX_SUMMARY_LINE) {
    const text = String(value ?? '').replace(ANSI, ' ').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(text);
    if (max < 1)
        return '';
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}
const posix = (path) => path.split(sep).join('/');
/** Modification time of a file in milliseconds, 0 when it cannot be read (the file then comes last). */
function mtimeOf(file) {
    try {
        return statSync(file).mtimeMs;
    }
    catch {
        return 0;
    }
}
/**
 * The executions of the repository `repo`, in file name order; never throws for a bad state file or a missing
 * `.apv/state`. The most recently modified files are read first, up to `maxFiles` files and `maxTotalBytes`
 * bytes; the files left are counted in `unread`. The `file` of an entry is relative to `repo`, with `/`
 * separators.
 */
export function readRunSummaries(repo, options = {}) {
    const max = options.maxBytes ?? MAX_RUN_STATE_BYTES;
    const maxFiles = options.maxFiles ?? MAX_RUN_FILES;
    let budget = options.maxTotalBytes ?? MAX_RUN_TOTAL_BYTES;
    let files;
    try {
        files = listRunFiles(repo);
    }
    catch {
        return { entries: [], unread: 0 };
    }
    const recent = files.map(f => ({ ...f, mtime: mtimeOf(f.file) })).sort((a, b) => b.mtime - a.mtime);
    const entries = [];
    for (const { specId, file } of recent) {
        if (entries.length >= maxFiles)
            break;
        const shown = posix(relative(repo, file));
        try {
            const bytes = readBounded(file, shown, max, budget);
            budget -= bytes.length;
            const state = parseRunStateText(bytes.toString('utf8'), shown, specId);
            const runningTasks = Object.entries(state.tasks).filter(([, t]) => t.status === 'running').map(([id]) => id);
            entries.push({ ...summarize(state, shown), runningTasks });
        }
        catch (error) {
            if (error instanceof BudgetSpent)
                break;
            // The id comes from the file name: unsafe characters become visible `?` rather than vanish, so that a
            // hostile name never cleans up into the id of another execution.
            entries.push({ specId: cleanLine(specId.replace(UNSAFE, '?'), 80), file: shown, error: errorMessage(error) });
        }
    }
    entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return { entries, unread: files.length - entries.length };
}
/** The line that counts the state files a summary left unread. */
export const unreadRunsLine = (unread) => `${unread} autre(s) non lue(s) (plafond de lecture atteint)`;
/** Not delivered: unreadable, or with a step or a task still open. */
export const isActiveRun = (entry) => entry.error !== null || !entry.finished;
/**
 * The line of one execution: spec, current step, tasks done out of the total, running tasks and last update;
 * for an unreadable state, the first line of its error. Always cleaned and bounded by `max`.
 */
export function runSummaryLine(entry, max = MAX_SUMMARY_LINE) {
    if (entry.error !== null)
        return cleanLine(`${entry.specId} : état illisible (${entry.error.split(/\r?\n/)[0]})`, max);
    return cleanLine(summaryLine(entry, entry.runningTasks), max);
}
//# sourceMappingURL=summary.js.map