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
//# sourceMappingURL=knowledge.js.map