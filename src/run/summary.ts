import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { listRunFiles, parseRunStateText, summarize, summaryLine, type RunSummary } from './state.js';

export { RUN_ID } from './state.js';

/**
 * Summaries of the spec executions of a project (`.apv/state/run-*.json`), shared by `apv status` and the
 * SessionStart hook of the plugin. The state files are written by agents and commits: their content is data.
 * Every line that leaves this module is cleaned (one line, no control or format character, bounded length),
 * and every file is read with a size bound, so that a corrupt or huge state gives an error entry instead of
 * failing the caller.
 */

/** Largest state file read; a bigger one is reported as unreadable. */
export const MAX_RUN_STATE_BYTES = 4 * 1024 * 1024;
/** Default length bound of a summary line, in characters. */
export const MAX_SUMMARY_LINE = 300;

export type RunSummaryOk = RunSummary & { runningTasks: string[] };
export interface RunSummaryError { specId: string; file: string; error: string }
/** One execution: its summary, or the reason its state could not be read (`error` not null). */
export type RunSummaryEntry = RunSummaryOk | RunSummaryError;

export interface ReadRunSummariesOptions { maxBytes?: number }

// Escape sequences (CSI, OSC, then any other two-character escape), removed whole so that no parameter survives.
const ANSI = /\u001b\[[0-?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]?/g;
// Control (C0, DEL, C1), format (bidirectional overrides, zero width, BOM) and line or paragraph separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Text of any origin as one displayable line: escape sequences removed, control and format characters
 * replaced by spaces, whitespace collapsed, at most `max` characters (code points, an ellipsis included).
 */
export function cleanLine(value: unknown, max = MAX_SUMMARY_LINE): string {
  const text = String(value ?? '').replace(ANSI, ' ').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  if (max < 1) return '';
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

const posix = (path: string): string => path.split(sep).join('/');

/**
 * Reads at most `max` bytes of a regular file. A FIFO or a device is refused before any blocking read
 * (non-blocking open, then fstat), and a file that grows past the bound while read is refused too.
 */
function readBounded(file: string, max: number): string {
  const tooBig = (size: string): PipelineError => new PipelineError('RUN_STATE', `État trop volumineux ${file} : ${size} octets, limite ${max}`);
  const notFile = (): PipelineError => new PipelineError('RUN_STATE', `État illisible ${file} : pas un fichier ordinaire`);
  const before = statSync(file);
  if (!before.isFile()) throw notFile();
  if (before.size > max) throw tooBig(String(before.size));
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw notFile();
    const buffer = Buffer.allocUnsafe(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > max) throw tooBig(`plus de ${max}`);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Every execution of the repository `repo`, in file name order; never throws for a bad state file or a
 * missing `.apv/state`. The `file` of an entry is relative to `repo`, with `/` separators.
 */
export function readRunSummaries(repo: string, options: ReadRunSummariesOptions = {}): RunSummaryEntry[] {
  const max = options.maxBytes ?? MAX_RUN_STATE_BYTES;
  let files: { specId: string; file: string }[];
  try { files = listRunFiles(repo); } catch { return []; }
  return files.map(({ specId, file }): RunSummaryEntry => {
    const shown = posix(relative(repo, file));
    try {
      const state = parseRunStateText(readBounded(file, max), file);
      const runningTasks = Object.entries(state.tasks).filter(([, t]) => t.status === 'running').map(([id]) => id);
      return { ...summarize(state, shown), runningTasks };
    } catch (error) {
      // The id comes from the file name: unsafe characters become visible `?` rather than vanish, so that a
      // hostile name never cleans up into the id of another execution.
      return { specId: cleanLine(specId.replace(UNSAFE, '?'), 80), file: shown, error: errorMessage(error) };
    }
  });
}

/** Not delivered: unreadable, or with a step or a task still open. */
export const isActiveRun = (entry: RunSummaryEntry): boolean => entry.error !== null || !entry.finished;

/**
 * The line of one execution: spec, current step, tasks done out of the total, running tasks and last update;
 * for an unreadable state, the first line of its error. Always cleaned and bounded by `max`.
 */
export function runSummaryLine(entry: RunSummaryEntry, max = MAX_SUMMARY_LINE): string {
  if (entry.error !== null) return cleanLine(`${entry.specId} : état illisible (${entry.error.split(/\r?\n/)[0]})`, max);
  return cleanLine(summaryLine(entry, entry.runningTasks), max);
}
