import { type AgentConfig, type Config, type Run } from '../domain/contracts.js';
import { type Store, type Document } from '../persistence/store.js';
import { Pipeline } from '../engine/pipeline.js';
export interface Inventory {
    repo: string;
    baseSha: string;
    files: string[];
    stack: string;
    projectType: 'unknown' | 'backend' | 'frontend' | 'mobile' | 'fullstack' | 'library';
    packageManager: string | null;
    scripts: Record<string, string>;
    securityScripts: string[];
    warnings: string[];
}
export interface InstallPlan {
    repo: string;
    baseSha: string;
    inventory: Inventory;
    config: Config;
    questions: string[];
    notes: string[];
    files: {
        path: string;
        before: string | null;
        content: string;
    }[];
    hash: string;
    applied: boolean;
    approval: {
        reviewer: string;
        note: string;
        at: number;
    } | null;
    commitSha: string | null;
}
export declare const defaultAgent: () => AgentConfig;
export declare function inspectProject(path: string): Promise<Inventory>;
export declare function proposeConfiguration(inventory: Inventory, agent?: AgentConfig): {
    config: Config;
    questions: string[];
    notes: string[];
};
export declare function installHash(plan: Pick<InstallPlan, 'repo' | 'baseSha' | 'config' | 'questions' | 'files'>): string;
export declare function planInstallation(store: Store, repo: string, options?: {
    config?: unknown;
    agent?: unknown;
    assist?: boolean;
    reviewMode?: 'solo' | 'team' | 'regulated';
    signal?: AbortSignal;
}): Promise<Document<InstallPlan>>;
export declare function applyInstallation(store: Store, id: string, expectedHash: string, actor: string, note: string, commit?: boolean): Promise<Document<InstallPlan>>;
export declare function doctor(pipeline: Pipeline, repo: string, configInput: unknown, execute: boolean, signal?: AbortSignal): Promise<{
    inventory: Inventory;
    configHash: string;
    passed: boolean | null;
    runId: string | null;
    runState: Run['state'] | null;
    note: string;
}>;
