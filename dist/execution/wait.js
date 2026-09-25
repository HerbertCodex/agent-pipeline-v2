import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
/**
 * Bounded waits for a session that may not sleep (`apv wait`). A non-interactive Claude Code session refuses
 * `sleep`, `tail --pid` and shell loops over `kill -0` (pilot project, 24 September 2026): one call of the tool
 * waits instead, at most MAX_WAIT_SECONDS, so that it stays under the ten minutes of one Bash call.
 */
/** Longest wait of one call, in seconds: under the 600 s limit of one Bash call of Claude Code. */
export const MAX_WAIT_SECONDS = 580;
/** Default poll interval (`APV_WAIT_POLL_MS` changes it, for the tests). */
export const DEFAULT_POLL_MS = 1000;
/**
 * State of a process seen from here: `alive`, or `gone` (no such process, or a zombie that only waits for its
 * parent to reap it: it will never run again). `EPERM` means the process exists under another user: alive.
 */
export function processState(pid) {
    try {
        process.kill(pid, 0);
    }
    catch (error) {
        return error.code === 'EPERM' ? 'alive' : 'gone';
    }
    if (process.platform === 'linux') {
        try {
            // Field 3 of /proc/<pid>/stat, after the command name in parentheses (which may itself hold spaces).
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z'))
                return 'gone';
        }
        catch { /* gone between the two reads, or no /proc: kill(0) said alive */ }
    }
    return 'alive';
}
/**
 * Watches a file for a text without reading it twice: each look reads only the bytes added since the last one
 * (plus the length of the text, for a match across two reads), so a growing log of any size costs nothing.
 * A file that shrinks (rewritten, rotated) is read again from the start. Only a regular file is opened: a FIFO
 * named like the file would block the read.
 */
export class FileWatch {
    path;
    offset = 0;
    tail = Buffer.alloc(0);
    needle;
    constructor(path, contains) {
        this.path = path;
        this.needle = contains === undefined ? null : Buffer.from(contains, 'utf8');
    }
    /** True when the file exists (and holds the text, when one was given). */
    check() {
        let size;
        try {
            const stat = statSync(this.path);
            if (!this.needle)
                return true;
            if (!stat.isFile())
                return false;
            size = stat.size;
        }
        catch {
            return false;
        }
        const needle = this.needle;
        if (size < this.offset) {
            this.offset = 0;
            this.tail = Buffer.alloc(0);
        }
        if (size === this.offset)
            return needle.length === 0;
        let fd;
        try {
            fd = openSync(this.path, 'r');
        }
        catch {
            return false;
        }
        try {
            const chunk = Buffer.alloc(Math.min(size - this.offset, 4 * 1024 * 1024));
            const read = readSync(fd, chunk, 0, chunk.length, this.offset);
            this.offset += read;
            const window = Buffer.concat([this.tail, chunk.subarray(0, read)]);
            if (window.includes(needle))
                return true;
            this.tail = needle.length > 1 ? window.subarray(Math.max(0, window.length - (needle.length - 1))) : Buffer.alloc(0);
            return false;
        }
        finally {
            closeSync(fd);
        }
    }
}
const realSleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms); });
/** Waits until the condition holds or the timeout passes; looks once more at the deadline. */
export async function waitFor(condition, options) {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? realSleep;
    const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
    const start = now();
    const deadline = start + options.timeoutSeconds * 1000;
    const watch = condition.kind === 'file' ? new FileWatch(condition.path, condition.contains) : null;
    const holds = () => condition.kind === 'pid' ? processState(condition.pid) === 'gone' : watch.check();
    const waited = () => Math.floor((now() - start) / 1000);
    if (holds())
        return { met: true, waitedSeconds: 0, immediate: true };
    for (;;) {
        const left = deadline - now();
        if (left <= 0)
            return { met: holds(), waitedSeconds: waited(), immediate: false };
        await sleep(Math.min(pollMs, left));
        if (holds())
            return { met: true, waitedSeconds: waited(), immediate: false };
    }
}
//# sourceMappingURL=wait.js.map