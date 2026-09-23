import { DEFAULT_BRANCH, type PreviewConfig } from './config.js';
import { Redactor } from './env.js';
import { type PreviewState } from './state.js';
/**
 * Name of the lease lock taken by `update` and `stop` (docs/LOCKS.md): one per project, so that the
 * previews of two projects update side by side while two agents of one project take turns. The project
 * is the main working tree (git common directory), so that every worktree of a project shares its lock.
 */
export declare function previewLock(repo: string): string;
/** Marker file that lets `update` empty the preview directory: never a directory it did not create. */
export declare const DIR_MARKER = ".apv-preview";
/** Most commits listed under « what changed ». */
export declare const MAX_CHANGES = 20;
export interface PreviewContext {
    repo: string;
    env: NodeJS.ProcessEnv;
    /** Progress lines (stderr of the command). */
    progress: (s: string) => void;
}
export interface LoadedPreview {
    config: PreviewConfig;
    dir: string;
    envFile: string | null;
    vars: Record<string, string>;
    redactor: Redactor;
}
/**
 * The `preview` section of `.apv/config.json` with its paths resolved and its env file read. `strict`
 * (update) requires the env file; status and logs only use it to mask values and tolerate its absence.
 */
export declare function loadPreview(repo: string, env: NodeJS.ProcessEnv, strict?: boolean): LoadedPreview;
/** Full commit of a branch (or any commit-ish). An option-like name is refused before reaching git. */
export declare function resolveCommit(repo: string, ref: string): string;
/** `git log --oneline previous..commit`, capped; null when the previous commit is unknown to the repository. */
export declare function changesSince(repo: string, previous: string, commit: string): {
    lines: string[];
    total: number;
} | null;
export type UpdateResult = {
    ok: true;
    url: string;
    branch: string;
    commit: string;
    pid: number;
    previousCommit: string | null;
    previousBranch: string | null;
    changes: {
        lines: string[];
        total: number;
    } | null;
    logFile: string;
    updateLog: string;
} | {
    ok: false;
    step: string;
    message: string;
    excerpt: string;
    updateLog: string;
    logFile: string;
    branch: string;
    commit: string | null;
};
/**
 * Holds the preview lease lock of the project (`preview:<project>`) around `body` (renewed while it runs, released whatever happens).
 * Re-entrant through APV_LOCK_HELD, like `apv lock run`.
 */
export declare function withPreviewLock<T>(ctx: PreviewContext, waitSeconds: number, purpose: string, body: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T>;
/**
 * `apv preview update`: stops our server, copies the branch with git archive into a fresh directory,
 * runs install, migrate, build and seed, starts the server detached and waits for its health check.
 * Must run under the preview lock of the project (see withPreviewLock).
 */
export declare function updatePreview(ctx: PreviewContext, loaded: LoadedPreview, branch: string, lockEnv: NodeJS.ProcessEnv): Promise<UpdateResult>;
export interface StopResult {
    stopped: boolean;
    pid: number | null;
}
/** `apv preview stop`: stops our server (whole process group) and keeps the record of the last preview. */
export declare function stopPreview(repo: string): Promise<StopResult>;
export interface StatusResult {
    running: boolean;
    alive: boolean;
    healthy: boolean;
    state: PreviewState | null;
    uptimeSeconds: number | null;
}
/** `apv preview status`: running means our process group is alive and answers its health check. */
export declare function previewStatus(repo: string): Promise<StatusResult>;
/** Last lines of the server log (or of the update log), with env values masked. */
export declare function previewLogs(repo: string, redactor: Redactor, lines: number, which: 'server' | 'update'): {
    file: string;
    text: string | null;
};
export { DEFAULT_BRANCH };
