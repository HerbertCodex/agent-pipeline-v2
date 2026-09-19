import type { AgentConfig, ProcessResult } from '../domain/contracts.js';
/** Inspect only failed envelopes/messages, never classify successful generated code as an outage. */
export declare function providerStop(agent: AgentConfig, result: ProcessResult): {
    code: string;
    message: string;
} | null;
export declare function stopAdvice(error: {
    code: string;
    message: string;
} | null): {
    automaticRetry: boolean;
    category: string;
    action: string;
    code: string;
} | null;
