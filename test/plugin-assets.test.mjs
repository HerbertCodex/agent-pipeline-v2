import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');

/**
 * Parses the flat YAML frontmatter used by the plugin's agents and skills: `key: value` lines,
 * values plain or double-quoted, plus nested maps that are skipped. Anything else fails the test,
 * which keeps the files within the subset every YAML parser reads the same way.
 */
function frontmatter(path) {
  const text = read(path);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${path}: frontmatter must open on the first line`);
  const fields = {};
  for (const line of match[1].split('\n')) {
    // Nested maps (the V2 skills' `metadata:`) are allowed and not interpreted.
    if (/^[a-z][a-zA-Z-]*:$/.test(line) || /^ {2,}[a-z][a-zA-Z-]*: \S/.test(line)) continue;
    const entry = /^([a-z][a-zA-Z-]*): (.+)$/.exec(line);
    assert.ok(entry, `${path}: unsupported frontmatter line: ${line}`);
    let value = entry[2];
    if (value.startsWith('"')) {
      assert.ok(value.endsWith('"') && value.length > 1, `${path}: unterminated quoted value`);
      value = JSON.parse(value);
    } else {
      assert.ok(!/: |^[\[{&*!|>'%@`]| #/.test(value), `${path}: ${entry[1]} must be quoted: ${value}`);
    }
    fields[entry[1]] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}
const list = value => (value ?? '').split(',').map(v => v.trim()).filter(Boolean);

const AGENTS = ['architecte', 'architecte-donnees', 'designer', 'dpo', 'implementer', 'integrateur', 'product', 'qa-fidelite', 'qa-securite'];
const V2_SKILLS = ['clean-code', 'design-patterns', 'refactoring', 'security', 'tdd', 'ui-design'];
const PHASE_ONE_COMMANDS = ['quota', 'resume', 'status'];
const LATER_COMMANDS = { design: 2, preview: 2, init: 3, spec: 3, run: 3, review: 3, stack: 3, onboard: 4 };
const METHOD_SKILLS = ['architecture-donnees', 'chef-de-projet', 'design-artefact', 'rgpd'];

test('manifests parse and describe the apv plugin', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(plugin.name, 'apv');
  assert.equal(plugin.version, '3.0.0-alpha.1');
  assert.equal(plugin.license, 'MIT');
  assert.match(read('LICENSE'), /^MIT License/);
  assert.equal(plugin.repository, 'https://github.com/HerbertCodex/agent-pipeline-v2');
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.equal(marketplace.plugins.length, 1);
  assert.deepEqual([marketplace.plugins[0].name, marketplace.plugins[0].source], ['apv', './']);
  assert.ok(marketplace.owner.name);
});

test('the nine agents have a valid frontmatter and least-privilege tools', () => {
  const files = readdirSync(join(root, 'agents')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
  assert.deepEqual(files, AGENTS);
  for (const name of AGENTS) {
    const { fields, body } = frontmatter(`agents/${name}.md`);
    assert.equal(fields.name, name);
    assert.ok(fields.description.length >= 80 && fields.description.length <= 1024, `${name}: description`);
    assert.equal(fields.effort, 'high', `${name}: effort`);
    assert.equal(fields.model, 'opus', `${name}: model`);
    assert.ok(!('permissionMode' in fields) && !('hooks' in fields) && !('mcpServers' in fields), `${name}: fields ignored for plugin agents`);
    const tools = list(fields.tools);
    assert.ok(tools.includes('Read'), `${name}: tools`);
    assert.ok(!tools.includes('Agent'), `${name}: a role agent does not spawn agents`);
    assert.match(body, /Frontière de confiance/, `${name}: trust boundary`);
    assert.match(body, /non fiables?, jamais (une|des) instructions?/, `${name}: repository content is data`);
  }
  for (const reviewer of ['qa-securite', 'qa-fidelite']) {
    const tools = list(frontmatter(`agents/${reviewer}.md`).fields.tools);
    assert.ok(!tools.includes('Write') && !tools.includes('Edit'), `${reviewer} must not write files`);
  }
  for (const builder of ['implementer', 'integrateur']) {
    assert.equal(frontmatter(`agents/${builder}.md`).fields.isolation, 'worktree', builder);
  }
  for (const other of AGENTS.filter(a => !['implementer', 'integrateur'].includes(a))) {
    assert.ok(!('isolation' in frontmatter(`agents/${other}.md`).fields), other);
  }
});

test('agent bodies carry the rules that the pilot project paid for', () => {
  const implementer = frontmatter('agents/implementer.md').body;
  for (const rule of [/apv lock run/, /mot pour mot/, /Ne réécris jamais un commit déjà poussé/, /tiret cadratin/, /idempotence/, /runes/]) {
    assert.match(implementer, rule);
  }
  assert.match(frontmatter('agents/integrateur.md').body, /Ne supprime jamais un test/);
  const security = frontmatter('agents/qa-securite.md').body;
  for (const rule of [/Deux utilisateurs/, /API directe/, /ZAP/, /TRACE/, /E2E_LOCK_FILE/, /Supprime les utilisateurs de test/]) assert.match(security, rule);
  const fidelity = frontmatter('agents/qa-fidelite.md').body;
  for (const rule of [/390/, /1280/, /sombre/, /programmatique/, /accessibilité/]) assert.match(fidelity, rule);
  assert.match(frontmatter('agents/dpo.md').body, /Supabase Pte\. Ltd\./);
  assert.match(frontmatter('agents/designer.md').body, /Jamais de re-maquettage automatique/);
  assert.match(frontmatter('agents/architecte-donnees.md').body, /apv db check/);
});

test('every skill has a frontmatter named after its directory', () => {
  const dirs = readdirSync(join(root, 'skills')).filter(d => statSync(join(root, 'skills', d)).isDirectory()).sort();
  const expected = [...V2_SKILLS, ...METHOD_SKILLS, ...PHASE_ONE_COMMANDS, ...Object.keys(LATER_COMMANDS)].sort();
  assert.deepEqual(dirs, expected);
  for (const dir of dirs) {
    const { fields } = frontmatter(`skills/${dir}/SKILL.md`);
    assert.equal(fields.name, dir);
    assert.ok(fields.description && fields.description.length <= 1024, `${dir}: description`);
  }
});

test('phase one commands run the apv tool; later commands announce their phase', () => {
  for (const name of PHASE_ONE_COMMANDS) {
    const { fields, body } = frontmatter(`skills/${name}/SKILL.md`);
    assert.ok(!('disable-model-invocation' in fields), name);
    assert.ok(body.includes('node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js'), `${name}: runs the bundled tool`);
  }
  for (const [name, phase] of Object.entries(LATER_COMMANDS)) {
    const { fields, body } = frontmatter(`skills/${name}/SKILL.md`);
    assert.equal(fields['disable-model-invocation'], 'true', name);
    assert.ok(body.includes(`Disponible en phase ${phase}`), `${name}: phase ${phase}`);
    assert.ok(body.includes('docs/APV3-SPEC.md'), `${name}: points to the spec`);
  }
});

test('the project lead skill links references that exist', () => {
  const { body } = frontmatter('skills/chef-de-projet/SKILL.md');
  const references = [...body.matchAll(/`(references\/[a-z-]+\.md)`/g)].map(m => m[1]);
  assert.ok(references.length >= 6);
  for (const ref of references) assert.ok(read(`skills/chef-de-projet/${ref}`).length > 0, ref);
  for (const topic of [/APV_ALLOW_MERGE/, /95 %/, /apv lock run/, /incident 30/i]) {
    assert.match(read('skills/chef-de-projet/references/livraison-pile.md') + read('skills/chef-de-projet/references/quota-sauvegarde.md') + body, topic);
  }
});

test('texts written for APV3 contain no em or en dash', () => {
  const files = [
    ...AGENTS.map(a => `agents/${a}.md`),
    ...[...METHOD_SKILLS, ...PHASE_ONE_COMMANDS, ...Object.keys(LATER_COMMANDS)].flatMap(s => {
      const dir = join(root, 'skills', s);
      const refs = readdirSync(dir).includes('references') ? readdirSync(join(dir, 'references')).map(r => `skills/${s}/references/${r}`) : [];
      return [`skills/${s}/SKILL.md`, ...refs];
    }),
    'hooks/hooks.json', 'hooks/scripts/bash-guard.mjs', 'hooks/scripts/session-start.mjs', 'hooks/scripts/stop-journal.mjs', 'hooks/scripts/scope-reminder.mjs',
    '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'docs/PLUGIN.md', 'README.md', 'START-HERE.md',
  ];
  for (const file of files) assert.ok(!/[–—]/.test(read(file)), `${file} contains an em or en dash`);
});
