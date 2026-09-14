import type { ChangeSet } from '../domain/contracts.js';
import { type ProcessHooks } from './process.js';
export declare function isInside(parent: string, child: string): boolean;
export declare class Git {
    private readonly signal?;
    private readonly hooks;
    constructor(signal?: AbortSignal | undefined, hooks?: ProcessHooks);
    exec(cwd: string, args: string[]): Promise<string>;
    configValue(repo: string, key: string): Promise<string | null>;
    root(path: string): Promise<string>;
    sha(repo: string, ref?: string): Promise<string>;
    clean(repo: string, expectedSha?: string): Promise<void>;
    compatible(repo: string, sha: string): Promise<void>;
    workspace(repo: string, path: string, sha: string): Promise<void>;
    removeWorkspace(repo: string, path: string, ownedRoot: string): Promise<void>;
    changes(repo: string, base: string, candidate?: string): Promise<ChangeSet>;
    snapshot(repo: string, base: string, runId: string): Promise<string>;
    patch(repo: string, base: string, sha: string): Promise<string>;
    assertNoNestedGit(path: string): Promise<void>;
}
