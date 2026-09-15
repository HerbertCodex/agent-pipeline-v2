import { s } from './schema.js';
export const roleNames = ['setup', 'product', 'implementer', 'qa'];
export const skillNames = ['clean-code', 'design-patterns', 'refactoring', 'security', 'tdd', 'ui-design'];
export const projectTypes = ['unknown', 'backend', 'frontend', 'mobile', 'fullstack', 'library'];
export const skillsSchema = s.object({
    // Old configurations opt into no new skills. New onboarding proposes the catalog explicitly.
    enabled: s.default(s.array(s.enum(skillNames), 0, skillNames.length), []),
    projectType: s.default(s.enum(projectTypes), 'unknown'),
    maxContextBytes: s.default(s.number(1024, 65536), 16000),
});
/** How a declaration line decides whether the symbol is part of the module's public surface. */
export const exportRules = ['always', 'marker', 'capitalized', 'not-underscore', 'unless-hidden'];
/**
 * A declarative language profile. The controller knows languages by file extension and
 * declaration grammar only; it never encodes a framework. Unknown technologies fall back to
 * file-level units, and projects can add or override profiles in `knowledge.languages`.
 *
 * `pattern` is a JavaScript regular expression applied to one source line. It must capture the
 * symbol in a named group `name`; optional groups `export` (rule `marker`) and `hidden`
 * (rule `unless-hidden`) drive public-surface detection. `prefilter` is a POSIX ERE handed
 * to `git grep` so that only candidate lines are read.
 */
export const languageProfileSchema = s.object({
    id: s.string(1, 40, /^[a-z0-9][a-z0-9-]*$/),
    extensions: s.array(s.string(1, 20, /^[A-Za-z0-9][A-Za-z0-9._-]*$/), 1, 30),
    prefilter: s.string(1, 500),
    declarations: s.array(s.object({
        kind: s.string(1, 30, /^[a-z][a-z-]*$/),
        pattern: s.string(1, 500),
        exported: s.enum(exportRules),
    }), 1, 30),
});
export const knowledgeSchema = s.object({
    // Empty means built-in language profiles plus file-level units for every other text source.
    languages: s.default(s.array(languageProfileSchema, 0, 30), []),
});
//# sourceMappingURL=knowledge.js.map