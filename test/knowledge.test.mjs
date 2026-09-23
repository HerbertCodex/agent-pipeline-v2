import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { skillNames, skillsSchema, languageProfileSchema } from '../dist/domain/knowledge.js';
import { configIssues } from '../dist/config/load.js';

// The six V2 skills ship unchanged in the plugin (spec, section 7): their metadata and the files they
// reference must stay real, whatever the V2 controller used to do with them.
for (const id of skillNames) test(`portable skill ${id} has valid metadata and real relative references`, () => {
  const file = new URL(`../skills/${id}/SKILL.md`, import.meta.url);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^---\nname: /);
  assert.match(text, new RegExp(`^name: ${id}$`, 'm'));
  assert.match(text, /^description: \S/m);
  for (const link of text.matchAll(/\]\(((?:references|assets)\/[^)#]+)\)/g))
    assert.ok(existsSync(new URL(`../skills/${id}/${link[1]}`, import.meta.url)), `${id} references a missing ${link[1]}`);
});

test('skills stay disabled by default; duplicate-free known ids only', () => {
  assert.deepEqual(skillsSchema.parse({}).enabled, []);
  assert.throws(() => skillsSchema.parse({ enabled: ['invented'] }));
  const { issues } = configIssues({ skills: { enabled: ['tdd', 'invented'], projectType: 'nowhere' } });
  assert.equal(issues.length, 2, JSON.stringify(issues));
});

test('language profiles are declarative and refuse unknown export rules', () => {
  const profile = { id: 'toy', extensions: ['toy'], prefilter: '^def ', declarations: [{ kind: 'function', pattern: '^def (?<name>\\w+)', exported: 'always' }] };
  assert.equal(languageProfileSchema.parse(profile).id, 'toy');
  assert.throws(() => languageProfileSchema.parse({ ...profile, declarations: [{ ...profile.declarations[0], exported: 'sometimes' }] }));
});
