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
        qualityReview: string;
    };
    setup: {
        command: string[];
        timeoutMs: number;
        passEnv: string[];
    }[];
    gates: ({
        id: string;
        covers: string[];
        command: string[];
        lanes: string[];
        cacheTtlMs: number;
        mandatory?: never;
    } | {
        id: string;
        command: string[];
        mandatory: boolean;
        cacheTtlMs: number;
        covers?: never;
        lanes?: never;
    })[];
    concurrency: number;
    maxRepairAttempts: number;
};
