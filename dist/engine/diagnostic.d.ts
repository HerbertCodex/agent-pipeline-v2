/** Maximum characters of a failed gate diagnostic kept in a receipt and handed to a repair. */
export declare const MAX_DIAGNOSTIC_CHARS = 16000;
/**
 * Failure-focused excerpt of a failed command: the beginning of the output, every line matching generic
 * failure vocabulary with surrounding context, and the end (usually the summary). A plain tail used to
 * keep only passing-test noise and the summary, hiding which tests failed and why.
 */
export declare function failureExcerpt(status: string, stderr: string, stdout: string, limit?: number): string;
