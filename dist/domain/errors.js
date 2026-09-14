export class PipelineError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = 'PipelineError';
    }
}
export function invariant(condition, code, message) {
    if (!condition)
        throw new PipelineError(code, message);
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=errors.js.map