import { type RoleName, type SkillsConfig } from '../domain/knowledge.js';
export declare const packageRoot: string;
/** Only read bounded regular package files. No glob expansion, executable config or user-selected roots. */
export declare function asset(path: string): string;
export declare function readRole(role: RoleName): {
    id: RoleName;
    path: string;
    instructions: string;
    sha256: string;
};
export declare function catalog(): {
    resources: {
        path: string;
        sha256: string;
    }[];
    path: string;
    description: string;
    instructions: string;
    sha256: string;
    bundleHash: string;
    id: "clean-code" | "design-patterns" | "refactoring" | "security" | "tdd" | "ui-design";
    roles: ("setup" | "product" | "implementer" | "qa")[];
    projectTypes: ("unknown" | "backend" | "frontend" | "mobile" | "fullstack" | "library")[];
    keywords: string[];
}[];
export interface Guidance {
    role: ReturnType<typeof readRole>;
    skills: {
        id: string;
        description: string;
        instructions: string;
        sha256: string;
        bundleHash: string;
        referenceFiles: string[];
    }[];
    skipped: {
        id: string;
        reason: string;
    }[];
    bytes: number;
    digest: string;
    note: string;
}
/** Deterministic selection; no model call and no workflow node. Full references are not inlined. */
export declare function guidanceFor(role: RoleName, input?: SkillsConfig, taskText?: string): Guidance;
export declare function guidanceAudit(g: Guidance): {
    digest: string;
    role: {
        id: "setup" | "product" | "implementer" | "qa";
        sha256: string;
    };
    bytes: number;
    skills: {
        id: string;
        sha256: string;
        bundleHash: string;
    }[];
    skipped: {
        id: string;
        reason: string;
    }[];
};
export declare function installedAssets(input: SkillsConfig): {
    path: string;
    content: string;
}[];
