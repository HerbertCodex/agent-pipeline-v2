#!/usr/bin/env node
export declare const exampleConfig: {
    schemaVersion: number;
    executionMode: string;
    environment: {
        id: string;
    };
    agent: {
        type: string;
        passEnv: string[];
    };
    workflow: {
        planningMode: string;
    };
    setup: {
        command: string[];
        timeoutMs: number;
        passEnv: string[];
    }[];
    gates: ({
        id: string;
        command: string[];
        lanes: string[];
        cacheTtlMs: number;
        mandatory?: never;
    } | {
        id: string;
        command: string[];
        mandatory: boolean;
        cacheTtlMs: number;
        lanes?: never;
    })[];
    concurrency: number;
    maxRepairAttempts: number;
};
