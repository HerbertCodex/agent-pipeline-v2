import { type Infer } from '../domain/schema.js';
export declare const PREVIEW_STATE = ".apv/state/preview.json";
export declare const PREVIEW_LOG = ".apv/state/preview.log";
export declare const PREVIEW_PREVIOUS_LOG = ".apv/state/preview.prev.log";
export declare const PREVIEW_UPDATE_LOG = ".apv/state/preview-update.log";
/**
 * Record of the preview, kept after a stop or a failed update: `pid` null means no server of ours runs,
 * `branch` and `commit` stay those of the last preview that started (the base of « what changed »).
 */
export declare const previewStateSchema: import("../domain/schema.js").Schema<{
    readonly version: 1;
    readonly pid: number | null;
    readonly procStart: string | null;
    readonly port: number;
    readonly host: string | null;
    readonly branch: string;
    readonly commit: string;
    readonly startedAt: string;
    readonly stoppedAt: string | null;
    readonly url: string;
    readonly healthUrl: string;
    readonly dir: string;
    readonly lastFailure: {
        readonly step: string;
        readonly at: string;
        readonly branch: string;
        readonly commit: string;
        readonly message: string;
    } | null;
}>;
export type PreviewState = Infer<typeof previewStateSchema>;
export declare function readPreviewState(repo: string): PreviewState | null;
export declare function writePreviewState(repo: string, state: PreviewState): void;
