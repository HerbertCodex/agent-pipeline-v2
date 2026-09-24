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

const AGENTS = ['architecte', 'architecte-donnees', 'critique-design', 'designer', 'dpo', 'implementer', 'integrateur', 'product', 'qa-fidelite', 'qa-securite'];
const V2_SKILLS = ['clean-code', 'design-patterns', 'refactoring', 'security', 'tdd', 'ui-design'];
const PHASE_ONE_COMMANDS = ['quota', 'resume', 'status'];
const PHASE_TWO_COMMANDS = ['design', 'preview'];
const PHASE_THREE_COMMANDS = ['init', 'review', 'run', 'spec', 'stack'];
// Commands with effects the operator must trigger himself: never loaded by the model on its own.
const OPERATOR_ONLY_COMMANDS = ['init', 'onboard', 'run', 'stack'];
const PHASE_FOUR_COMMANDS = ['onboard'];
const LATER_COMMANDS = {};
const METHOD_SKILLS = ['architecture-donnees', 'chef-de-projet', 'design-artefact', 'rgpd'];

test('manifests parse and describe the apv plugin', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(plugin.name, 'apv');
  assert.equal(plugin.version, '3.0.0-alpha.3');
  assert.equal(plugin.license, 'MIT');
  assert.match(read('LICENSE'), /^MIT License/);
  assert.equal(plugin.repository, 'https://github.com/HerbertCodex/agent-pipeline-v2');
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.equal(marketplace.plugins.length, 1);
  assert.deepEqual([marketplace.plugins[0].name, marketplace.plugins[0].source], ['apv', './']);
  assert.ok(marketplace.owner.name);
});

test('the ten agents have a valid frontmatter and least-privilege tools', () => {
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
  for (const reviewer of ['qa-securite', 'qa-fidelite', 'critique-design']) {
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
  const expected = [...V2_SKILLS, ...METHOD_SKILLS, ...PHASE_ONE_COMMANDS, ...PHASE_TWO_COMMANDS, ...PHASE_THREE_COMMANDS, ...PHASE_FOUR_COMMANDS, ...Object.keys(LATER_COMMANDS)].sort();
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

test('phase two commands: the design loop and the live preview run the apv tool', () => {
  for (const name of PHASE_TWO_COMMANDS) {
    const { fields, body } = frontmatter(`skills/${name}/SKILL.md`);
    assert.ok(!('disable-model-invocation' in fields), `${name}: invocable`);
    assert.ok(!body.includes('Disponible en phase'), `${name}: no longer a stub`);
    assert.ok(fields['allowed-tools'].includes(`Bash(node \${CLAUDE_PLUGIN_ROOT}/dist/cli.js ${name}*)`), `${name}: allowed to run apv ${name}`);
    assert.ok(fields['argument-hint'], `${name}: argument hint`);
  }
  const design = frontmatter('skills/design/SKILL.md');
  assert.ok(design.fields['allowed-tools'].split(' ').includes('Artifact'), 'design publishes with the Artifact tool');
  for (const rule of [/Charge la compétence `artifact-design`/, /clair et sombre/, /390 px et 1280 px/, /un changement à la fois/, /republie à la même adresse/,
    /Tu ne déclares jamais une maquette validée/, /apv design register .*--quote/s, /référence absolue/, /mot pour mot/, /seul survol/, /Densité/, /Codes couleur cohérents/,
    /tiret cadratin/, /promesse risquée/, /Noms fictifs/, /Mode sombre conçu, pas inversé/, /apv design check/]) assert.match(design.body, rule);
  const preview = frontmatter('skills/preview/SKILL.md').body;
  for (const rule of [/apv preview update/, /apv preview status/, /apv preview logs/, /apv preview stop/, /Après chaque livraison/, /Sur demande de l'opérateur/, /Après une reprise/,
    /adresse/, /compte de démo/i, /ce qui a changé/i, /N'arrête jamais un processus, un conteneur ou une pile que ce projet n'a pas lancé/, /docs\/PREVIEW\.md/]) assert.match(preview, rule);
  assert.match(frontmatter('agents/qa-fidelite.md').body, /apv design list --screen/);
  assert.match(frontmatter('agents/designer.md').body, /apv design register/);
  assert.match(frontmatter('skills/design-artefact/SKILL.md').body, /apv design register/);
  const lead = frontmatter('skills/chef-de-projet/SKILL.md').body;
  for (const rule of [/\/apv:design/, /\/apv:preview/, /apv design check/]) assert.match(lead, rule);
});

test('phase three commands run the apv tool; those with effects are left to the operator', () => {
  const tool = 'Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js';
  const subcommand = { init: 'init', spec: 'spec', run: 'run', review: 'run', stack: 'stack plan' };
  for (const name of PHASE_THREE_COMMANDS) {
    const { fields, body } = frontmatter(`skills/${name}/SKILL.md`);
    assert.ok(!body.includes('Disponible en phase'), `${name}: no longer a stub`);
    assert.ok(fields['argument-hint'], `${name}: argument hint`);
    assert.ok(fields.description.length >= 150, `${name}: description says what and when`);
    assert.ok(fields['allowed-tools'].includes(`${tool} ${subcommand[name]}*)`), `${name}: allowed to run apv ${subcommand[name]}`);
    assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"'), `${name}: names the bundled tool`);
    assert.match(body, /tiret cadratin/, `${name}: text rule`);
    if (OPERATOR_ONLY_COMMANDS.includes(name)) assert.equal(fields['disable-model-invocation'], 'true', `${name}: operator only`);
    else assert.ok(!('disable-model-invocation' in fields), `${name}: /apv:run chains it`);
  }

  const init = frontmatter('skills/init/SKILL.md').body;
  for (const rule of [/apv init --name/, /sans jamais écraser/, /package\.json/, /gates/, /\.apv\/brief\.md/, /apv ledger plan/, /mots exacts/, /\*\*propose\*\* le commit/, /worktree\.baseRef/]) assert.match(init, rule);

  const spec = frontmatter('skills/spec/SKILL.md');
  assert.ok(spec.fields['allowed-tools'].split(' ').includes('Agent'));
  for (const rule of [/apv spec new <id>/, /`apv:product`/, /`apv:dpo`/, /`apv:architecte-donnees`/, /apv spec validate .*--request-file/, /jusqu'à `VALID`/, /SendMessage/, /Présenter à l'opérateur/, /minimum de sécurité/]) assert.match(spec.body, rule);

  const run = frontmatter('skills/run/SKILL.md');
  const runTools = run.fields['allowed-tools'].split(' ');
  for (const t of ['Agent', 'Workflow', 'SendMessage', 'TaskStop', 'Skill']) assert.ok(runTools.includes(t), `run may use ${t}`);
  assert.ok(!/merge(?! --ff-only)/.test(run.fields['allowed-tools']), 'run is never allowed to merge a PR');
  assert.ok(!run.body.includes('gh pr merge') && !run.body.includes('APV_ALLOW'), 'run never merges');
  const next = run.body.indexOf('apv run next <id>');
  assert.ok(next > 0 && next < run.body.indexOf('apv run start <spec>'), 'resume through apv run next before any start');
  for (const rule of [/git switch -c <branche> <sha>/, /\.apv\/state\/task\.json/, /apv scope check --spec <spec> --task <tâche> --base <baseCommit>/,
    /apv run set <id> task:<tâche> running --branch/, /apv run set <id> task:<tâche> done --commit/, /data-model/, /apv:architecte`/, /fondations/,
    /`apv:vague`/, /workflows\/vague\.js/, /dans un même message/, /run_in_background: false/, /Session non interactive/, /jamais l.outil Workflow/, /apv:integrateur/, /git merge --ff-only/, /\/apv:review <id>/,
    /corrections-<id>\.md/, /apv gates run --stage full --repo/, /gh pr create --draft/, /sans masquer la sortie/, /apv preview update/, /70 %/, /85 %/, /95 %/, /apv quota/,
    /resumeFromRunId/, /Jamais de fusion/, /jamais de déploiement/, /jamais d'édition à la main/]) assert.match(run.body, rule);

  const review = frontmatter('skills/review/SKILL.md');
  assert.ok(review.fields['allowed-tools'].split(' ').includes('Workflow'));
  for (const rule of [/apv:qa-securite/, /apv:qa-fidelite/, /apv:architecte-donnees/, /apv:dpo/, /git worktree add --detach/, /`apv:revues`/, /workflows\/revues\.js/,
    /tous dans le même message/, /apv run set <id> review:<domaine> running/, /apv run set <id> review:<domaine> done/, /Aucun constat n'est écarté/, /lecture seule/]) assert.match(review.body, rule);

  const stack = frontmatter('skills/stack/SKILL.md');
  assert.ok(!stack.fields['allowed-tools'].includes('merge'), 'the merge itself always goes through a permission prompt');
  for (const rule of [/message courant/, /apv stack plan <pr\.\.\.>/, /\*\*toute\*\* la sortie/, /APV_ALLOW_MERGE=1 apv stack merge <pr\.\.\.>/, /devant \*\*cette seule commande\*\*/,
    /n'utilise jamais `gh pr merge`/, /Lis toute la sortie/, /incident 30/, /Première anomalie/]) assert.match(stack.body, rule);

  const lead = frontmatter('skills/chef-de-projet/SKILL.md').body;
  for (const rule of [/\/apv:init/, /\/apv:spec/, /\/apv:run/, /\/apv:review/, /\/apv:stack/, /apv run next/, /apv:vague/]) assert.match(lead, rule);
  const plugin = read('docs/PLUGIN.md');
  for (const name of PHASE_THREE_COMMANDS) assert.match(plugin, new RegExp(`\\| \`/apv:${name}\` \\| disponible`), `PLUGIN.md lists /apv:${name}`);
  assert.match(plugin, /RUN\.md/);
  for (const topic of [/apv run next/, /apv run set/, /reprise/i, /apv stack plan/, /APV_ALLOW_MERGE=1/]) assert.match(read('docs/RUN.md'), topic);
});

test('phase four command: /apv:onboard shows the plan, runs apv onboard and leaves the commit to the operator', () => {
  const tool = 'Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js';
  for (const name of PHASE_FOUR_COMMANDS) {
    const { fields, body } = frontmatter(`skills/${name}/SKILL.md`);
    assert.ok(!body.includes('Disponible en phase'), `${name}: no longer a stub`);
    assert.ok(fields['argument-hint'], `${name}: argument hint`);
    assert.ok(fields.description.length >= 150, `${name}: description says what and when`);
    assert.ok(fields['allowed-tools'].includes(`${tool} ${name}*)`), `${name}: allowed to run apv ${name}`);
    assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"'), `${name}: names the bundled tool`);
    assert.match(body, /tiret cadratin/, `${name}: text rule`);
    assert.equal(fields['disable-model-invocation'], 'true', `${name}: operator only`);
  }
  const onboard = frontmatter('skills/onboard/SKILL.md').body;
  const dry = onboard.indexOf('apv onboard --dry-run');
  assert.ok(dry > 0 && dry < onboard.indexOf('lance `apv onboard`'), 'the plan is shown before anything is written');
  for (const rule of [/sans jamais écraser/, /ignoré/, /--specs <dossier>/, /mandatory/, /section `preview`/, /docs\/PREVIEW\.md/, /\.apv\/brief\.md/,
    /apv ledger validate/, /apv gates run/, /--base/, /\*\*propose\*\* le commit/, /ni modifiés ni supprimés/]) assert.match(onboard, rule);
  assert.match(read('docs/PLUGIN.md'), /\| `\/apv:onboard` \| disponible/);
  assert.match(read('docs/CLI.md'), /## `apv onboard`/);
});

test('checks per task, full suite at integration and delivery: nothing lets a red suite through', () => {
  // First real /apv:run: every implementer ran the whole browser suite, twenty runs under the shared e2e lock.
  const tool = 'Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js';
  const run = frontmatter('skills/run/SKILL.md');
  for (const t of [`${tool} gates run*)`, `${tool} gates verify*)`, 'Bash(apv gates verify*)']) assert.ok(run.fields['allowed-tools'].includes(t), t);
  const taskStage = /apv gates run --stage task --base <(?:base|sha)>/;
  const ownE2e = /apv lock run e2e/;
  for (const file of ['agents/implementer.md', 'skills/chef-de-projet/references/brief-type.md', 'skills/run/SKILL.md', 'skills/chef-de-projet/references/planification.md']) {
    const text = read(file);
    assert.match(text.replace(/\n/g, ' '), taskStage, `${file}: task stage`);
    assert.match(text, ownE2e, `${file}: own e2e files under the e2e lease`);
  }
  const implementer = read('agents/implementer.md');
  assert.match(implementer, /seulement les fichiers de tests e2e que tu as créés ou modifiés/);
  assert.match(implementer, /npx playwright test <fichiers>/);
  assert.match(implementer, /sans contrôle marqué `full`[^\n]*comme avant/);
  assert.doesNotMatch(implementer, /Lance tous les contrôles déclarés/);
  for (const file of ['skills/run/SKILL.md', 'skills/chef-de-projet/references/integration-revues.md', 'skills/chef-de-projet/references/livraison-pile.md', 'skills/chef-de-projet/SKILL.md']) {
    const text = read(file);
    assert.match(text, /apv gates run --stage full/, `${file}: full suite`);
    assert.match(text, /apv gates verify --commit <tête/, `${file}: verified at the exact commit`);
  }
  assert.match(run.body, /Suite complète rouge[^\n]*Passe de corrections/);
  assert.match(read('skills/chef-de-projet/references/integration-revues.md'), /Suite complète rouge[^\n]*passe de corrections[^\n]*jamais ignoré/);
  assert.match(read('agents/integrateur.md'), /apv gates run --stage task/);
  const review = frontmatter('skills/review/SKILL.md').body;
  assert.match(review, /ne relancent ni la suite complète ni Playwright, sauf besoin précis de leur domaine/);
  assert.match(review, /apv gates verify --commit <commit>/);
  const guide = read('docs/RUN.md');
  assert.match(guide, /### Contrôles : par tâche et suite complète/);
  assert.match(guide, /\*\*Rien ne passe pour autant\.\*\*[^\n]*au commit exact[^\n]*Seul le moment de la détection change/);
  assert.match(read('docs/CLI.md'), /## `apv gates verify`/);
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

test('the plugin ships bin/apv and installs no dependency', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.files.includes('bin'), 'bin/ is published with the plugin');
  assert.ok(statSync(join(root, 'bin', 'apv')).mode & 0o111, 'bin/apv is executable');
  assert.match(read('bin/apv'), /^#!\/usr\/bin\/env node\n/);
  // The plugin runs on Node's standard library only: any runtime dependency widens what installing it pulls in.
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const value = pkg[field] ?? {};
    assert.equal(Array.isArray(value) ? value.length : Object.keys(value).length, 0, `package.json: ${field} must stay empty`);
  }
});

test('the changelog and the plugin guide state what the tool really does (FID-3, SEC-3)', () => {
  // Reviews FID-3 and SEC-3: the changelog left out --commit on steps and reviews, and the texts on bin/apv
  // claimed that nothing came from PATH while its shebang takes the interpreter there.
  const unreleased = read('CHANGELOG.md').split(/\n## (?!Non publié)/)[0];
  assert.match(unreleased, /--commit` sur les étapes et les revues/);
  assert.match(unreleased, /champ `commit`[^\n]*facultatif/);
  assert.match(unreleased, /Remplacer le commit d'une cible déjà `done` exige `--note`/);
  for (const [name, text] of [['CHANGELOG.md', unreleased], ['docs/PLUGIN.md', read('docs/PLUGIN.md')], ['bin/apv', read('bin/apv')]]) {
    assert.match(text, /NODE_OPTIONS/, name);
    assert.match(text, /nvm/, name);
    assert.match(text, /risque résiduel|residual risk/i, name);
  }
});

test('texts written for APV3 contain no em or en dash', () => {
  const files = [
    ...AGENTS.map(a => `agents/${a}.md`),
    ...[...METHOD_SKILLS, ...PHASE_ONE_COMMANDS, ...PHASE_TWO_COMMANDS, ...PHASE_THREE_COMMANDS, ...PHASE_FOUR_COMMANDS, ...Object.keys(LATER_COMMANDS)].flatMap(s => {
      const dir = join(root, 'skills', s);
      const refs = readdirSync(dir).includes('references') ? readdirSync(join(dir, 'references')).map(r => `skills/${s}/references/${r}`) : [];
      return [`skills/${s}/SKILL.md`, ...refs];
    }),
    'hooks/hooks.json', 'hooks/scripts/bash-guard.mjs', 'hooks/scripts/session-start.mjs', 'hooks/scripts/stop-journal.mjs', 'hooks/scripts/scope-reminder.mjs',
    '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'docs/PLUGIN.md', 'docs/DESIGN.md', 'docs/RUN.md', 'README.md', 'START-HERE.md',
    'skills/README.md', 'workflows/vague.js', 'workflows/revues.js', 'bin/apv', 'docs/CLI.md',
  ];
  for (const file of files) assert.ok(!/[–—]/.test(read(file)), `${file} contains an em or en dash`);
});

test('the tree analysis is part of the cycle: onboarding, plan, review and documentation', () => {
  const tool = 'Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js';
  const onboard = frontmatter('skills/onboard/SKILL.md');
  for (const t of [`${tool} structure check*)`, 'Bash(apv structure check*)']) assert.ok(onboard.fields['allowed-tools'].includes(t), t);
  assert.match(onboard.body, /## 4\. Arborescence\n1\. `apv structure check`/);
  assert.match(onboard.body, /Rien n'est déplacé pendant la reprise/);
  assert.match(onboard.body, /spec à part/);
  const architect = frontmatter('agents/architecte.md').body;
  assert.match(architect, /\*\*Placement des fichiers\.\*\*/);
  assert.match(architect, /apv structure check --path <dossier>/);
  assert.match(read('skills/chef-de-projet/references/planification.md'), /\*\*Placement\*\*[^\n]*apv structure check --path <dossier>/);
  assert.match(read('skills/run/SKILL.md'), /apv structure check --path/);
  assert.match(frontmatter('agents/qa-fidelite.md').body, /\*\*Placement des fichiers\*\*[^\n]*apv structure check --path <dossier> --repo <copie>[^\n]*mal placé/);
  const config = read('docs/CONFIGURATION.md');
  assert.match(config, /## Arborescence : `structure`/);
  assert.match(config, /"command": \["apv", "structure", "check"\][^\n]*"stage": "task"/);
  assert.match(read('docs/CLI.md'), /## `apv structure check`/);
  assert.match(read('CHANGELOG.md').split('\n## ')[1], /apv structure check/);
});

test('race conditions: a generic review grid, linked from the data architect, security QA and /apv:review', () => {
  const grid = read('skills/architecture-donnees/references/concurrence.md');
  const families = ['4.1 Lecture-modification-écriture', '4.2 Double soumission et rejeu', '4.3 Mises à jour concurrentes', '4.4 Vérifier puis agir (TOCTOU)',
    '4.5 Tâches planifiées', '4.6 Effets externes', '4.7 Caches et états « prêts »', '4.8 Ordre des opérations asynchrones', '4.9 Ressources partagées des tests',
    '4.10 Horloges et ordonnancement'];
  for (const family of families) assert.ok(grid.includes(`### ${family}`), `family ${family}`);
  const sections = grid.split('\n### ').slice(1);
  assert.equal(sections.length, families.length);
  for (const section of sections) {
    for (const part of ['**Motif à chercher**', '**Question à trancher**', '**Corrections acceptables**', '**Preuve attendue**']) {
      assert.ok(section.includes(part), `${section.split('\n')[0]}: ${part}`);
    }
  }
  for (const term of [/Section critique/, /Exclusion mutuelle \(mutex\)/, /Sémaphore/, /Opération atomique/, /Ordonnancement/, /Isolation/, /select … for update/, /niveau/,
    /Clé-valeur/, /Fichiers/, /renommage atomique/, /échoue sur la version non protégée/, /forcé/]) assert.match(grid, term);
  // Generic: stacks are examples, never the rule. The four pilot cases are anonymised.
  assert.match(grid, /sont des \*\*exemples\*\* marqués comme tels/);
  for (const stack of [/PostgreSQL/, /MySQL/, /SQLite/, /Redis/, /DynamoDB/, /Django/, /Rails/, /Go/, /Java/]) assert.match(grid, stack);
  assert.doesNotMatch(grid, /Toujours rien/i);
  assert.equal((grid.match(/\*\*Exemple observé \(anonymisé\)\*\*/g) ?? []).length, 4);
  assert.match(grid, /deux suites de tests[^\n]*verrou différent/);
  assert.match(grid, /cache de schéma[^\n]*« prêt »/);
  assert.match(grid, /focus[^\n]*mauvais champ/);
  assert.match(grid, /file d'attente de verrous[^\n]*horloge estimée par processus/);
  assert.match(grid, /\| Emplacement \| Famille \| Invariant \| Protection \| Statut \| Preuve \|/);

  assert.match(frontmatter('skills/architecture-donnees/SKILL.md').body, /`references\/concurrence\.md`/);
  const architect = frontmatter('agents/architecte-donnees.md').body;
  assert.match(architect, /references\/concurrence\.md/);
  assert.match(architect, /\*\*Audit de concurrence\*\*/);
  assert.match(architect, /pour \*\*chaque écriture\*\*, tu décides et écris[^\n]*protection contre la concurrence/);
  assert.match(architect, /- \*\*Concurrence\*\* \(grille `references\/concurrence\.md`\)[^\n]*conforme, non conforme ou inconnu[^\n]*preuve/);
  const security = frontmatter('agents/qa-securite.md').body;
  assert.match(security, /references\/concurrence\.md/);
  for (const rule of [/TOCTOU[^\n]*sur les droits/, /TOCTOU sur les quotas/, /\*\*rejeu\*\*/]) assert.match(security, rule);

  const review = frontmatter('skills/review/SKILL.md');
  assert.match(review.fields['argument-hint'], /concurrence/);
  assert.match(review.body, /\| `concurrence` \| `apv:architecte-donnees` \(audit de concurrence\) \| \*\*sur demande seulement\*\*/);
  assert.match(review.body, /parmi les quatre premiers, qui restent les domaines par défaut/);
  assert.match(review.body, /`\/apv:review \[branche\] concurrence`[^\n]*il se lance seul/);
  assert.match(review.body, /\.apv\/state\/audit-concurrence-<sha court>\.md/);
  assert.match(review.body, /pas de `apv run set … review:concurrence`/);
  assert.match(read('docs/PLUGIN.md'), /`\/apv:review \[branche\] concurrence`/);
  assert.match(read('CHANGELOG.md').split('\n## ')[1], /references\/concurrence\.md/);
});

test('targeted tests at the task stage, one unstable test repeated with a bound, detached runs followed by a monitor', () => {
  // « Toujours rien » : a 5-minute file repeated 20 times under the single e2e lock; a run cut at night with its session.
  for (const file of ['agents/implementer.md', 'skills/chef-de-projet/references/brief-type.md', 'skills/run/SKILL.md', 'workflows/vague.js']) {
    const text = read(file).replace(/\n/g, ' ');
    assert.match(text, /ciblé/, `${file}: targeted checks`);
    assert.match(text, /<fichier>:<ligne>/, `${file}: the single unstable test`);
    assert.match(text, /--repeat-each[^.]*20 au plus/, `${file}: bounded repetition`);
    assert.match(text, /jamais un fichier entier[^.]*sous le verrou/i, `${file}: never a whole file under the lock`);
  }
  for (const file of ['agents/implementer.md', 'skills/chef-de-projet/references/brief-type.md', 'workflows/vague.js', 'skills/chef-de-projet/SKILL.md']) {
    assert.match(read(file), /reducedMotion/, `${file}: reduced motion by default`);
  }
  for (const file of ['skills/run/SKILL.md', 'skills/chef-de-projet/SKILL.md']) {
    const text = read(file);
    assert.match(text, /setsid nohup/, `${file}: detached launch`);
    assert.match(text, /\.apv\/state\/run-<id>\.json/, `${file}: watches the run state`);
    assert.match(text, /Monitor/, `${file}: Monitor tool`);
    assert.match(text, /jamais par des relevés espacés de 30 minutes/, `${file}: no spaced polling`);
  }
  const guide = read('docs/RUN.md');
  assert.match(guide, /### Exécution détachée et suivi/);
  assert.match(guide, /setsid nohup sh -c 'echo "pid \$\$"; exec claude -p/);
  assert.match(guide, /cksum < "\$f"/);
  assert.match(read('docs/CONFIGURATION.md'), /"affected": \["apv", "lock", "run", "e2e", "--", "npx", "playwright", "test", "--only-changed=\{\{baseSha\}\}"/);
});

test('design critique: a scored generic grid, directions before details, a read-only critic before the operator sees a mockup', () => {
  // The operator wanted attractive, living interfaces that do not look AI-made; on the pilot a tester read a job seekers' tool as a recruiting tool.
  const grid = read('skills/design-artefact/references/grille-critique.md');
  for (const section of ['## A. Empreintes génériques', '## B. Signature', '## C. Typographie, couleur, espace et rythme', '## D. États', '## E. Animations',
    '## F. Test des 5 secondes', '## G. Textes', '## H. Accessibilité minimale', '## Rapport']) assert.ok(grid.includes(section), section);
  for (const note of ['`conforme`', '`à revoir`', '`bloquant`', '`non vérifié`']) assert.ok(grid.includes(note), note);
  assert.match(grid, /\*\*Retour au designer\*\* si au moins un critère est `bloquant`, \*\*ou\*\* si 3 empreintes génériques ou plus/);
  const fingerprints = grid.match(/^- \[ \] A\d+\. /gm) ?? [];
  assert.ok(fingerprints.length >= 15, `fingerprints: ${fingerprints.length}`);
  assert.match(grid, /Au moins \*\*3 éléments que seul ce produit possède\*\*[^\n]*monde du sujet/);
  assert.match(grid, /Test de substitution/);
  assert.match(grid, /\| Mouvement \| Déclencheur \| Rôle \| Durée \| Courbe \| Mouvement réduit \|/);
  for (const role of ['**retour d\'action**', '**orientation**', '**continuité**', '**plaisir**']) assert.ok(grid.includes(role), role);
  assert.match(grid, /\*\*Animation sans rôle : refusée\*\*/);
  assert.match(grid, /\*\*Chaque action importante a un retour visible\*\*/);
  for (const state of ['Vide', 'Chargement', 'Erreur', 'Succès', 'Désactivé', 'Focus']) assert.match(grid, new RegExp(`^\\| ${state} \\|`, 'm'), state);
  assert.match(grid, /\*\*à quoi sert cet écran\*\*[^\n]*\*\*pour qui\*\*[^\n]*\*\*que ferais-je en premier\*\*/);
  assert.match(grid, /\*\*lectures erronées plausibles\*\*/);
  assert.match(grid, /\*\*F d'abord\*\*/);
  // Generic: tools are examples, the pilot case is anonymised.
  assert.match(grid, /sont des \*\*exemples\*\* marqués comme tels/);
  assert.ok((grid.match(/Exemple, /g) ?? []).length >= 4, 'varied signature examples');
  assert.equal((grid.match(/\*\*Exemple observé \(anonymisé\)\*\*/g) ?? []).length, 1);
  assert.match(grid, /suivi de candidatures[^\n]*chercheurs d'emploi[^\n]*recrutement/);
  for (const pilot of [/Toujours rien/i, /Svelte/, /Supabase/]) assert.doesNotMatch(grid, pilot);
  for (const source of ['anti-generic.md', 'motion.md', 'visual-identity.md', 'design-process.md', 'ux-laws.md']) {
    assert.ok(grid.includes(source), source);
    assert.ok(read(`skills/ui-design/references/${source}`).length > 0, source);
  }

  const critic = frontmatter('agents/critique-design.md');
  assert.deepEqual(list(critic.fields.tools), ['Read', 'Grep', 'Glob', 'Bash', 'Skill']);
  for (const rule of [/references\/grille-critique\.md/, /390 × 844/, /1280 × 800/, /\*\*clair\*\* et \*\*sombre\*\*/, /chaque écran et chaque état/, /npx/, /\*\*Sans navigateur\*\*/,
    /\*\*Test des 5 secondes d'abord\*\*/, /reducedMotion/, /\*\*sept corrections au plus\*\*/, /tu n'inventes jamais une cible/, /Lecture seule : tu n'écris ni la maquette/, /mktemp -d/]) assert.match(critic.body, rule);

  const designer = frontmatter('agents/designer.md').body;
  for (const rule of [/## Direction avant détails/, /\*\*2 ou 3 directions distinctes\*\*/, /phrase d'intention/, /planche de jetons/, /un écran clé/, /la continuité prime/,
    /\*\*la grille remplie par toi\*\*/, /\*\*fiche d'animation\*\*/, /`apv:critique-design`/, /après deux tours de critique/, /references\/grille-critique\.md/]) assert.match(designer, rule);

  const loop = frontmatter('skills/design-artefact/SKILL.md').body;
  const links = [...loop.matchAll(/\((references\/[a-z-]+\.md)\)/g)].map(m => m[1]);
  assert.ok(links.includes('references/grille-critique.md'));
  for (const ref of links) assert.ok(read(`skills/design-artefact/${ref}`).length > 0, ref);
  for (const rule of [/## 2\. Direction avant détails/, /\*\*2 ou 3 directions distinctes\*\*/, /la continuité prime/, /\*\*Critique\*\* : le chef de projet lance `apv:critique-design`/,
    /\*\*Deux tours de critique au plus\*\*/, /\*\*le rapport du critique joint\*\*/, /\*\*la grille remplie\*\*/, /## 7\. Critique seule/]) assert.match(loop, rule);
  const critique = loop.indexOf('3. **Critique**');
  assert.ok(critique > 0 && critique < loop.indexOf('4. **Publication**'), 'critique before publication');

  const command = frontmatter('skills/design/SKILL.md');
  assert.match(command.fields['argument-hint'], /critique <chemin/);
  for (const rule of [/## 1 bis\. Direction avant détails/, /\*\*Obligatoire\*\*/, /\*\*il choisit\*\*/, /la continuité prime/, /\*\*Critique avant de montrer\*\*/, /`apv:critique-design`/,
    /\*\*Deux tours de critique au plus\*\*/, /Tu ne montres jamais une version sans son rapport de critique/, /\*\*le rapport du critique joint\*\*/, /## 7\. Critique d'une maquette existante/,
    /`\/apv:design critique <chemin>`/, /grille-critique\.md/]) assert.match(command.body, rule);
  assert.ok(command.body.indexOf('**Critique avant de montrer**') < command.body.indexOf('**Publication**'), 'critique before publication');

  const fidelity = frontmatter('agents/qa-fidelite.md').body;
  for (const rule of [/references\/grille-critique\.md/, /\*\*D, états\*\*/, /\*\*E, animations\*\*/, /\*\*F, test des 5 secondes\*\*/, /reducedMotion: 'reduce'/, /document\.getAnimations\(\)/,
    /retour visible/]) assert.match(fidelity, rule);

  assert.match(read('docs/PLUGIN.md'), /^\| `critique-design` \| [^\n]*\| lecture, Bash \(pas d'écriture de fichiers\) \| aucun \|$/m);
  assert.match(read('docs/PLUGIN.md'), /`\/apv:design critique <chemin>`/);
  assert.match(read('docs/DESIGN.md'), /apv:critique-design/);
  assert.match(read('README.md'), /\*\*10 sous-agents\*\*[^\n]*`critique-design`/);
  const unreleased = read('CHANGELOG.md').split('\n## ')[1];
  for (const topic of [/critique-design/, /grille-critique\.md/, /test des 5 secondes/, /2 ou 3 directions/]) assert.match(unreleased, topic);
});
