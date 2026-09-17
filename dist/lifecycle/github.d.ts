import type { Lifecycle } from './service.js';
export interface TransportRequest {
    command: string[];
    cwd: string;
    input?: string;
    signal?: AbortSignal;
}
export type ForgeTransport = (request: TransportRequest) => Promise<string>;
export declare function githubRepository(url: string): string;
export interface PublishOptions {
    repository: string;
    remote: string;
    branch: string;
    base: string;
    confirmPush: boolean;
    confirmPr: boolean;
    /** Open the draft PR before approval, so the operator reads the candidate on the forge. */
    forReview?: boolean;
    signal?: AbortSignal;
}
export declare function publishSpec(life: Lifecycle, id: string, options: PublishOptions, transport?: ForgeTransport): Promise<import("../persistence/store.js").Document<import("./contracts.js").SpecRecord>>;
export declare function syncSpec(life: Lifecycle, id: string, signal?: AbortSignal, transport?: ForgeTransport): Promise<import("../persistence/store.js").Document<import("./contracts.js").SpecRecord>>;
