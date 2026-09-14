export class PipelineError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PipelineError';
  }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new PipelineError(code, message);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
