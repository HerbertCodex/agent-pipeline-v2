import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { configIssues } from '../dist/config/load.js';
import { REVIEW_DOMAINS } from '../dist/review/config.js';
import { referencesOnly } from '../dist/review/plan.js';
import { REVIEWS } from '../dist/run/state.js';

/**
 * A small project on `main` (server code, a component, a migration, a legal text, tests), then a branch `work`
 * where each test makes its change: `apv review plan --base main --head work` classifies the diff.
 */
const FILES = {
  'src/lib/format.ts': "export const money = (n: number): string => `${n} €`;\n",
  'src/lib/server/applications.ts': [
    '// Formats: src/lib/format.ts.', "import { money } from '../format';", '',
    '/** Total of the values, formatted. */', 'export function total(values: number[]): string {', '  return money(values.reduce((a, b) => a + b, 0));', '}', '',
    '/** Largest value, formatted. */', 'export function largest(values: number[]): string {', '  return money(Math.max(...values));', '}', '',
    '/** Smallest value, formatted. */', 'export function smallest(values: number[]): string {', '  return money(Math.min(...values));', '}', '',
  ].join('\n'),
  'src/lib/components/Card.svelte': "<script lang=\"ts\">\n  import { money } from '$lib/format';\n  let { value }: { value: number } = $props();\n</script>\n\n<p class=\"card\">{money(value)}</p>\n",
  'src/routes/+page.svelte': "<script lang=\"ts\">\n  import Card from '$lib/components/Card.svelte';\n</script>\n\n<Card value={3} />\n",
  'supabase/migrations/20260101000000_init.sql': 'create table public.items (id uuid primary key);\n',
  'content/legal/confidentialite.md': '# Confidentialité\n\nNous gardons vos données douze mois.\n',
  'test/format.test.ts': "import { money } from '../src/lib/format';\n",
};

function project(t, config) {
  const f = fixture(t, { files: FILES });
  if (config !== undefined) { write(f.repo, '.apv/config.json', config); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'config'); }
  git(f.repo, 'switch', '-q', '-c', 'work');
  const file = p => join(f.repo, p);
  return {
    ...f,
    edit: (path, text) => { mkdirSync(dirname(file(path)), { recursive: true }); writeFileSync(file(path), text); },
    read: path => readFileSync(file(path), 'utf8'),
    move: (from, to) => { mkdirSync(dirname(file(to)), { recursive: true }); renameSync(file(from), file(to)); },
    commit: () => { git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'change'); },
    plan: async (...extra) => {
      const r = await apv(f.repo, ['review', 'plan', '--base', 'main', '--head', 'work', '--json', ...extra]);
      assert.equal(r.code, 0, r.stderr);
      return r.json();
    },
  };
}

const retained = plan => plan.retained;
const decision = (plan, domain) => plan.domains.find(d => d.domain === domain);

test('review plan: the domains of the plan are the domains of the run state', () => {
  assert.deepEqual([...REVIEW_DOMAINS], [...REVIEWS]);
});

test('review plan: pure renames keep the security review only, with a reason for each skipped domain', async t => {
  const p = project(t);
  p.move('src/lib/components/Card.svelte', 'src/lib/components/money/Card.svelte');
  p.move('src/lib/server/applications.ts', 'src/lib/server/applications/service.ts');
  p.move('content/legal/confidentialite.md', 'content/legal/privacy.md');
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(retained(plan), ['securite']);
  assert.deepEqual(plan.skipped.map(s => s.domain), ['fidelite', 'donnees', 'rgpd']);
  assert.deepEqual(plan.counts, { files: 3, renames: 3, paths: 0, content: 0, neutral: 0, unclassified: 0 });
  assert.ok(plan.files.every(f => f.change === 'none' && /^R100$/.test(f.status) && f.from));
  for (const s of plan.skipped) assert.match(s.reason, /^rien à relire : .*\(3 fichiers : 3 renommages purs\)$/);
  assert.match(decision(plan, 'securite').reason, /toujours relue, sans exception/);
});

test('review plan: a move with its imports and path references rewritten, rewrapped or reordered is still no content change', async t => {
  const p = project(t);
  p.move('src/lib/format.ts', 'src/lib/shared/format.ts');
  // The importer moves too: its relative imports change although their target does not move.
  p.move('src/lib/server/applications.ts', 'src/lib/server/applications/service.ts');
  p.edit('src/lib/server/applications/service.ts', p.read('src/lib/server/applications/service.ts')
    .replace('// Formats: src/lib/format.ts.', '// Formats: src/lib/shared/format.ts.')
    .replace("import { money } from '../format';", "import {\n  money,\n} from '../../shared/format';"));
  p.edit('src/lib/components/Card.svelte', p.read('src/lib/components/Card.svelte').replace("'$lib/format'", "'$lib/shared/format'"));
  p.edit('test/format.test.ts', "import { money } from '../src/lib/shared/format';\n");
  p.commit();
  let plan = await p.plan();
  const service = plan.files.find(f => f.path === 'src/lib/server/applications/service.ts');
  assert.equal(service.change, 'paths', JSON.stringify(service));
  assert.equal(plan.files.find(f => f.path === 'src/lib/components/Card.svelte').change, 'paths');
  assert.deepEqual(retained(plan), ['securite']);
  assert.match(plan.skipped[0].reason, /fichiers aux seuls chemins réécrits/);
  // One more changed line in the moved file: a content change, every domain kept (unclassified server file).
  p.edit('src/lib/server/applications/service.ts', p.read('src/lib/server/applications/service.ts').replace('Math.max', 'Math.min'));
  p.commit();
  plan = await p.plan();
  assert.equal(plan.files.find(f => f.path === 'src/lib/server/applications/service.ts').change, 'content');
  assert.deepEqual(retained(plan), ['securite', 'fidelite', 'donnees', 'rgpd']);
});

test('review plan: references only, never a hidden change', () => {
  const renames = [{ from: 'src/lib/format.ts', path: 'src/lib/shared/format.ts' }, { from: 'src/lib/a/util.ts', path: 'src/lib/b/util.ts' }];
  const file = { path: 'src/lib/server/x.ts' };
  const same = (removed, added, f = file) => referencesOnly({ removed, added }, f, renames);
  assert.ok(same(["import { money } from '$lib/format';"], ["import { money } from '$lib/shared/format';"]));
  assert.ok(same([' * voir src/lib/format.ts.'], [' * voir src/lib/shared/format.ts.']));
  // Imports reordered by the formatter after the move.
  assert.ok(same(["import { a } from '$lib/format';", "import { b } from '$lib/other';"], ["import { b } from '$lib/other';", "import { a } from '$lib/shared/format';"]));
  // Another imported name, another module of the same name, a changed string: content changes.
  assert.ok(!same(["import { money } from '$lib/format';"], ["import { money, rate } from '$lib/shared/format';"]));
  assert.ok(!same(["import { util } from '$lib/a/util';"], ["import { util } from '$lib/c/util';"]));
  assert.ok(!same(["const label = 'Total';"], ["const label = 'Totaux';"]));
  assert.ok(!same(["const label = 'a  b';"], ["const label = 'a b';"]), 'whitespace inside a string is content');
  assert.ok(!same(['a();', 'b();'], ['b();', 'a();']), 'statements other than imports keep their order');
  // A relative specifier is resolved from the file: same name, other file, is a content change.
  assert.ok(!same(["import { x } from './helpers';"], ["import { x } from '../helpers';"]));
  assert.ok(same(["import { x } from './helpers';"], ["import { x } from '../helpers';"], { path: 'src/lib/server/sub/x.ts', from: 'src/lib/server/x.ts' }));
  // Markup keeps a space between two elements: removing it is content.
  assert.ok(!same(['<b>a</b> <i>b</i>'], ['<b>a</b><i>b</i>'], { path: 'src/C.svelte' }));
});

test('review plan: an interface change keeps fidelity with the security review', async t => {
  const p = project(t);
  p.edit('src/lib/components/Card.svelte', p.read('src/lib/components/Card.svelte').replace('class="card"', 'class="card card--wide"'));
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(retained(plan), ['securite', 'fidelite']);
  assert.deepEqual(decision(plan, 'fidelite').files, ['src/lib/components/Card.svelte']);
  assert.match(decision(plan, 'fidelite').reason, /interface au contenu changé \(1\)/);
});

test('review plan: words of the changed lines keep the data or GDPR review of an interface file', async t => {
  const p = project(t);
  p.edit('src/routes/+page.svelte', `${p.read('src/routes/+page.svelte')}<script>localStorage.setItem('vu', '1');</script>\n`);
  p.edit('src/lib/components/Card.svelte', p.read('src/lib/components/Card.svelte').replace('</script>', "  const rows = supabase.from('items').select('id');\n</script>"));
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(retained(plan), ['securite', 'fidelite', 'donnees', 'rgpd']);
  assert.match(decision(plan, 'rgpd').reason, /terme RGPD « localstorage »/);
  assert.match(decision(plan, 'donnees').reason, /terme de données « \.from\('/);
});

test('review plan: a migration keeps data and GDPR, even renamed', async t => {
  const p = project(t);
  p.edit('supabase/migrations/20260102000000_email.sql', 'alter table public.items add column email text;\n');
  p.commit();
  let plan = await p.plan();
  assert.deepEqual(retained(plan), ['securite', 'donnees', 'rgpd']);
  assert.match(decision(plan, 'donnees').reason, /migration ou schéma touché/);
  // A renamed migration: the migration tool records the file names.
  const q = project(t);
  q.move('supabase/migrations/20260101000000_init.sql', 'supabase/migrations/20260101000000_initial.sql');
  q.commit();
  plan = await q.plan();
  assert.deepEqual(retained(plan), ['securite', 'donnees', 'rgpd']);
  assert.match(decision(plan, 'rgpd').reason, /migration renommée/);
});

test('review plan: a legal text keeps the GDPR review', async t => {
  const p = project(t);
  p.edit('content/legal/confidentialite.md', p.read('content/legal/confidentialite.md').replace('douze', 'vingt-quatre'));
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(retained(plan), ['securite', 'rgpd']);
  assert.match(decision(plan, 'rgpd').reason, /texte légal au contenu changé/);
});

test('review plan: an unclassified file with a changed content keeps every domain (prudence); tests and docs keep none', async t => {
  const p = project(t);
  p.edit('src/lib/server/applications.ts', p.read('src/lib/server/applications.ts').replace('a + b', 'a + b + 1'));
  p.edit('test/format.test.ts', `${p.read('test/format.test.ts')}// un test de plus\n`);
  p.edit('docs/guide.md', 'Nouveau guide.\n');
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(retained(plan), ['securite', 'fidelite', 'donnees', 'rgpd']);
  for (const domain of ['fidelite', 'donnees', 'rgpd']) {
    assert.deepEqual(decision(plan, domain).files, ['src/lib/server/applications.ts'], domain);
    assert.match(decision(plan, domain).reason, /fichier non classé au contenu changé \(prudence\)/);
  }
  assert.equal(plan.counts.unclassified, 1);
  assert.equal(plan.counts.neutral, 2);
  // Tests and documentation alone: nothing beyond the security review.
  const q = project(t);
  q.edit('test/format.test.ts', `${q.read('test/format.test.ts')}// un test de plus\n`);
  q.edit('docs/guide.md', 'Nouveau guide.\n');
  q.commit();
  assert.deepEqual(retained(await q.plan()), ['securite']);
});

test('review plan: the configuration forces a domain, and the operator too', async t => {
  const p = project(t, { review: { always: ['fidelite'] } });
  p.move('src/lib/format.ts', 'src/lib/money.ts');
  p.commit();
  let plan = await p.plan();
  assert.deepEqual(retained(plan), ['securite', 'fidelite']);
  assert.equal(decision(plan, 'fidelite').forced, 'config');
  assert.match(decision(plan, 'fidelite').reason, /forcée par la configuration \(review\.always\)/);
  plan = await p.plan('--force', 'rgpd', '--force', 'donnees,rgpd');
  assert.deepEqual(retained(plan), ['securite', 'fidelite', 'donnees', 'rgpd']);
  assert.equal(decision(plan, 'rgpd').forced, 'operator');
  const bad = await apv(p.repo, ['review', 'plan', '--base', 'main', '--force', 'perf']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /domaine inconnu perf/);
});

test('review plan: the security review is never skipped, whatever the configuration tries', async t => {
  // Every file declared neutral, every other list emptied: the security review stays.
  const everything = { review: { paths: { neutral: ['**'], ui: [], data: [], migrations: [], personal: [], legal: [] }, terms: { data: [], personal: [] }, always: [] } };
  const p = project(t, everything);
  p.edit('src/lib/server/auth/session.ts', 'export const session = 1;\n');
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(retained(plan), ['securite']);
  assert.deepEqual(decision(plan, 'securite').files, ['src/lib/server/auth/session.ts'], 'sensitive paths of the high lane are cited');
  // No key can skip it: an unknown key is refused by the configuration schema.
  for (const review of [{ skip: ['securite'] }, { never: ['securite'] }, { always: ['perf'] }, { paths: { security: ['**'] } }]) {
    const { issues } = configIssues({ review });
    assert.ok(issues.length, JSON.stringify(review));
  }
  const q = project(t, { review: { skip: ['securite'] } });
  const refused = await apv(q.repo, ['review', 'plan', '--base', 'main', '--json']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /unknown property skip/);
  // A glob the portable syntax refuses is refused at load.
  assert.match(configIssues({ review: { paths: { ui: ['src/{a,b}/**'] } } }).issues[0].message, /review\.paths\.ui/);
});

test('review plan: text output, and refusals', async t => {
  const p = project(t);
  p.move('src/lib/format.ts', 'src/lib/money.ts');
  p.commit();
  const r = await apv(p.repo, ['review', 'plan', '--base', 'main', '--head', 'work']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Plan des revues : main \([a-f0-9]{12}, base commune\) à work \([a-f0-9]{12}\)/);
  assert.match(r.stdout, /Domaines retenus :\n {2}securite : toujours relue, sans exception/);
  assert.match(r.stdout, /Domaines sautés :\n {2}fidelite : rien à relire/);
  assert.match(r.stdout, /apv run set <id> review:<domaine> skipped --note/);
  assert.ok(!/[\u2013\u2014]/.test(r.stdout), 'no en or em dash');
  assert.equal((await apv(p.repo, ['review', 'plan'])).code, 2, '--base is required');
  assert.equal((await apv(p.repo, ['review', 'go', '--base', 'main'])).code, 2);
  const unknown = await apv(p.repo, ['review', 'plan', '--base', 'nulle-part']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /REVIEW_REF/);
});

test('review plan: a skipped review is recorded with its reason; the security review can never be recorded skipped', async t => {
  const f = fixture(t);
  const task = { id: 'A', title: 'Tâche A', description: 'Écrire docs/a.md.', acceptanceIds: ['AC-A'], allowedPaths: ['docs/a.md'], dependsOn: [], minimumLane: 'standard' };
  write(f.repo, '.apv/specs/rangement.json', { title: 'Rangement', problem: 'Les fichiers sont mal rangés dans le dépôt.', scope: ['Rangement'], outOfScope: [],
    acceptance: [{ id: 'AC-A', description: 'Partie A écrite.', verification: 'Lire docs/a.md.' }], decisions: [], questions: [], tasks: [task], minimumLane: 'standard' });
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'spec');
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20' };
  const run = (...args) => apv(f.repo, ['run', ...args], env);
  assert.equal((await run('start', 'rangement')).code, 0);
  const noNote = await run('set', 'rangement', 'review:fidelite', 'skipped');
  assert.equal(noNote.code, 1);
  assert.match(noNote.stderr, /exige --note/);
  assert.equal((await run('set', 'rangement', 'review:fidelite', 'skipped', '--note', 'rien à relire : aucun fichier d\'interface')).code, 0);
  const security = await run('set', 'rangement', 'review:securite', 'skipped', '--note', 'rien');
  assert.equal(security.code, 1);
  assert.match(security.stderr, /la revue sécurité n'est jamais sautée/);
  const state = JSON.parse(readFileSync(join(f.repo, '.apv/state/run-rangement.json'), 'utf8'));
  assert.deepEqual([state.reviews.fidelite.status, state.reviews.fidelite.note], ['skipped', 'rien à relire : aucun fichier d\'interface']);
  assert.equal(state.reviews.securite.status, 'pending');
});

test('review plan: the skills run it before the reviews, the documentation describes it', () => {
  const root = new URL('..', import.meta.url);
  const read = path => readFileSync(new URL(path, root), 'utf8');
  const tools = text => /^allowed-tools: (.*)$/m.exec(text)[1];
  for (const skill of ['skills/review/SKILL.md', 'skills/run/SKILL.md']) {
    const text = read(skill);
    for (const t of ['Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js review plan*)', 'Bash(apv review plan*)']) assert.ok(tools(text).includes(t), `${skill}: ${t}`);
    assert.match(text, /apv review plan --base/, skill);
    assert.match(text, /review:<domaine> skipped --note "<raison de/, skill);
  }
  const review = read('skills/review/SKILL.md');
  assert.match(review, /Tu lances \*\*les domaines retenus, et eux seuls\*\*/);
  assert.match(review, /"skipped": \[ \{ "domain": "rgpd", "reason": "<raison de apv review plan>" \} \]/);
  assert.match(review, /\*\*`securite` est toujours retenue\*\*, sans exception/);
  assert.match(read('docs/CLI.md'), /## `apv review plan`/);
  assert.match(read('docs/RUN.md'), /\*\*Domaines selon le diff, proposés par l'outil\.\*\*/);
  const configuration = read('docs/CONFIGURATION.md');
  assert.match(configuration, /### Domaines de revue selon le diff : `paths`, `terms`, `always`/);
  const example = /```json\n(\{ "review": \{\n {2}"paths"[\s\S]*?)```/.exec(configuration)[1];
  assert.deepEqual(configIssues(JSON.parse(example)).issues, [], 'the documented example is a valid configuration');
  assert.match(read('CHANGELOG.md').split('\n## ')[1], /Domaines de revue selon le diff : `apv review plan`/);
});

test('review plan: the written extension of a reference is part of its name; user diff settings change nothing', async t => {
  const renames = [{ from: 'src/lib/notice.ts', path: 'src/lib/shared/notice.ts' }, { from: 'src/lib/notice.svelte.ts', path: 'src/lib/shared/notice.svelte.ts' }];
  const same = (removed, added) => referencesOnly({ removed, added }, { path: 'src/C.svelte' }, renames);
  assert.ok(same(["import { n } from '$lib/notice.svelte';"], ["import { n } from '$lib/shared/notice.svelte';"]));
  assert.ok(!same(["import { n } from '$lib/notice';"], ["import { n } from '$lib/shared/notice.svelte';"]), 'another module moved beside it');
  // No prefix, relative paths and external diff in the user configuration: the same plan.
  const p = project(t);
  p.move('src/lib/format.ts', 'src/lib/shared/format.ts');
  p.edit('src/lib/components/Card.svelte', p.read('src/lib/components/Card.svelte').replace("'$lib/format'", "'$lib/shared/format'"));
  p.commit();
  for (const [key, value] of [['diff.noprefix', 'true'], ['diff.relative', 'true'], ['diff.external', 'false'], ['color.diff', 'always']]) git(p.repo, 'config', key, value);
  const plan = await p.plan();
  assert.deepEqual(plan.files.map(f => [f.path, f.change]), [['src/lib/components/Card.svelte', 'paths'], ['src/lib/shared/format.ts', 'none']]);
  assert.deepEqual(retained(plan), ['securite']);
});
