import type { GateReceipt, Run, RunEvent } from '../domain/contracts.js';
export declare function processAlive(pid: number): boolean;
export interface Document<T> {
    id: string;
    kind: string;
    version: number;
    data: T;
}
export declare class Store {
    readonly root: string;
    onProgress: ((source: 'run' | 'lifecycle', id: string, type: string, data: Record<string, unknown>) => void) | undefined;
    private readonly db;
    constructor(root: string);
    close(): void;
    private transaction;
    create(run: Run): void;
    get(id: string): Run;
    list(): Run[];
    save(run: Run, type: string, data?: Record<string, unknown>): void;
    event(runId: string, type: string, data: Record<string, unknown>): void;
    events(id: string, types?: readonly string[]): RunEvent[];
    acquire(id: string): string;
    acquireExecution(id: string): string;
    releaseExecution(id: string, token: string): void;
    release(id: string, token: string): void;
    startChild(runId: string, pid: number): string;
    finishChild(id: string): void;
    activeProcesses(id: string): {
        pid: number;
        alive: boolean;
    }[];
    recover(id: string, confirmed: boolean): void;
    createDocument<T>(kind: string, data: T): Document<T>;
    document<T>(id: string, kind: string): Document<T>;
    documents<T>(kind: string): Document<T>[];
    saveDocument<T>(doc: Document<T>, type: string, event?: Record<string, unknown>): void;
    /** Removes one lifecycle document and its own history. Refused while a lease or a live process exists. */
    deleteDocument(id: string, kind: string): void;
    /** Removes one run and everything that references it. Refused while a lease or a live process exists. */
    deleteRun(id: string): void;
    documentEvent(id: string, type: string, data: Record<string, unknown>): void;
    /** Latest sequence numbers of both event streams, so a live reader starts from "now". */
    eventCursor(): {
        runs: number;
        documents: number;
    };
    /** Events of every run and document after a cursor, oldest first, bounded. */
    eventsSince(cursor: {
        runs: number;
        documents: number;
    }, limit?: number): {
        cursor: {
            runs: number;
            documents: number;
        };
        events: {
            source: 'run' | 'lifecycle';
            id: string;
            seq: number;
            at: number;
            type: string;
            data: unknown;
        }[];
    };
    documentEvents(id: string, types?: readonly string[]): {
        seq: number;
        at: number;
        type: string;
        data: unknown;
    }[];
    acquireDocument(id: string): string;
    releaseDocument(id: string, token: string): void;
    startDocumentChild(id: string, pid: number): string;
    finishDocumentChild(id: string): void;
    /** True while a controller on this host holds the document's lease: a draft, refinement or run is in progress. */
    documentControllerAlive(id: string): boolean;
    documentProcesses(id: string): {
        pid: number;
        alive: boolean;
    }[];
    recoverDocument(id: string, confirmed: boolean): void;
    addReceipt(receipt: GateReceipt): void;
    seal(receipt: GateReceipt, ttlMs: number): void;
    verifyReceipt(receipt: GateReceipt): void;
    cached(key: string, now?: number): GateReceipt | null;
}
