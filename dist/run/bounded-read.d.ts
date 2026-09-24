/**
 * Bounded read of a state file, shared by the summary of the executions and `readRunState` (apv run
 * next|set|status <id>): a FIFO, a device or a huge file named like a state never blocks nor exhausts the caller.
 */
/** Largest state file read; a bigger one is reported as unreadable. */
export declare const MAX_RUN_STATE_BYTES: number;
/** The total bound of a summary is reached: this file and the next ones stay unread. */
export declare class BudgetSpent extends Error {
}
/**
 * Reads at most `max` bytes of a regular file, and at most `budget` bytes (else BudgetSpent). A FIFO or a device
 * is refused before any blocking read (non-blocking open, then fstat), and a file that grows past a bound while
 * read is refused too. Every error names the file by `shown` (its path in the repository) and never quotes its
 * content; a system error keeps only its code (ENOENT, EACCES...), whose message would carry the absolute path.
 */
export declare function readBounded(file: string, shown: string, max: number, budget?: number): Buffer;
