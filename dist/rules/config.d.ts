import { type Infer } from '../domain/schema.js';
/**
 * The rules the tool enforces before a merge (`apv rules check`, `apv stack merge`, `apv stack batch --merge`), docs/REGLES.md.
 * Every rule applies to every project: none can be switched off by the configuration. The only way past a refusal is
 * the correction it asks for, or a waiver the operator writes himself (src/rules/operator.ts).
 */
export declare const MERGE_RULES: readonly ["preuve", "instable", "relecture", "captures", "controles", "maquette"];
export type MergeRule = typeof MERGE_RULES[number];
/** What each rule protects, in a few words (texts of the refusals and of docs/REGLES.md). */
export declare const RULE_TITLES: Readonly<Record<MergeRule, string>>;
export declare const CAPTURE_VIEWPORTS: readonly ["desktop", "phone", "tablet"];
export type CaptureViewport = typeof CAPTURE_VIEWPORTS[number];
export declare const CAPTURE_THEMES: readonly ["light", "dark"];
export type CaptureTheme = typeof CAPTURE_THEMES[number];
/** Captures required by default for a change of interface: computer and phone, light and dark theme. */
export declare const DEFAULT_CAPTURE_VIEWPORTS: readonly CaptureViewport[];
export declare const DEFAULT_CAPTURE_THEMES: readonly CaptureTheme[];
export declare const rulesSchema: import("../domain/schema.js").Schema<{
    readonly captures: {
        readonly viewports: ("phone" | "desktop" | "tablet")[] | undefined;
        readonly themes: ("light" | "dark")[] | undefined;
    } | undefined;
    readonly requiredGates: {
        readonly id: string;
        readonly command: string[];
    }[] | undefined;
    readonly screens: string[] | undefined;
}>;
export type RulesSection = Infer<typeof rulesSchema>;
export interface RequiredGate {
    id: string;
    command: string[];
    source: 'apv' | 'config';
}
export interface RulesSettings {
    captures: {
        viewports: CaptureViewport[];
        themes: CaptureTheme[];
    };
    requiredGates: RequiredGate[];
    screens: string[];
}
/** Effective settings of a `rules` section: the defaults, completed by what the project adds. Throws a CONFIG error. */
export declare function rulesSettings(section: RulesSection | undefined, builtIn: readonly RequiredGate[]): RulesSettings;
