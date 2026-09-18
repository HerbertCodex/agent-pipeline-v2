import type { Config } from '../domain/contracts.js';
/**
 * What one agent invocation spent and why it ended, as the provider reports it. These are declared values,
 * not measurements by this controller: a cost here is what the provider says it charged, never an invoice.
 */
export interface AttemptUsage {
    stopReason: string | null;
    /** What the provider itself said about the stop, when it says anything: quota, plan limit, API error. */
    providerMessage: string | null;
    costUsd: number | null;
    turns: number | null;
    durationMs: number | null;
    models?: string[];
    tokens?: {
        input: number | null;
        output: number | null;
        cacheRead: number | null;
        cacheWrite: number | null;
    };
}
/**
 * Usage of the last invocation, when the configured provider reports it. A provider that reports nothing
 * yields null: the controller never invents a cost, a turn count or a reason.
 */
export declare function providerUsage(type: Config['agent']['type'], stdout: string): AttemptUsage | null;
/** One line an operator can act on: what stopped the agent and what it had spent when it stopped. */
export declare function usageSentence(usage: AttemptUsage | null): string;
