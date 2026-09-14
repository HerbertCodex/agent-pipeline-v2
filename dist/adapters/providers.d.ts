import { type AgentConfig } from '../domain/contracts.js';
export declare const nativeProviders: readonly ["codex", "claude"];
export declare function providerProfile(name: string): AgentConfig;
export declare function executableAvailability(agent: AgentConfig, cwd: string, pathEnv?: string): {
    executable: string;
    available: boolean;
    path: string;
    authentication: string;
} | {
    executable: string;
    available: boolean;
    path: null;
    authentication: string;
};
export declare const providerSupport: {
    id: string;
    integration: string;
    roles: string[];
    contractTested: boolean;
    authenticatedPilot: string;
    permissionModel: string;
}[];
