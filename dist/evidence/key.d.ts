import { type Gate } from '../domain/contracts.js';
export declare function executableIdentity(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{
    path: string;
    sha256: string;
}>;
export declare function environmentIdentity(id: string, env: NodeJS.ProcessEnv, extra: unknown): string;
export declare function proofKey(input: {
    repository: string;
    baseSha: string;
    candidateSha: string;
    taskHash: string;
    configHash: string;
    environmentHash: string;
    workspace: string;
    gate: Gate;
    dependencyKeys: string[];
    executable: {
        path: string;
        sha256: string;
    };
}): string;
