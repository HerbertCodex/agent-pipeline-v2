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
    events(id: string): RunEvent[];
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
    documentEvent(id: string, type: string, data: Record<string, unknown>): void;
    documentEvents(id: string): {
        seq: number;
        at: number;
        type: string;
        data: unknown;
    }[];
    acquireDocument(id: string): string;
    releaseDocument(id: string, token: string): void;
    startDocumentChild(id: string, pid: number): string;
    finishDocumentChild(id: string): void;
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
