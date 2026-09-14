import { type Infer } from './schema.js';
export declare const roleNames: readonly ["setup", "product", "implementer", "qa"];
export type RoleName = typeof roleNames[number];
export declare const skillNames: readonly ["clean-code", "design-patterns", "refactoring", "security", "tdd", "ui-design"];
export declare const projectTypes: readonly ["unknown", "backend", "frontend", "mobile", "fullstack", "library"];
export declare const skillsSchema: import("./schema.js").Schema<{
    readonly enabled: ("clean-code" | "design-patterns" | "refactoring" | "security" | "tdd" | "ui-design")[];
    readonly projectType: "unknown" | "backend" | "frontend" | "mobile" | "fullstack" | "library";
    readonly maxContextBytes: number;
}>;
export type SkillsConfig = Infer<typeof skillsSchema>;
