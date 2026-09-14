import { s, type Infer } from './schema.js';
export const roleNames = ['setup', 'product', 'implementer', 'qa'] as const;
export type RoleName = typeof roleNames[number];
export const skillNames = ['clean-code', 'design-patterns', 'refactoring', 'security', 'tdd', 'ui-design'] as const;
export const projectTypes = ['unknown', 'backend', 'frontend', 'mobile', 'fullstack', 'library'] as const;
export const skillsSchema = s.object({
  // Old configurations opt into no new skills. New onboarding proposes the catalog explicitly.
  enabled: s.default(s.array(s.enum(skillNames), 0, skillNames.length), []),
  projectType: s.default(s.enum(projectTypes), 'unknown'),
  maxContextBytes: s.default(s.number(1024, 65536), 16000),
});
export type SkillsConfig = Infer<typeof skillsSchema>;
