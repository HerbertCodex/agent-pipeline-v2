/**
 * Bounded waits for a session that may not sleep (`apv wait`). A non-interactive Claude Code session refuses
 * `sleep`, `tail --pid` and shell loops over `kill -0` (pilot project, 24 September 2026): one call of the tool
 * waits instead, at most MAX_WAIT_SECONDS, so that it stays under the ten minutes of one Bash call.
 */
/** Longest wait of one call, in seconds: under the 600 s limit of one Bash call of Claude Code. */
export declare const MAX_WAIT_SECONDS = 580;
/** Default poll interval (`APV_WAIT_POLL_MS` changes it, for the tests). */
export declare const DEFAULT_POLL_MS = 1000;
export type WaitCondition = {
    kind: 'pid';
    pid: number;
} | {
    kind: 'file';
    path: string;
    contains?: string;
};
export interface WaitResult {
    met: boolean;
    /** Seconds waited, rounded down. */
    waitedSeconds: number;
    /** Met at the first look (the process was already gone, the file already there). */
    immediate: boolean;
}
/**
 * State of a process seen from here: `alive`, or `gone` (no such process, or a zombie that only waits for its
 * parent to reap it: it will never run again). `EPERM` means the process exists under another user: alive.
 */
export declare function processState(pid: number): 'alive' | 'gone';
/**
 * Watches a file for a text without reading it twice: each look reads only the bytes added since the last one
 * (plus the length of the text, for a match across two reads), so a growing log of any size costs nothing.
 * A file that shrinks (rewritten, rotated) is read again from the start. Only a regular file is opened: a FIFO
 * named like the file would block the read.
 */
export declare class FileWatch {
    private readonly path;
    private offset;
    private tail;
    private readonly needle;
    constructor(path: string, contains?: string);
    /** True when the file exists (and holds the text, when one was given). */
    check(): boolean;
}
export interface WaitOptions {
    timeoutSeconds: number;
    pollMs?: number;
    /** Clock and sleep, injected by the tests; real time otherwise. */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
/** Waits until the condition holds or the timeout passes; looks once more at the deadline. */
export declare function waitFor(condition: WaitCondition, options: WaitOptions): Promise<WaitResult>;
