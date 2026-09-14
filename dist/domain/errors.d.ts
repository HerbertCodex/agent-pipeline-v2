export declare class PipelineError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions);
}
export declare function invariant(condition: unknown, code: string, message: string): asserts condition;
export declare function errorMessage(error: unknown): string;
