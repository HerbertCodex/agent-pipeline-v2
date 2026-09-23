import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../dist/commands/db.js';
import { runDbCheck, formatHuman, formatJson } from '../dist/db/index.js';
import { tokenize, splitStatements } from '../dist/db/tokenizer.js';
import { parseMigrations } from '../dist/db/parser.js';
import { frenchWords } from '../dist/db/french.js';
import { globToRegExp, expandGlobs } from '../dist/db/glob.js';
import { scanSelectStar } from '../dist/db/code-scan.js';
import { connectionEnv, parseJsonOutput, psqlRunner, runLiveChecks, seqScans } from '../dist/db/live.js';
import { DEFAULT_DB_CONFIG, loadDbConfig } from '../dist/db/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const SUIVIE = join(here, 'fixtures', 'db-suivie');

/** Temporary project: { 'supabase/migrations/0001.sql': sql, '.apv/config.json': {...}, 'src/x.ts': code } */
function project(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'apv-db-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const migrate = (t, sql, extra = {}) => project(t, { 'supabase/migrations/0001_init.sql': sql, ...extra });
const check = (root, options = {}) => runDbCheck({ root, env: {}, ...options });
const byRule = (report, rule) => report.findings.filter((f) => f.rule === rule);

/** A user table that satisfies every rule; tests break one thing at a time. */
const GOOD_TABLE = `
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  constraint projects_user_id_idempotency_key_key unique (user_id, idempotency_key)
);
create index projects_user_id_created_at_idx on public.projects (user_id, created_at desc);
alter table public.projects enable row level security;
alter table public.projects force row level security;
create policy projects_select_own on public.projects for select to authenticated using ((select auth.uid()) = user_id);
`;

function captureIO(cwd, env = {}) {
  const out = { stdout: '', stderr: '' };
  return { out, io: { stdout: (s) => { out.stdout += s; }, stderr: (s) => { out.stderr += s; }, cwd, env } };
}

// ------------------------------------------------------------------ tokenizer and parser

test('tokenizer: comments, strings, dollar quotes, quoted identifiers and line numbers', () => {
  const sql = "-- comment ; here\ncreate table \"Weird\"\"Name\" (a text default 'it''s; fine');\n/* block ; /* nested */ */\ncreate function f() returns int as $body$ select 1; $body$ language sql;\nselect E'a\\'b;';";
  const statements = splitStatements(tokenize(sql));
  assert.equal(statements.length, 3);
  assert.equal(statements[0].line, 2);
  assert.equal(statements[1].line, 4);
  assert.equal(statements[2].line, 5);
  const quoted = statements[0].tokens.find((t) => t.kind === 'qident');
  assert.equal(quoted.value, 'Weird"Name');
  assert.equal(statements[1].tokens.find((t) => t.kind === 'string').value, ' select 1; ');
  assert.equal(statements[2].tokens.find((t) => t.kind === 'string').value, "a'b;");
});

test('tokenizer: begin atomic bodies stay in one statement; unterminated input is reported', (t) => {
  const statements = splitStatements(tokenize('create function f() returns int language sql begin atomic select case when true then 1 end; select 2; end; select 3;'));
  assert.equal(statements.length, 2);
  const root = migrate(t, "create table public.ok_items (id uuid primary key);\nselect 'never closed;");
  const report = check(root);
  const unreadable = byRule(report, 'parse.unreadable');
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0].severity, 'error');
  assert.equal(unreadable[0].line, 2);
});

test('parser: renames, drops, composite and alter-table foreign keys, partial and expression indexes', () => {
  const model = parseMigrations([{ path: 'm.sql', sql: `
    create table public.parents (id uuid primary key, user_id uuid not null, constraint parents_id_user_id_key unique (id, user_id));
    create table public.kids (id uuid primary key, parent_id uuid not null, user_id uuid not null, legacy text, nickname text);
    alter table public.kids add constraint kids_parent_fkey foreign key (parent_id, user_id) references public.parents (id, user_id) on delete cascade;
    create index kids_parent_idx on public.kids (parent_id, user_id) where legacy is null;
    create unique index kids_lower_nickname_idx on public.kids (lower(nickname));
    create index kids_legacy_idx on public.kids (legacy);
    alter table public.kids drop column legacy;
    alter table public.kids rename column nickname to display_name;
    alter table public.kids rename to children;
    alter table public.children rename constraint kids_parent_fkey to children_parent_fkey;
    create table public.trash (id uuid primary key);
    drop table if exists public.trash cascade;
  ` }]);
  assert.deepEqual([...model.tables.keys()], ['public.parents', 'public.children']);
  assert.deepEqual([...model.tables.get('public.children').columns.keys()], ['id', 'parent_id', 'user_id', 'display_name']);
  assert.deepEqual(model.foreignKeys.map((fk) => [fk.name, fk.table, fk.columns, fk.refTable, fk.refColumns]), [
    ['children_parent_fkey', 'public.children', ['parent_id', 'user_id'], 'public.parents', ['id', 'user_id']],
  ]);
  const names = model.indexes.map((ix) => ix.name);
  assert.ok(!names.includes('kids_legacy_idx'), 'index dropped with its column');
  assert.ok(!names.includes('kids_parent_idx'), 'an index whose predicate uses a dropped column is dropped too');
  assert.equal(model.indexes.find((ix) => ix.name === 'kids_lower_nickname_idx').columns[0], '(lower (nickname))');
  assert.ok(!names.includes('trash_pkey'));
});

test('parser: create or replace resets attributes, alter function and grants are followed', () => {
  const model = parseMigrations([{ path: 'm.sql', sql: `
    create function public.f(p_id uuid, out total int) returns int language plpgsql security definer as $$ begin end $$;
    create or replace function public.f(p_id uuid, out total int) returns int language plpgsql security invoker as $$ begin end $$;
    create function private.g(a text) returns void language sql security definer as $$ select 1 $$;
    alter function private.g(text) set search_path = pg_catalog, pg_temp;
    revoke execute on function private.g(text) from public;
    grant execute on function private.g to authenticated;
    create function public.h() returns trigger language plpgsql as $$ begin return new; end $$;
    drop function public.h();
  ` }]);
  assert.equal(model.functions.length, 2);
  const f = model.functions[0];
  assert.equal(f.securityDefiner, false, 'create or replace redefines security');
  assert.equal(f.argCount, 1, 'out arguments are not part of the signature');
  assert.equal(f.argTypes, 'uuid');
  assert.deepEqual([...f.executeGrants.keys()].sort(), ['anon', 'authenticated', 'public', 'service_role']);
  const g = model.functions[1];
  assert.deepEqual(g.searchPath, ['pg_catalog', 'pg_temp']);
  assert.deepEqual([...g.executeGrants.keys()], ['authenticated']);
  assert.equal(g.executeGrants.get('authenticated').explicit, true);
});

// ------------------------------------------------------------------ naming

test('naming: French and non snake_case identifiers are errors; English passes; allowFrench overrides', (t) => {
  const root = migrate(t, `
    create table public.entreprises (id uuid primary key, "raisonSociale" text, cree_le timestamptz, statut text, name text);
    create type public.statut_candidature as enum ('a', 'b');
    create function public.relancer_utilisateur() returns void language sql as $$ select 1 $$;
    create table public.companies (id uuid primary key, name text, created_at timestamptz, source text, message text, note text);
  `);
  const naming = byRule(check(root), 'naming.english_snake_case');
  const targets = naming.map((f) => f.target).sort();
  assert.deepEqual(targets, [
    'public.entreprises', 'public.entreprises.cree_le', 'public.entreprises.raisonSociale', 'public.entreprises.statut',
    'public.relancer_utilisateur', 'public.statut_candidature',
  ]);
  assert.ok(naming.every((f) => f.severity === 'error'));
  assert.match(naming.find((f) => f.target.endsWith('raisonSociale')).message, /pas en snake_case ASCII/);
  assert.match(naming.find((f) => f.target.endsWith('cree_le')).message, /mot français : cree_le/);
  assert.equal(naming.find((f) => f.target === 'public.entreprises').line, 2);

  const allowed = project(t, {
    'supabase/migrations/0001.sql': 'create table public.statut_items (id uuid primary key);',
    '.apv/config.json': { db: { allowFrench: ['statut'] } },
  });
  assert.equal(byRule(check(allowed), 'naming.english_snake_case').length, 0);
});

test('frenchWords: accents, plurals, phrases; English words are not flagged', () => {
  assert.deepEqual(frenchWords('date_envoi'), ['date_envoi']);
  assert.deepEqual(frenchWords('rendez_vous_at'), ['rendez_vous']);
  assert.deepEqual(frenchWords('Lieux'), ['lieu']);
  assert.deepEqual(frenchWords('intitulé_poste'), ['intitule', 'poste']);
  assert.deepEqual(frenchWords('salaires'), ['salaire']);
  for (const english of ['applications', 'job_title', 'sent_on', 'message', 'source', 'notes', 'status', 'follow_up', 'period', 'kind', 'location']) {
    assert.deepEqual(frenchWords(english), [], english);
  }
  assert.deepEqual(frenchWords('poste_id', ['poste']), []);
});

// ------------------------------------------------------------------ foreign key indexes

test('fk.index: missing index is an error, matching leading columns (any order) pass', (t) => {
  const root = migrate(t, `
    create table public.owners (id uuid primary key);
    create table public.pets (id uuid primary key, owner_id uuid references public.owners (id), vet_id uuid, user_id uuid);
    create table public.vets (id uuid primary key, user_id uuid, constraint vets_id_user_id_key unique (id, user_id));
    alter table public.pets add constraint pets_vet_fkey foreign key (vet_id, user_id) references public.vets (id, user_id);
    create index pets_user_id_vet_id_idx on public.pets (user_id, vet_id, id);
  `);
  const fk = byRule(check(root), 'fk.index');
  assert.equal(fk.length, 1);
  assert.equal(fk[0].severity, 'error');
  assert.equal(fk[0].target, 'public.pets.pets_owner_id_fkey');
  assert.equal(fk[0].line, 3);
});

test('fk.index: a partial index does not count; leading first column only is a warning', (t) => {
  const root = migrate(t, `
    create table public.parents (id uuid primary key, user_id uuid, constraint parents_id_user_id_key unique (id, user_id));
    create table public.a (id uuid primary key, parent_id uuid references public.parents (id));
    create index a_parent_id_idx on public.a (parent_id) where parent_id is not null;
    create table public.b (id uuid primary key, parent_id uuid, user_id uuid,
      constraint b_parent_fkey foreign key (parent_id, user_id) references public.parents (id, user_id));
    create index b_parent_id_idx on public.b (parent_id);
  `);
  const fk = byRule(check(root), 'fk.index');
  const a = fk.find((f) => f.target === 'public.a.a_parent_id_fkey');
  assert.equal(a.severity, 'error');
  assert.match(a.message, /index partiel a_parent_id_idx/);
  const b = fk.find((f) => f.target === 'public.b.b_parent_fkey');
  assert.equal(b.severity, 'warning');
  assert.match(b.message, /ne couvre que sa première colonne/);
});

// ------------------------------------------------------------------ RLS and policies

test('rls.enabled_forced: user tables need RLS enabled, forced and a policy', (t) => {
  const root = migrate(t, `
    ${GOOD_TABLE}
    create table public.notes_x (id uuid primary key, user_id uuid not null);
    create index notes_x_user_id_idx on public.notes_x (user_id);
    alter table public.notes_x enable row level security;
    create table public.settings_x (id uuid primary key);
    create table public.catalog_items (id uuid primary key);
    alter table public.catalog_items enable row level security;
  `, { '.apv/config.json': { db: { rlsTables: ['public.settings_x'] } } });
  const rls = byRule(check(root), 'rls.enabled_forced');
  assert.deepEqual(rls.map((f) => [f.target, f.severity]).sort(), [['public.notes_x', 'error'], ['public.settings_x', 'error']]);
  assert.match(rls.find((f) => f.target === 'public.notes_x').message, /RLS non forcée.*aucune politique/);
  assert.match(rls.find((f) => f.target === 'public.settings_x').message, /RLS non activée/);

  const open = migrate(t, 'create table public.open_items (id uuid primary key);');
  const warning = byRule(check(open), 'rls.enabled_forced');
  assert.equal(warning[0].severity, 'warning');
  assert.match(warning[0].message, /sans RLS activée/);
});

test('policy.too_broad: using (true) or with check (true) for open roles is a warning', (t) => {
  const root = migrate(t, `
    ${GOOD_TABLE}
    create policy projects_read_all on public.projects for select to authenticated using (true);
    create policy projects_insert_any on public.projects for insert with check ( ( true ) );
    create policy projects_service on public.projects for all to service_role using (true);
  `);
  const broad = byRule(check(root), 'policy.too_broad');
  assert.deepEqual(broad.map((f) => f.target).sort(), ['public.projects.projects_insert_any', 'public.projects.projects_read_all']);
  assert.ok(broad.every((f) => f.severity === 'warning'));
  assert.match(broad.find((f) => f.target.endsWith('insert_any')).message, /pour public/);
});

// ------------------------------------------------------------------ security definer

test('definer.search_path: missing or unsafe search_path is an error; empty or pg_catalog pass', (t) => {
  const root = migrate(t, `
    create function private.no_path() returns void language sql security definer as $$ select 1 $$;
    create function private.public_path() returns void language sql security definer set search_path = public as $$ select 1 $$;
    create function private.empty_path() returns void language sql security definer set search_path = '' as $$ select 1 $$;
    create function private.catalog_path() returns void language sql security definer set search_path to pg_catalog as $$ select 1 $$;
    create function private.fixed_later() returns void language sql security definer as $$ select 1 $$;
    alter function private.fixed_later() set search_path = '';
    create function private.invoker_no_path() returns void language sql as $$ select 1 $$;
    revoke execute on all functions in schema private from public;
  `);
  const paths = byRule(check(root), 'definer.search_path');
  assert.deepEqual(paths.map((f) => f.target).sort(), ['private.no_path', 'private.public_path']);
  assert.match(paths.find((f) => f.target === 'private.public_path').message, /search_path « public »/);
});

test('definer.execute_grant: explicit grant or default privilege left to public/anon is an error', (t) => {
  const root = migrate(t, `
    create function public.leaky() returns void language sql security definer set search_path = '' as $$ select 1 $$;
    create function public.granted() returns void language sql security definer set search_path = '' as $$ select 1 $$;
    revoke execute on function public.granted() from public, anon;
    grant execute on function public.granted() to anon;
    create function public.tight() returns void language sql security definer set search_path = '' as $$ select 1 $$;
    revoke execute on function public.tight() from public, anon, authenticated;
    grant execute on function public.tight() to authenticated;
    create function public.trigger_fn() returns trigger language plpgsql security definer set search_path = '' as $$ begin return new; end $$;
  `);
  const grants = byRule(check(root), 'definer.execute_grant');
  assert.deepEqual(grants.map((f) => `${f.target}:${f.line}`).sort(), ['public.granted:5', 'public.leaky:2', 'public.leaky:2']);
  assert.match(grants.find((f) => f.target === 'public.granted').message, /execute accordé à anon/);
  assert.match(grants.find((f) => f.target === 'public.leaky').message, /par défaut ; ajouter « revoke execute/);

  const plainPostgres = project(t, {
    'supabase/migrations/0001.sql': "create function public.f() returns void language sql security definer set search_path = '' as $$ select 1 $$; revoke execute on function public.f() from public;",
    '.apv/config.json': { db: { supabaseDefaults: false } },
  });
  assert.equal(byRule(check(plainPostgres), 'definer.execute_grant').length, 0);
});

// ------------------------------------------------------------------ code

test('code.select_star: select(*), relation(*), empty select() and SQL strings; head counts accepted', () => {
  const code = [
    "const a = await db.from('t').select('*');",
    'const b = await db.from("t").select("id, owner(*)");',
    'const c = await db.from(`t`).insert(row).select();',
    'const d = await db.from("t").select("*", { count: "exact", head: true });',
    "const e = await db.from('t').select('id, title');",
    'const f = sql`SELECT * FROM things`;',
    "const g = 'select count(*) from things';",
    'inputElement.select();',
  ].join('\n');
  const findings = scanSelectStar('src/x.ts', code);
  assert.deepEqual(findings.map((f) => f.line), [1, 2, 3, 6]);
  assert.ok(findings.every((f) => f.rule === 'code.select_star' && f.severity === 'error'));
});

test('code.select_star scans configured globs and skips test files', (t) => {
  const root = migrate(t, GOOD_TABLE, {
    'src/lib/server/repo.ts': "export const q = (db) => db.from('projects').select('*');\n",
    'src/routes/+page.svelte': "<script>const r = db.from('projects').select()</script>\n",
    'src/lib/server/repo.test.ts': "db.from('projects').select('*');\n",
    'node_modules/pkg/index.js': "db.select('*')\n",
  });
  const report = check(root);
  assert.deepEqual(byRule(report, 'code.select_star').map((f) => `${f.file}:${f.line}`), ['src/lib/server/repo.ts:1', 'src/routes/+page.svelte:1']);
  assert.equal(report.codeFiles.length, 2);
});

// ------------------------------------------------------------------ redundancy and idempotency

test('redundancy.user_id_guard: child user_id needs a composite foreign key or an exception', (t) => {
  const sql = `
    create table public.boards (id uuid primary key, user_id uuid not null, constraint boards_id_user_id_key unique (id, user_id));
    create table public.cards (id uuid primary key, user_id uuid not null, board_id uuid not null references public.boards (id));
    create index cards_board_id_idx on public.cards (board_id);
    create table public.pins (id uuid primary key, user_id uuid not null, board_id uuid not null,
      constraint pins_board_fkey foreign key (board_id, user_id) references public.boards (id, user_id));
    create index pins_board_id_user_id_idx on public.pins (board_id, user_id);
  `;
  const guard = byRule(check(migrate(t, sql)), 'redundancy.user_id_guard');
  assert.equal(guard.length, 1);
  assert.equal(guard[0].target, 'public.cards.cards_board_id_fkey');
  assert.equal(guard[0].severity, 'warning');
  assert.match(guard[0].message, /\(board_id, user_id\)/);

  const excepted = check(migrate(t, sql, { '.apv/config.json': { db: { exceptions: [{ rule: 'redundancy.*', target: 'public.cards.*', reason: 'cartes partagées entre utilisateurs' }] } } }));
  assert.equal(byRule(excepted, 'redundancy.user_id_guard').length, 0);
  assert.equal(excepted.suppressed[0].reason, 'cartes partagées entre utilisateurs');
});

test('idempotency.create_tables: creation tables need an idempotency key or a natural unique key', (t) => {
  const root = migrate(t, `
    ${GOOD_TABLE}
    create table public.orders (id uuid primary key, user_id uuid not null, created_at timestamptz not null default now(),
      constraint orders_id_user_id_key unique (id, user_id));
    create table public.sends (id uuid primary key, user_id uuid not null, kind text, period text, created_at timestamptz,
      constraint sends_user_id_kind_period_key unique (user_id, kind, period));
    create table public.drafts (id uuid primary key, user_id uuid not null, created_at timestamptz);
    create unique index drafts_one_open_idx on public.drafts (user_id) where created_at is not null;
  `);
  const idem = byRule(check(root), 'idempotency.create_tables');
  assert.deepEqual(idem.map((f) => f.target), ['public.orders']);
  assert.equal(idem[0].severity, 'warning');
});

// ------------------------------------------------------------------ real project regressions

test('real project: the first migration is flagged for French names', (t) => {
  const root = project(t, {
    'supabase/migrations/20260921120000_init_candidatures.sql': readFileSync(join(SUIVIE, 'supabase/migrations/20260921120000_init_candidatures.sql'), 'utf8'),
  });
  const report = check(root);
  const naming = byRule(report, 'naming.english_snake_case');
  assert.deepEqual(naming.map((f) => f.target).sort(), [
    'public.candidatures', 'public.candidatures.date_candidature', 'public.candidatures.entreprise',
    'public.candidatures.intitule_poste', 'public.candidatures.statut', 'public.candidatures.url_offre',
  ]);
  assert.ok(naming.every((f) => f.file === 'supabase/migrations/20260921120000_init_candidatures.sql'));
  assert.equal(naming.find((f) => f.target === 'public.candidatures').line, 8);
  assert.equal(byRule(report, 'rls.enabled_forced').length, 0, 'RLS was already enabled and forced');
  assert.equal(byRule(report, 'fk.index').length, 0, 'user_id leads the (user_id, date_candidature) index');
  assert.equal(report.errors, 6);
});

test('real project: after the English rename the later migrations pass the rules they satisfy', () => {
  const report = check(SUIVIE);
  assert.equal(report.migrations.length, 6);
  for (const rule of ['naming.english_snake_case', 'rls.enabled_forced', 'policy.too_broad', 'definer.search_path', 'definer.execute_grant', 'redundancy.user_id_guard', 'parse.statement', 'parse.unreadable']) {
    assert.deepEqual(byRule(report, rule), [], rule);
  }
  assert.deepEqual(byRule(report, 'fk.index').map((f) => [f.target, f.severity]), [
    ['public.scheduled_events.scheduled_events_activity_event_fkey', 'error'],
    ['public.application_events.application_events_application_fkey', 'warning'],
    ['public.scheduled_events.scheduled_events_application_fkey', 'warning'],
  ]);
  assert.deepEqual(byRule(report, 'idempotency.create_tables').map((f) => f.target), ['public.applications', 'public.application_events', 'public.scheduled_events']);
  assert.ok(!byRule(report, 'idempotency.create_tables').some((f) => f.target === 'public.email_deliveries'), 'natural key (user_id, kind, period)');
  const applications = report.model.tables.get('public.applications');
  assert.ok(applications.columns.has('company') && !applications.columns.has('entreprise'));
  assert.equal(report.model.tables.has('pg_temp.legacy_status'), false, 'temporary table dropped');
});

// ------------------------------------------------------------------ config, output and command

test('config: invalid fields, missing reasons and missing migrations are reported, never ignored', (t) => {
  const root = project(t, { '.apv/config.json': { db: { migrations: 'db/*.sql', allowFrench: 'statut', exceptions: [{ rule: 'fk.index', target: 'x' }], bogus: 1 } } });
  const report = check(root);
  const config = byRule(report, 'config.invalid').map((f) => f.message);
  assert.ok(config.some((m) => /db.allowFrench/.test(m)));
  assert.ok(config.some((m) => /db.exceptions\[0\]/.test(m)));
  assert.ok(config.some((m) => /db.bogus : champ inconnu/.test(m)));
  assert.match(byRule(report, 'config.no_migrations')[0].message, /db\/\*\.sql/);

  const broken = project(t, { '.apv/config.json': '{ not json' });
  assert.match(loadDbConfig(broken).problems[0], /JSON invalide/);
  assert.match(loadDbConfig(broken, 'missing.json').problems[0], /introuvable/);
  assert.deepEqual(loadDbConfig(project(t, {})).config, DEFAULT_DB_CONFIG);
});

test('command: human table, --json, exit 1 on error and 0 on warnings only', async (t) => {
  const failing = migrate(t, 'create table public.lieux (id uuid primary key);');
  const human = captureIO(failing);
  assert.equal(await run(['check'], human.io), 1);
  assert.match(human.out.stdout, /SÉVÉRITÉ\s+RÈGLE\s+EMPLACEMENT\s+MESSAGE/);
  assert.match(human.out.stdout, /erreur\s+naming.english_snake_case\s+supabase\/migrations\/0001_init.sql:1/);
  assert.match(human.out.stdout, /Résultat : 1 erreur, 1 avertissement\./);

  const json = captureIO(failing);
  assert.equal(await run(['check', '--json'], json.io), 1);
  const parsed = JSON.parse(json.out.stdout);
  assert.equal(parsed.summary.errors, 1);
  assert.equal(parsed.model.tables, 1);
  assert.equal(parsed.findings[0].rule, 'naming.english_snake_case');

  const warningsOnly = migrate(t, 'create table public.open_items (id uuid primary key);');
  const w = captureIO(warningsOnly);
  assert.equal(await run(['check'], w.io), 0);

  const clean = migrate(t, GOOD_TABLE);
  const c = captureIO(clean);
  assert.equal(await run(['check'], c.io), 0);
  assert.match(c.out.stdout, /Aucun problème trouvé/);

  const usage = captureIO(clean);
  assert.equal(await run(['check', '--nope'], usage.io), 2);
  assert.equal(await run(['frobnicate'], usage.io), 2);
  assert.equal(await run([], usage.io), 2);
  const rooted = captureIO('/');
  assert.equal(await run(['check', '--root', clean], rooted.io), 0);
});

// ------------------------------------------------------------------ live checks

test('live: skipped explicitly when APV_DB_URL or psql is missing', async (t) => {
  const root = migrate(t, GOOD_TABLE);
  const noUrl = captureIO(root, { PATH: process.env.PATH });
  assert.equal(await run(['check', '--live'], noUrl.io), 0);
  assert.match(noUrl.out.stdout, /Contrôles en direct : ignorés \(APV_DB_URL absent\)/);
  assert.match(noUrl.out.stdout, /avertissement\s+live.skipped/);
  const noPsql = captureIO(root, { APV_DB_URL: 'postgres://u:p@localhost:5432/db', PATH: '/nonexistent' });
  await run(['check', '--live'], noPsql.io);
  assert.match(noPsql.out.stdout, /psql introuvable dans le PATH/);
});

test('live: fake psql on PATH, findings from pg_catalog and EXPLAIN, password kept out of argv', async (t) => {
  const root = migrate(t, GOOD_TABLE, {
    '.apv/config.json': { db: { explain: [{ name: 'liste', sql: 'select id from public.projects where user_id = $1;' }, { name: 'petite', sql: 'select id from public.tiny' }], seqScanRows: 1000 } },
  });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const record = join(root, 'psql-calls.jsonl');
  writeFileSync(join(bin, 'psql'), `#!${process.execPath}
const fs = require('fs');
const sql = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), password: process.env.PGPASSWORD, host: process.env.PGHOST, db: process.env.PGDATABASE }) + '\\n');
if (sql.includes("contype = 'f'")) console.log(JSON.stringify([{ schema: 'public', table: 'projects', name: 'projects_user_id_fkey', columns: ['user_id'], leading_covered: false }]));
else if (sql.includes('relrowsecurity')) console.log(JSON.stringify([{ schema: 'public', table: 'projects', enabled: true, forced: false, has_user_id: true, policies: 1 }, { schema: 'public', table: 'tiny', enabled: false, forced: false, has_user_id: false, policies: 0 }]));
else if (sql.includes('explain') && sql.includes('projects')) console.log(JSON.stringify([{ Plan: { 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'projects', Schema: 'public', 'Plan Rows': 12 }] } }]));
else if (sql.includes('explain')) console.log(JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'tiny', Schema: 'public', 'Plan Rows': 3 } }]));
else if (sql.includes('reltuples')) console.log(sql.includes('public.projects') ? '{"public.projects": 50000}' : '{"public.tiny": 3}');
`);
  chmodSync(join(bin, 'psql'), 0o755);
  const { io, out } = captureIO(root, { APV_DB_URL: 'postgresql://app:s%40cret@db.local:6543/main?sslmode=require', PATH: `${bin}:${process.env.PATH}` });
  assert.equal(await run(['check', '--live', '--json'], io), 1);
  const report = JSON.parse(out.stdout);
  assert.equal(report.live.status, 'ran');
  const rules = report.findings.map((f) => `${f.rule}:${f.target}`).sort();
  assert.deepEqual(rules, ['live.explain_seq_scan:liste', 'live.fk_index:public.projects.projects_user_id_fkey', 'live.rls:public.projects']);
  assert.ok(report.live.details.some((d) => /petite : parcours séquentiel sur public.tiny accepté/.test(d)));
  const calls = readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.every((c) => c.password === 's@cret' && c.host === 'db.local' && c.db === 'main'));
  assert.ok(calls.every((c) => !c.argv.join(' ').includes('s@cret')), 'password never in argv');
});

test('live: a psql failure is an error, with the password redacted', (t) => {
  const report = runLiveChecks(DEFAULT_DB_CONFIG, {}, () => { throw new Error('connection refused'); });
  assert.equal(report.status, 'failed');
  assert.equal(report.findings[0].rule, 'live.error');
  assert.equal(report.findings[0].severity, 'error');
  const root = migrate(t, GOOD_TABLE);
  const fake = join(root, 'psql');
  writeFileSync(fake, `#!${process.execPath}\nprocess.stderr.write('FATAL: password authentication failed (' + process.env.PGPASSWORD + ')');process.exit(2);\n`);
  chmodSync(fake, 0o755);
  assert.throws(() => psqlRunner(fake, 'postgres://u:hunter2@h/d', {})('select 1'), (error) => /FATAL: password authentication failed \(\*\*\*\)/.test(error.message) && !error.message.includes('hunter2'));
  const full = check(root, { live: true, psql: () => 'not json at all' });
  assert.equal(byRule(full, 'live.error').length, 1);
  assert.match(byRule(full, 'live.error')[0].message, /sortie psql illisible/);
});

test('live helpers: connection URL, tolerant JSON parsing and plan walking', () => {
  assert.deepEqual(connectionEnv('postgres://u:p%20w@h:5433/d'), { env: { PGHOST: 'h', PGPORT: '5433', PGUSER: 'u', PGPASSWORD: 'p w', PGDATABASE: 'd' }, args: [] });
  assert.deepEqual(connectionEnv('host=h dbname=d'), { env: {}, args: ['--dbname=host=h dbname=d'] });
  assert.deepEqual(parseJsonOutput('BEGIN\n[{"a":1}]\nROLLBACK'), [{ a: 1 }]);
  assert.equal(parseJsonOutput('  '), null);
  assert.deepEqual(seqScans({ 'Node Type': 'Hash Join', Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'x', 'Plan Rows': 5 }, { 'Node Type': 'Index Scan', 'Relation Name': 'y' }] }), [{ relation: 'public.x', planRows: 5 }]);
});

test('glob helpers', (t) => {
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/c.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/c.ts'));
  assert.ok(globToRegExp('src/**/*.{ts,svelte}').test('src/x/y.svelte'));
  assert.ok(globToRegExp('public.*').test('public.cards.fk'));
  const root = project(t, { 'a/1.sql': '', 'a/2.sql': '', 'a/b/3.sql': '', 'node_modules/x/4.sql': '' });
  assert.deepEqual(expandGlobs(root, ['a/*.sql']), ['a/1.sql', 'a/2.sql']);
  assert.deepEqual(expandGlobs(root, ['**/*.sql']), ['a/1.sql', 'a/2.sql', 'a/b/3.sql']);
});

test('formatters agree on counts', (t) => {
  const report = check(migrate(t, 'create table public.candidatures (id uuid primary key);'));
  assert.match(formatHuman(report), /Résultat : 1 erreur, 1 avertissement\./);
  assert.equal(JSON.parse(formatJson(report)).summary.warnings, 1);
});
