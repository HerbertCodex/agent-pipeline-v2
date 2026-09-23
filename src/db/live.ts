import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { DbConfig } from './config.js';
import type { Finding } from './checks.js';

export interface LiveReport {
  status: 'skipped' | 'ran' | 'failed';
  reason: string | null;
  findings: Finding[];
  /** One line per executed check, for the human report. */
  details: string[];
}

export type PsqlRunner = (sql: string) => string;

export const LIVE_RULES = {
  fkIndex: 'live.fk_index',
  rls: 'live.rls',
  seqScan: 'live.explain_seq_scan',
  error: 'live.error',
  skipped: 'live.skipped',
} as const;

export function findExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Connection settings passed through libpq variables: the password never appears in the process list. */
export function connectionEnv(url: string): { env: Record<string, string>; args: string[] } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { env: {}, args: [`--dbname=${url}`] };
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return { env: {}, args: [`--dbname=${url}`] };
  const env: Record<string, string> = {};
  if (parsed.hostname) env.PGHOST = decodeURIComponent(parsed.hostname);
  if (parsed.port) env.PGPORT = parsed.port;
  if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database) env.PGDATABASE = database;
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return { env, args: [] };
}

/**
 * Splits a command line written in one variable (APV_PSQL) into argv, without a shell: blanks
 * separate words, single quotes are literal, double quotes and backslashes escape. No expansion.
 */
export function splitCommand(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") { if (c === "'") quote = null; else current += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < text.length && /["\\$`]/.test(text[i + 1]!)) current += text[++i]!;
      else current += c;
      continue;
    }
    if (/\s/.test(c)) { if (started) { words.push(current); current = ''; started = false; } continue; }
    started = true;
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\' && i + 1 < text.length) current += text[++i]!;
    else current += c;
  }
  if (quote) throw new Error(`APV_PSQL : guillemet ${quote} non fermé`);
  if (started) words.push(current);
  return words;
}

/**
 * Every script runs in a session whose transactions are read-only: the live checks only read the
 * catalog and EXPLAIN (never ANALYZE), and a configured query can never write, even by mistake.
 */
export const READ_ONLY_PREFIX = 'set default_transaction_read_only = on;\n';

/**
 * Runs psql with `-f -`. `psql` is an executable path, or a whole command (APV_PSQL, for example
 * `docker exec -i <conteneur> psql -U postgres -d postgres`) to which the psql options are appended.
 * With a URL, the connection goes through libpq variables; without one, the command carries it.
 */
export function psqlRunner(psql: string | readonly string[], url: string | undefined, baseEnv: NodeJS.ProcessEnv): PsqlRunner {
  const connection = url ? connectionEnv(url) : { env: {}, args: [] };
  const password = connection.env.PGPASSWORD;
  const [command, ...prefix] = typeof psql === 'string' ? [psql] : psql;
  if (!command) throw new Error('commande psql vide');
  return (sql) => {
    const result = spawnSync(command, [...prefix, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...connection.args, '-f', '-'], {
      input: READ_ONLY_PREFIX + sql, encoding: 'utf8', timeout: 60_000, env: { ...baseEnv, ...connection.env },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const message = (result.stderr || `psql a terminé avec le code ${result.status}`).trim();
      throw new Error(password ? message.split(password).join('***') : message);
    }
    return result.stdout;
  };
}

const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const schemaArray = (schemas: string[]): string => `array[${schemas.map(literal).join(', ')}]::text[]`;

/** Parses psql output; tolerates command tags (BEGIN, ROLLBACK) around the JSON value. */
export function parseJsonOutput<T>(output: string): T | null {
  const text = output.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (start < 0 || end < start) throw new Error(`sortie psql illisible : ${text.slice(0, 200)}`);
    return JSON.parse(text.slice(start, end + 1)) as T;
  }
}

/**
 * SQL condition: index `i` can serve the checks of foreign key `k`. A total index can; a partial index
 * can too when its predicate only says that foreign key columns are not null (`where col is not null`),
 * because the lookups of the key (`col = $1`, a strict operator) imply it. Any other predicate cannot.
 */
const USABLE_FOR_FK = `(i.indpred is null or not exists (
      select 1 from regexp_split_to_table(regexp_replace(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '[()]', '', 'g'), '\\s+AND\\s+') term
      where coalesce(substring(term from '^\\s*"?([^"\\s]+)"?\\s+IS NOT NULL\\s*$'), '') <> all (
        select a.attname::text from pg_catalog.pg_attribute a where a.attrelid = k.conrelid and a.attnum = any (k.conkey))))`;

export const FK_INDEX_SQL = (schemas: string[]) => `
select json_agg(row_to_json(t)) from (
  select n.nspname as schema, c.relname as table, k.conname as name,
    (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(attnum, ord)
       join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) as columns,
    exists (select 1 from pg_catalog.pg_index i where i.indrelid = k.conrelid and ${USABLE_FOR_FK} and i.indkey[0] = k.conkey[1]) as leading_covered
  from pg_catalog.pg_constraint k
  join pg_catalog.pg_class c on c.oid = k.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where k.contype = 'f' and n.nspname = any(${schemaArray(schemas)})
    and not exists (
      select 1 from pg_catalog.pg_index i
      where i.indrelid = k.conrelid and ${USABLE_FOR_FK}
        and (select array_agg(u.attnum) from unnest(i.indkey::int2[]) with ordinality u(attnum, ord)
             where u.ord <= array_length(k.conkey, 1)) @> k.conkey
        and array_length(k.conkey, 1) <= i.indnkeyatts
    )
  order by 1, 2, 3
) t;
`;

export const RLS_SQL = (schemas: string[]) => `
select json_agg(row_to_json(t)) from (
  select n.nspname as schema, c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
    exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped) as has_user_id,
    (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid)::int as policies
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname = any(${schemaArray(schemas)})
  order by 1, 2
) t;
`;

export const EXPLAIN_SQL = (sql: string) => `begin transaction read only;
explain (format json, verbose) ${sql.trim().replace(/;+\s*$/, '')};
rollback;
`;

export const RELTUPLES_SQL = (relations: string[]) => `
select json_object_agg(r, coalesce((select c.reltuples::bigint from pg_catalog.pg_class c where c.oid = to_regclass(r)), -1))
from unnest(array[${relations.map(literal).join(', ')}]::text[]) r;
`;

interface PlanNode { 'Node Type'?: string; 'Relation Name'?: string; Schema?: string; 'Plan Rows'?: number; Plans?: PlanNode[] }

export function seqScans(plan: PlanNode, found: { relation: string; planRows: number }[] = []): { relation: string; planRows: number }[] {
  if (plan['Node Type'] === 'Seq Scan' && plan['Relation Name']) {
    found.push({ relation: `${plan.Schema ?? 'public'}.${plan['Relation Name']}`, planRows: plan['Plan Rows'] ?? 0 });
  }
  for (const child of plan.Plans ?? []) seqScans(child, found);
  return found;
}

const where = (name: string) => ({ file: '(base en direct)', line: 0, target: name });

/**
 * Live checks, read-only: missing FK indexes, RLS state, EXPLAIN of the configured queries. The
 * database is reached by APV_PSQL (a whole psql command, which carries its own connection, for
 * example through `docker exec`), or by psql from the PATH with APV_DB_URL. Skipped, and said so,
 * when neither is usable.
 */
export function runLiveChecks(config: DbConfig, env: NodeJS.ProcessEnv, runner?: PsqlRunner): LiveReport {
  const url = env.APV_DB_URL;
  if (!runner && env.APV_PSQL !== undefined && env.APV_PSQL.trim() !== '') {
    let command: string[];
    try {
      command = splitCommand(env.APV_PSQL);
    } catch (error) {
      return { status: 'skipped', reason: (error as Error).message, findings: [], details: [] };
    }
    runner = psqlRunner(command, url || undefined, env);
  }
  if (!runner) {
    if (!url) return { status: 'skipped', reason: 'ni APV_PSQL ni APV_DB_URL', findings: [], details: [] };
    const psql = findExecutable('psql', env);
    if (!psql) return { status: 'skipped', reason: 'psql introuvable dans le PATH', findings: [], details: [] };
    runner = psqlRunner(psql, url, env);
  }
  const findings: Finding[] = [];
  const details: string[] = [];
  try {
    const missing = parseJsonOutput<{ schema: string; table: string; name: string; columns: string[]; leading_covered: boolean }[]>(runner(FK_INDEX_SQL(config.liveSchemas))) ?? [];
    details.push(`clés étrangères sans index couvrant : ${missing.length}`);
    for (const fk of missing) {
      const partial = fk.leading_covered && fk.columns.length > 1;
      findings.push({
        rule: LIVE_RULES.fkIndex, severity: partial ? 'warning' : 'error', ...where(`${fk.schema}.${fk.table}.${fk.name}`),
        message: `clé étrangère ${fk.name} (${fk.columns.join(', ')}) de ${fk.schema}.${fk.table} ${partial ? 'couverte par un index sur sa première colonne seulement' : 'sans index couvrant'} (pg_catalog)`,
      });
    }
    const tables = parseJsonOutput<{ schema: string; table: string; enabled: boolean; forced: boolean; has_user_id: boolean; policies: number }[]>(runner(RLS_SQL(config.liveSchemas))) ?? [];
    details.push(`tables lues pour RLS : ${tables.length}`);
    for (const t of tables) {
      const key = `${t.schema}.${t.table}`;
      if (!t.has_user_id && !config.rlsTables.includes(key) && !config.rlsTables.includes(t.table)) continue;
      const missingRls = [!t.enabled && 'RLS non activée', !t.forced && 'RLS non forcée', t.policies === 0 && 'aucune politique'].filter(Boolean);
      if (missingRls.length > 0) findings.push({ rule: LIVE_RULES.rls, severity: 'error', ...where(key), message: `table utilisateur ${key} en base : ${missingRls.join(' ; ')}` });
    }
    for (const query of config.explain) {
      const plans = parseJsonOutput<{ Plan: PlanNode }[]>(runner(EXPLAIN_SQL(query.sql)));
      const scans = plans?.[0] ? seqScans(plans[0].Plan) : [];
      if (scans.length === 0) {
        details.push(`EXPLAIN ${query.name} : aucun parcours séquentiel`);
        continue;
      }
      const sizes = parseJsonOutput<Record<string, number>>(runner(RELTUPLES_SQL(scans.map((s) => s.relation)))) ?? {};
      for (const scan of scans) {
        const reltuples = sizes[scan.relation] ?? -1;
        const rows = reltuples >= 0 ? reltuples : scan.planRows;
        if (rows > config.seqScanRows) {
          findings.push({ rule: LIVE_RULES.seqScan, severity: 'error', ...where(query.name), message: `EXPLAIN ${query.name} : parcours séquentiel sur ${scan.relation} (${rows} lignes estimées, seuil ${config.seqScanRows})` });
        } else {
          details.push(`EXPLAIN ${query.name} : parcours séquentiel sur ${scan.relation} accepté (${rows} lignes estimées, seuil ${config.seqScanRows})`);
        }
      }
    }
  } catch (error) {
    findings.push({ rule: LIVE_RULES.error, severity: 'error', ...where('psql'), message: `contrôles en direct en échec : ${(error as Error).message}` });
    return { status: 'failed', reason: (error as Error).message, findings, details };
  }
  return { status: 'ran', reason: null, findings, details };
}
