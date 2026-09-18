import type { AgentConfig, ProcessResult } from '../domain/contracts.js';
import type { Store } from '../persistence/store.js';
import { type ProcessHooks } from '../execution/process.js';
import { type InvocationOwner } from './invocations.js';
/** Diagnose provider failures, never infer retirement from a successful model's prose. */
export declare function assertModelResponse(agent: AgentConfig, result: ProcessResult): void;
/** A real bounded native-CLI probe; only a fixed prompt is sent, never project contents.
 * Success attests this model/effort/CLI/account combination now, not future availability or quality.
 */
export declare function ensureModelReady(agent: AgentConfig, options: {
    store: Store;
    owner: InvocationOwner;
    env: NodeJS.ProcessEnv;
    cwd?: string;
    signal?: AbortSignal;
    hooks?: ProcessHooks;
}): Promise<void>;
