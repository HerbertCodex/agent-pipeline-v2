/** Who holds (or waits for) a lock. `pid` null means the lease alone protects the lock. */
export interface LockOwner {
    pid: number | null;
    host: string;
    label: string;
}
export interface LockRecord {
    version: 1;
    resource: string;
    owner: LockOwner;
    token: string;
    acquiredAt: string;
    expiresAt: string;
    heartbeatAt: string;
    ttlSeconds: number;
    purpose: string;
}
export type StaleReason = 'expired' | 'owner_dead' | 'corrupt';
export interface LockSnapshot {
    exists: boolean;
    raw: string;
    record: LockRecord | null;
    mtimeMs: number;
}
export interface Waiter {
    file: string;
    owner: LockOwner;
    enqueuedAt: string;
}
export type AcquireResult = {
    ok: true;
    record: LockRecord;
    takeover: {
        reason: StaleReason;
        previous: LockRecord | null;
    } | null;
} | {
    ok: false;
    holder: LockRecord | null;
    timedOut: boolean;
    aborted: boolean;
    position: number;
};
export interface WaitInfo {
    holder: LockRecord | null;
    position: number;
    queueLength: number;
}
export type ReleaseResult = {
    status: 'released' | 'forced';
    previous: LockRecord | null;
} | {
    status: 'not_held';
} | {
    status: 'refused';
    holder: LockRecord | null;
};
export interface LockEvent {
    event: string;
    resource: string;
    [key: string]: unknown;
}
export interface LockStoreOptions {
    host?: string;
    /** Base polling interval in ms (jitter of plus or minus 50 % is applied). */
    pollMs?: number;
    /** Age after which a waiter ticket that stopped refreshing is removed. */
    waiterStaleMs?: number;
    /** Age after which an unreadable lock file (crash between create and write) is stale. */
    initGraceMs?: number;
}
export declare function defaultLockDir(env: NodeJS.ProcessEnv): string;
/** Maps a resource name to a safe file name. Distinct names may share a lock after sanitizing (safe side). */
export declare function sanitizeResource(resource: string): string;
/** Parses `900`, `900s`, `15m`, `2h` into seconds. */
export declare function parseDuration(value: string, name: string): number;
export declare function isPidAlive(pid: number): boolean;
export declare function parseRecord(raw: string): LockRecord | null;
export declare class LockStore {
    readonly dir: string;
    readonly host: string;
    readonly pollMs: number;
    readonly waiterStaleMs: number;
    readonly initGraceMs: number;
    constructor(dir: string, options?: LockStoreOptions);
    lockPath(resource: string): string;
    queueDir(resource: string): string;
    private mutexPath;
    get logPath(): string;
    /** Appends one JSON line to the audit log (takeovers, forced releases, pruned waiters). */
    log(entry: LockEvent): void;
    read(resource: string): LockSnapshot;
    /** Stale when expired, when the owner process is gone on this host, or unreadable past the grace period. */
    staleness(snapshot: LockSnapshot, now?: number): StaleReason | null;
    /** Short critical section shared by every writer that removes or rewrites an existing lock file. */
    private withMutex;
    /** One attempt, no queue. Takes over a stale lock (logged) before trying an exclusive create. */
    tryAcquire(resource: string, owner: LockOwner, ttlSeconds: number, purpose?: string): Promise<AcquireResult>;
    /** Extends the lease. Returns false when the lock is no longer ours (taken over or force released). */
    renew(resource: string, token: string, ttlSeconds: number): Promise<boolean>;
    /** Only the owner (token, or same live pid on this host) may release, unless forced with a reason. */
    release(resource: string, options?: {
        token?: string;
        callerPids?: number[];
        force?: boolean;
        reason?: string;
    }): Promise<ReleaseResult>;
    enqueue(resource: string, owner: LockOwner): string;
    /** Refreshes a waiter ticket. False when it was pruned (the caller must enqueue again). */
    touch(ticket: string): boolean;
    dequeue(ticket: string): void;
    /** Live waiters in FIFO order. Tickets of dead processes or that stopped refreshing are removed. */
    waiters(resource: string): Waiter[];
    /** Waits in the FIFO queue until the lock is ours, `waitSeconds` elapse, or `signal` aborts. */
    acquire(resource: string, options: {
        owner: LockOwner;
        ttlSeconds: number;
        waitSeconds: number;
        purpose?: string;
        signal?: AbortSignal;
        onWait?: (info: WaitInfo) => void;
        onRequeue?: () => void;
    }): Promise<AcquireResult>;
    /** Every lock and queue present in the directory. */
    list(): {
        resource: string;
        snapshot: LockSnapshot;
        stale: StaleReason | null;
        waiters: Waiter[];
    }[];
}
