import type { Config } from '../domain/contracts.js';
import { type ProcessHooks } from './process.js';
export interface FeedbackConnection {
    url: string;
    token: string;
}
/** A session-scoped MCP endpoint. Only the controller's frozen gate argv may execute.
 * Results are development feedback, never validation receipts. Local-trusted execution applies.
 */
export declare function startFeedback(options: {
    config: Config;
    workspace: string;
    signal: AbortSignal;
    hooks?: ProcessHooks;
    emit: (type: string, data: Record<string, unknown>) => void;
}): Promise<FeedbackConnection & {
    close(): Promise<void>;
}>;
