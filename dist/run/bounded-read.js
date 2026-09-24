import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { PipelineError } from '../domain/errors.js';
/**
 * Bounded read of a state file, shared by the summary of the executions and `readRunState` (apv run
 * next|set|status <id>): a FIFO, a device or a huge file named like a state never blocks nor exhausts the caller.
 */
/** Largest state file read; a bigger one is reported as unreadable. */
export const MAX_RUN_STATE_BYTES = 4 * 1024 * 1024;
/** The total bound of a summary is reached: this file and the next ones stay unread. */
export class BudgetSpent extends Error {
}
/**
 * Reads at most `max` bytes of a regular file, and at most `budget` bytes (else BudgetSpent). A FIFO or a device
 * is refused before any blocking read (non-blocking open, then fstat), and a file that grows past a bound while
 * read is refused too. Every error names the file by `shown` (its path in the repository) and never quotes its
 * content; a system error keeps only its code (ENOENT, EACCES...), whose message would carry the absolute path.
 */
export function readBounded(file, shown, max, budget = Number.POSITIVE_INFINITY) {
    try {
        return read(file, shown, max, budget);
    }
    catch (error) {
        if (error instanceof PipelineError || error instanceof BudgetSpent)
            throw error;
        const code = error?.code;
        throw new PipelineError('RUN_STATE', `État illisible ${shown} : ${typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : 'erreur de lecture'}`);
    }
}
function read(file, shown, max, budget) {
    const tooBig = (size) => new PipelineError('RUN_STATE', `État trop volumineux ${shown} : ${size} octets, limite ${max}`);
    const notFile = () => new PipelineError('RUN_STATE', `État illisible ${shown} : pas un fichier ordinaire`);
    const before = statSync(file);
    if (!before.isFile())
        throw notFile();
    if (before.size > max)
        throw tooBig(String(before.size));
    if (before.size > budget)
        throw new BudgetSpent();
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
        if (!fstatSync(fd).isFile())
            throw notFile();
        const buffer = Buffer.allocUnsafe(Math.min(max, budget) + 1);
        let length = 0;
        while (length < buffer.length) {
            const read = readSync(fd, buffer, length, buffer.length - length, null);
            if (read === 0)
                break;
            length += read;
        }
        if (length > max)
            throw tooBig(`plus de ${max}`);
        if (length > budget)
            throw new BudgetSpent();
        return buffer.subarray(0, length);
    }
    finally {
        closeSync(fd);
    }
}
//# sourceMappingURL=bounded-read.js.map