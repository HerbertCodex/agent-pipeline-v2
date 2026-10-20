import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { analyzeStructure } from '../dist/structure/analyze.js';
import { structureSettings, DEFAULT_ROLES } from '../dist/structure/config.js';
import { parseName, related, tokenize } from '../dist/structure/names.js';
import { configIssues } from '../dist/config/load.js';

const analyze = (paths, section, options) => analyzeStructure(paths, structureSettings(section), options);
const codes = report => report.findings.map(f => `${f.folder}:${f.code}`);
const moveOf = (report, from) => report.plan.find(m => m.from === from)?.to;
const many = (dir, names, ext = 'ts') => names.map(n => `${dir}/${n}.${ext}`);

/** The flat server folder of the pilot project, as it was before the operator's reorganization. */
const PILOT_SERVER = [
  'account-deletion', 'application-actions', 'applications-repository', 'database-client', 'deletion-purge', 'document-actions',
  'document-sniff', 'documents-repository', 'form-body', 'google-sign-in', 'http-methods', 'ip-fingerprint', 'offer-prefill-action',
  'prefill-quota-repository', 'protected-routes', 'purge-schedule', 'repository-error', 'safe-redirect', 'schedule-actions',
  'scheduled-events-repository', 'security-headers', 'settings-repository', 'sign-in-origin', 'user-data',
];
const pilotTree = () => [
  ...many('src/lib/server', PILOT_SERVER),
  ...many('src/lib/server', ['account-deletion.test', 'document-sniff.test', 'form-body.test', 'security-headers.test']),
  'src/lib/server/email/mime.ts', 'src/lib/server/privileged/client.ts',
  'src/lib/applications/model.ts', 'src/lib/documents/limits.ts', 'src/routes/+page.svelte',
];

test('names: words, singular and plural, participles, test and companion files', () => {
  assert.deepEqual(tokenize('QuickAddDialog'), ['quick', 'add', 'dialog']);
  assert.deepEqual(tokenize('sign-in-origin'), ['sign', 'in', 'origin']);
  assert.deepEqual(tokenize('HTTPServer_config'), ['http', 'server', 'config']);
  for (const [a, b] of [['application', 'applications'], ['category', 'categories'], ['address', 'addresses'], ['schedule', 'scheduled'], ['status', 'statuses']]) assert.ok(related(a, b), `${a} ~ ${b}`);
  for (const [a, b] of [['in', 'ind'], ['file', 'files2'], ['user', 'users-x'], ['form', 'forms-data']]) assert.ok(!related(a, b), `${a} !~ ${b}`);
  assert.equal(parseName('src/a/x.test.ts').test, true);
  assert.equal(parseName('src/a/sample.fixture.ts').test, true);
  assert.equal(parseName('tests/e2e/helpers.ts').test, true);
  assert.equal(parseName('src/a/Card.svelte').component, true);
  assert.equal(parseName('src/a/use-card.tsx').component, false);
  assert.equal(parseName('src/routes/+page.server.ts').reserved, true);
  assert.equal(parseName('src/a/index.ts').reserved, true);
  assert.equal(parseName('docs/guide.md'), null);
  assert.equal(parseName('supabase/migrations/001.sql'), null);
});

test('flat-folder counts code files only, tests and companion files apart', () => {
  const twelve = many('src/lib/util', ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']);
  const withTests = [...twelve, ...twelve.map(p => p.replace('.ts', '.test.ts')), 'src/lib/util/alpha.svelte.ts', 'src/lib/util/bravo.d.ts'];
  assert.deepEqual(analyze(withTests).findings, [], '12 code files, their tests and companions: nothing');
  const report = analyze([...withTests, 'src/lib/util/mike.ts']);
  assert.deepEqual(codes(report), ['src/lib/util:flat-folder']);
  const [flat] = report.findings;
  assert.equal(flat.severity, 'warning');
  assert.equal(flat.files.length, 13);
  assert.match(flat.proposal, /13 fichiers de code directement dans le dossier \(seuil 12\)/);
  assert.deepEqual(flat.moves, []);
  assert.deepEqual(report.folders, [{ folder: 'src/lib/util', code: 13, tests: 12, companions: 2, unplaced: report.folders[0].unplaced }]);
  assert.equal(report.ok, true);
  assert.deepEqual(analyze([...withTests, 'src/lib/util/mike.ts'], { maxFlatFiles: 13 }).findings, [], 'threshold from the configuration');
});

test('repeated-prefix groups a domain, singular and plural together, and moves its tests', () => {
  const report = analyze(['src/server/application-actions.ts', 'src/server/applications-repository.ts', 'src/server/application-actions.test.ts', 'src/server/other.ts']);
  assert.deepEqual(codes(report), ['src/server:repeated-prefix']);
  assert.deepEqual(report.findings[0].files, ['src/server/application-actions.ts', 'src/server/applications-repository.ts']);
  assert.deepEqual(report.plan, [
    { from: 'src/server/application-actions.test.ts', to: 'src/server/applications/actions.test.ts' },
    { from: 'src/server/application-actions.ts', to: 'src/server/applications/actions.ts' },
    { from: 'src/server/applications-repository.ts', to: 'src/server/applications/repository.ts' },
  ]);
  // Three plain files, or a domain named by a folder of the project, qualify too.
  assert.equal(moveOf(analyze(many('src/lib', ['user-avatar', 'user-profile', 'user-settings'])), 'src/lib/user-profile.ts'), 'src/lib/user/profile.ts');
  const known = analyze(['src/lib/server/document-sniff.ts', 'src/lib/server/documents-limits.ts', 'src/lib/documents/names.ts']);
  assert.equal(moveOf(known, 'src/lib/server/document-sniff.ts'), 'src/lib/server/documents/sniff.ts');
  // camelCase and snake_case names keep their style.
  assert.equal(moveOf(analyze(many('src/lib', ['userAvatar', 'userProfile', 'userSettings'])), 'src/lib/userProfile.ts'), 'src/lib/user/profile.ts');
  assert.equal(moveOf(analyze(many('app', ['order_models', 'order_views', 'order_forms'], 'py')), 'app/order_views.py'), 'app/order/views.py');
});

test('repeated-prefix avoids false positives', () => {
  // Two plain files that share a qualifier word are not a domain.
  assert.deepEqual(analyze(['src/lib/documents/file-name.ts', 'src/lib/documents/file-type.ts']).findings, []);
  // A domain folder already arranged: the shared word is the folder's own name.
  const settings = many('src/lib/components/settings', ['SettingsAccount', 'SettingsAppearance', 'SettingsData', 'SettingsHelp', 'SettingsProfile', 'SettingsSection'], 'svelte');
  assert.deepEqual(analyze([...settings, 'src/lib/settings/settings-model.ts', 'src/lib/settings/settings-store.ts', 'src/lib/settings/settings-defaults.ts']).findings, []);
  // Components share prefixes by convention: grouped only in a flat folder, by three or more.
  const components = many('src/lib/components/applications', ['QuickAddDialog', 'QuickAddForm', 'QuickAddOffer', 'BoardCard', 'BoardView', 'Pin'], 'svelte');
  assert.deepEqual(analyze(components).findings, []);
  const crowded = [...components, ...many('src/lib/components/applications', ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1'], 'svelte')];
  const report = analyze(crowded);
  assert.deepEqual(codes(report), ['src/lib/components/applications:flat-folder', 'src/lib/components/applications:repeated-prefix']);
  assert.equal(moveOf(report, 'src/lib/components/applications/QuickAddForm.svelte'), 'src/lib/components/applications/quick-add/QuickAddForm.svelte');
  assert.equal(moveOf(report, 'src/lib/components/applications/BoardCard.svelte'), undefined, 'two components stay');
  // Framework and entry files are never grouped.
  assert.deepEqual(analyze(['src/routes/+page.svelte', 'src/routes/+page.server.ts', 'src/routes/+layout.svelte', 'src/lib/index.ts']).findings, []);
});

test('mixed-roles: actions, data access and HTTP helpers of several domains side by side', () => {
  const report = analyze(many('src/server', ['order-actions', 'orders-repository', 'invoice-actions', 'invoice-repository', 'payment-client', 'security-headers', 'http-methods', 'misc']));
  assert.deepEqual(codes(report), ['src/server:repeated-prefix', 'src/server:repeated-prefix', 'src/server:mixed-roles']);
  const mixed = report.findings.find(f => f.code === 'mixed-roles');
  assert.match(mixed.proposal, /Les rôles actions, client, http, repository se mêlent pour 3 domaines/);
  assert.deepEqual(mixed.moves, [
    { from: 'src/server/payment-client.ts', to: 'src/server/payment/client.ts' },
    { from: 'src/server/http-methods.ts', to: 'src/server/http/http-methods.ts' },
    { from: 'src/server/security-headers.ts', to: 'src/server/http/security-headers.ts' },
  ]);
  assert.equal(moveOf(report, 'src/server/orders-repository.ts'), 'src/server/orders/repository.ts');
  // A folder already arranged by domain mixes roles for one domain only: nothing to say.
  assert.deepEqual(analyze(['src/server/orders/actions.ts', 'src/server/orders/repository.ts', 'src/server/orders/order-client.ts']).findings, []);
  // Roles come from the configuration: a default removed, a new suffix added.
  const custom = { roles: { '-actions': null, '-gateway': 'client' } };
  const gateways = many('src/server', ['order-actions', 'user-gateway', 'payment-gateway', 'invoice-repository']);
  const configured = analyze(gateways, custom);
  assert.deepEqual(codes(configured), ['src/server:mixed-roles']);
  assert.equal(moveOf(configured, 'src/server/payment-gateway.ts'), 'src/server/payment/gateway.ts');
  assert.equal(moveOf(configured, 'src/server/order-actions.ts'), undefined, 'the removed role no longer counts');
  assert.deepEqual(analyze(gateways).findings, [], 'gateway is no default role: two files with a role are not yet a pattern');
});

test('stray-file: a lone file named after a neighbouring domain folder', () => {
  const report = analyze(['src/lib/email-templates.ts', 'src/lib/email-templates.test.ts', 'src/lib/email/mime.ts', 'src/lib/email.ts', 'src/lib/other.ts']);
  assert.deepEqual(codes(report), ['src/lib:stray-file']);
  assert.deepEqual(report.findings[0].files, ['src/lib/email-templates.ts']);
  assert.deepEqual(report.plan, [
    { from: 'src/lib/email-templates.test.ts', to: 'src/lib/email/templates.test.ts' },
    { from: 'src/lib/email-templates.ts', to: 'src/lib/email/templates.ts' },
  ]);
  // A move never overwrites a tracked file: the name is kept, or the file stays.
  assert.equal(moveOf(analyze(['src/lib/email-templates.ts', 'src/lib/email/templates.ts']), 'src/lib/email-templates.ts'), 'src/lib/email/email-templates.ts');
});

test('the pilot server folder is found without configuration, with a domain plan', () => {
  const report = analyze(pilotTree());
  assert.deepEqual(codes(report), ['src/lib/server:flat-folder', 'src/lib/server:repeated-prefix', 'src/lib/server:repeated-prefix', 'src/lib/server:repeated-prefix', 'src/lib/server:mixed-roles']);
  const expected = {
    'application-actions': 'applications/actions', 'documents-repository': 'documents/repository', 'document-sniff': 'documents/sniff',
    'database-client': 'database/client', 'settings-repository': 'settings/repository', 'offer-prefill-action': 'offer-prefill/action',
    'prefill-quota-repository': 'offer-prefill/quota-repository', 'account-deletion': 'account/deletion', 'deletion-purge': 'account/deletion-purge',
    'purge-schedule': 'account/purge-schedule', 'form-body': 'http/form-body', 'security-headers': 'http/security-headers',
    'google-sign-in': 'auth/google-sign-in', 'schedule-actions': 'schedule/actions',
  };
  for (const [from, to] of Object.entries(expected)) assert.equal(moveOf(report, `src/lib/server/${from}.ts`), `src/lib/server/${to}.ts`, from);
  assert.equal(moveOf(report, 'src/lib/server/account-deletion.test.ts'), 'src/lib/server/account/deletion.test.ts');
  assert.deepEqual(report.folders[0].unplaced, many('src/lib/server', ['protected-routes', 'repository-error', 'safe-redirect', 'user-data']));
  // Once the plan is applied, the folder has nothing left to report.
  const moved = new Map(report.plan.map(m => [m.from, m.to]));
  const after = analyze(pilotTree().map(p => moved.get(p) ?? p));
  assert.deepEqual(after.findings, [], JSON.stringify(after.findings, null, 1));
  // --path restricts the findings to a folder and its subfolders.
  assert.deepEqual(analyze(pilotTree(), undefined, { paths: ['src/lib/documents'] }).findings, []);
  assert.equal(analyze(pilotTree(), undefined, { paths: ['src/lib'] }).findings.length, 5);
});

test('configuration: known domains, roots, ignore, severity; invalid values refused', () => {
  const offer = analyze(many('src/lib', ['offer-prefill-action', 'offer-prefill-reader']), { domains: ['offer-prefill'] });
  assert.equal(moveOf(offer, 'src/lib/offer-prefill-reader.ts'), 'src/lib/offer-prefill/reader.ts');
  assert.deepEqual(analyze(many('src/lib', ['offer-prefill-action', 'offer-prefill-reader'])).findings, []);
  assert.deepEqual(analyze(pilotTree(), { roots: ['src/routes', 'src/lib/applications'] }).findings, []);
  assert.deepEqual(analyze(pilotTree(), { ignore: ['src/lib/server/*.ts'] }).findings, []);
  assert.deepEqual(analyze(many('vendor/lib', ['user-a', 'user-b', 'user-c'])).findings, [], 'vendor folders ignored by default');
  assert.deepEqual(analyze(many('.claude/hooks', ['user-a', 'user-b', 'user-c'])).findings, [], 'tool folders ignored by default');
  const errors = analyze(pilotTree(), { severity: 'error' });
  assert.equal(errors.ok, false);
  assert.ok(errors.findings.every(f => f.severity === 'error'));
  const one = analyze(pilotTree(), { severity: { 'flat-folder': 'error' } });
  assert.deepEqual(one.findings.map(f => f.severity), ['error', 'warning', 'warning', 'warning', 'warning']);
  assert.ok(DEFAULT_ROLES['-repository'] === 'repository' && DEFAULT_ROLES.http === 'http');

  const issues = raw => configIssues({ structure: raw }).issues.map(i => i.message).join('\n');
  assert.equal(issues({ roots: ['src'], maxFlatFiles: 20, roles: { '-gateway': 'client', http: null }, domains: ['offer-prefill'], ignore: ['src/generated/**'], severity: { 'mixed-roles': 'error' } }), '');
  assert.match(issues({ roots: ['../dehors'] }), /structure\.roots : chemin relatif dans le dépôt attendu/);
  assert.match(issues({ ignore: ['/etc/**'] }), /structure\.ignore : chemin relatif/);
  assert.match(issues({ maxFlatFiles: 1 }), /maxFlatFiles/);
  assert.match(issues({ severity: 'fatal' }), /severity/);
  assert.match(issues({ severity: { 'flat-files': 'error' } }), /severity/);
  assert.match(issues({ roles: { 'Actions': 'x' } }), /roles/);
  assert.match(issues({ domains: ['Offer Prefill'] }), /domains/);
  assert.match(issues({ unknown: true }), /unknown property unknown/);
});

/** Git repository with the pilot server tree committed. */
function pilotRepo(t, extra = {}) {
  const files = Object.fromEntries(pilotTree().map(p => [p, 'export {};\n']));
  return fixture(t, { files: { ...files, ...extra } });
}

test('apv structure check: text, JSON, tracked files only, exit codes', async t => {
  const f = pilotRepo(t, { '.gitignore': 'node_modules/\ndist/\ngenerated/\n' });
  // Untracked and ignored files are never analysed.
  for (const n of ['user-a', 'user-b', 'user-c']) {
    write(f.repo, `src/lib/loose/${n}.ts`, 'export {};\n');
    write(f.repo, `generated/${n}.ts`, 'export {};\n');
  }
  const text = await apv(f.repo, ['structure', 'check']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Arborescence : \d+ fichier\(s\) de code suivis analysés, 5 constat\(s\), dont 0 de gravité error\./);
  assert.match(text.stdout, /src\/lib\/server\/ : 24 fichier\(s\) de code, 4 test\(s\), 0 compagnon\(s\)/);
  assert.match(text.stdout, /\[avertissement\] mixed-roles : /);
  assert.match(text.stdout, /    account-deletion\.ts -> account\/deletion\.ts \(avec account-deletion\.test\.ts\)/);
  assert.match(text.stdout, /Restent en place, à décider avec l'opérateur : protected-routes\.ts, repository-error\.ts, safe-redirect\.ts, user-data\.ts/);
  assert.match(text.stdout, /Jamais appliqué par apv/);
  assert.doesNotMatch(text.stdout, /loose|generated/);
  assert.ok(!/[–—]/.test(text.stdout), 'no em or en dash');

  const out = await apv(f.repo, ['structure', 'check', '--json']);
  assert.equal(out.code, 0);
  const report = out.json();
  assert.deepEqual(Object.keys(report).sort(), ['analyzedFiles', 'findings', 'folders', 'maxFlatFiles', 'ok', 'paths', 'plan', 'repo'].sort());
  assert.equal(report.ok, true);
  assert.deepEqual(Object.keys(report.findings[0]).sort(), ['code', 'files', 'folder', 'moves', 'proposal', 'severity']);
  assert.ok(report.plan.some(m => m.from === 'src/lib/server/form-body.ts' && m.to === 'src/lib/server/http/form-body.ts'));
  assert.equal(git(f.repo, 'status', '--porcelain', '--', 'src/lib/server'), '', 'nothing moved');

  const scoped = (await apv(f.repo, ['structure', 'check', '--path', 'src/lib/applications', '--path', 'src/routes', '--json'])).json();
  assert.deepEqual([scoped.findings, scoped.paths], [[], ['src/lib/applications', 'src/routes']]);
  const sub = await apv(join(f.repo, 'src'), ['structure', 'check', '--path', 'src/lib/server']);
  assert.match(sub.stdout, /\(dans src\/lib\/server\), 5 constat/, 'paths are relative to the repository root');

  write(f.repo, '.apv/config.json', { structure: { severity: { 'mixed-roles': 'error' } } });
  const failed = await apv(f.repo, ['structure', 'check']);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /dont 1 de gravité error/);
  assert.match(failed.stdout, /\[erreur\] mixed-roles/);
  assert.equal((await apv(f.repo, ['structure', 'check', '--path', 'src/routes'])).code, 0, 'outside the scope, no error');

  write(f.repo, '.apv/config.json', { structure: { roots: ['../x'] } });
  const invalid = await apv(f.repo, ['structure', 'check']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /structure\.roots/);
});

test('apv structure check: wrong invocations exit 2', async t => {
  const f = fixture(t);
  for (const args of [['structure'], ['structure', 'fix'], ['structure', 'check', 'extra'], ['structure', 'check', '--path', '../dehors'], ['structure', 'check', '--bogus']]) {
    const out = await apv(f.repo, args);
    assert.equal(out.code, 2, args.join(' '));
    assert.match(out.stderr, /Utilisation :\n  apv structure check/);
  }
  const help = await apv(f.repo, ['help', 'structure']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /flat-folder[\s\S]*repeated-prefix[\s\S]*mixed-roles[\s\S]*stray-file/);
  const clean = await apv(f.repo, ['structure', 'check']);
  assert.deepEqual([clean.code, clean.stdout.trim().split('\n').at(-1)], [0, 'Aucun constat.']);
});

test('the structure section is read by the common loader, never reported as ignored', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { structure: { maxFlatFiles: 20, domains: ['offer-prefill'] } });
  const status = (await apv(f.repo, ['status', '--json'])).json();
  assert.deepEqual([status.config.ignored, status.config.error], [[], null]);
  write(f.repo, '.apv/config.json', { structure: { maxFlatFiles: 'vingt' } });
  assert.match((await apv(f.repo, ['status', '--json'])).json().config.error, /maxFlatFiles/);
});
