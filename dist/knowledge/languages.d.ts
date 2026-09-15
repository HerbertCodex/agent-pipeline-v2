import { languageProfileSchema, type LanguageProfile } from '../domain/knowledge.js';
export { languageProfileSchema, type LanguageProfile };
export declare const builtinLanguages: LanguageProfile[];
/** Extensions that describe documentation, data, configuration or assets rather than code units. */
export declare const nonSourceExtensions: Set<string>;
export declare function extensionOf(path: string): string | null;
/** Test/fixture files by generic naming conventions shared across ecosystems. */
export declare function isTestPath(path: string): boolean;
export interface CompiledLanguage {
    profile: LanguageProfile;
    declarations: {
        kind: string;
        regex: RegExp;
        exported: LanguageProfile['declarations'][number]['exported'];
    }[];
}
/** Project profiles replace built-in profiles with the same id, then claim their extensions first. */
export declare function resolveLanguages(custom?: readonly LanguageProfile[]): CompiledLanguage[];
export declare function isExported(rule: CompiledLanguage['declarations'][number]['exported'], name: string, groups: Record<string, string | undefined>): boolean;
