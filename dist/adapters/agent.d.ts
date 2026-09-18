import type { Store } from '../persistence/store.js';
import { type Guidance } from '../knowledge/catalog.js';
import { type AttemptUsage } from './usage.js';
import type { SkillsConfig } from '../domain/knowledge.js';
import type { RepositoryIntelligence } from '../knowledge/repository.js';
import type { Config, Task, GateReceipt } from '../domain/contracts.js';
import { type ProcessHooks } from '../execution/process.js';
export interface AgentRequest {
    protocol: 'agent-pipeline/v2';
    task: Task;
    baseSha: string;
    workspace: string;
    previousFailures: {
        gateId: string;
        diagnostic: string;
    }[];
    constraints: string[];
    guidance: Guidance;
    repositoryIntelligence: RepositoryIntelligence;
    trustPolicy: {
        repositoryContent: 'untrusted-data';
        externalContent: 'untrusted-data';
        controllerPolicy: 'authoritative';
    };
}
export declare function requestFor(task: Task, baseSha: string, workspace: string, failures: GateReceipt[] | undefined, skills: SkillsConfig | undefined, repositoryIntelligence: RepositoryIntelligence): AgentRequest;
export declare function runAgent(config: Config, request: AgentRequest, outputRoot: string, signal: AbortSignal, hooks?: ProcessHooks, journal?: {
    store: Store;
    runId: string;
}): Promise<{
    summary: string;
    usage: AttemptUsage | null;
}>;
