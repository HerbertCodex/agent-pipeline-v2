import { frenchWords, SNAKE_CASE } from './french.js';
import { globToRegExp } from './glob.js';
import type { DbConfig, DbException } from './config.js';
import type { ForeignKey, SchemaModel, Table } from './model.js';

export type Severity = 'error' | 'warning';

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  /** Object the finding is about, as used by `exceptions[].target`. */
  target: string;
  message: string;
}

export interface SuppressedFinding extends Finding { reason: string }

export const RULES = {
  naming: 'naming.english_snake_case',
  fkIndex: 'fk.index',
  rls: 'rls.enabled_forced',
  policyBroad: 'policy.too_broad',
  definerPath: 'definer.search_path',
  definerGrant: 'definer.execute_grant',
  selectStar: 'code.select_star',
  userIdGuard: 'redundancy.user_id_guard',
  idempotency: 'idempotency.create_tables',
} as const;

const SYSTEM_SCHEMAS = new Set(['pg_temp', 'pg_catalog', 'information_schema']);
const SAFE_SEARCH_PATHS = [[''], ['pg_catalog'], ['pg_catalog', 'pg_temp']];
const OPEN_ROLES = new Set(['public', 'anon', 'authenticated']);

const userTables = (model: SchemaModel): Table[] => [...model.tables.values()].filter((t) => !t.temporary && !SYSTEM_SCHEMAS.has(t.schema));
const keyOf = (t: Table): string => `${t.schema}.${t.name}`;

function checkNaming(model: SchemaModel, config: DbConfig): Finding[] {
  const findings: Finding[] = [];
  const check = (kind: string, identifier: string, target: string, file: string, line: number) => {
    const problems: string[] = [];
    if (!SNAKE_CASE.test(identifier)) problems.push('pas en snake_case ASCII');
    const french = frenchWords(identifier, config.allowFrench);
    if (french.length > 0) problems.push(`mot${french.length > 1 ? 's' : ''} français : ${french.join(', ')}`);
    if (problems.length > 0) {
      findings.push({ rule: RULES.naming, severity: 'error', file, line, target, message: `${kind} « ${identifier} » : ${problems.join(' ; ')} (identifiants en anglais snake_case)` });
    }
  };
  for (const table of userTables(model)) {
    check('table', table.name, keyOf(table), table.file, table.line);
    for (const column of table.columns.values()) check('colonne', column.name, `${keyOf(table)}.${column.name}`, column.file, column.line);
  }
  for (const type of model.types.values()) check(type.kind === 'domain' ? 'domaine' : 'type', type.name, `${type.schema}.${type.name}`, type.file, type.line);
  for (const fn of model.functions) check('fonction', fn.name, `${fn.schema}.${fn.name}`, fn.file, fn.line);
  return findings;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Columns a partial index predicate requires to be non-null, when it says nothing else
 * (`col is not null [and col2 is not null]`); null for any other predicate.
 */
export function notNullGuard(predicate: string): string[] | null {
  const terms = predicate.replace(/[()]/g, ' ').trim().split(/\s+and\s+/i);
  const columns: string[] = [];
  for (const term of terms) {
    const match = /^"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+is\s+not\s+null$/i.exec(term.trim());
    if (!match) return null;
    columns.push(match[1]!.toLowerCase());
  }
  return columns;
}

/**
 * Whether an index can serve the lookups of a foreign key: a total index can; so can a partial index
 * whose predicate only says key columns are not null, since the lookups (`col = $1`, a strict
 * operator) imply it. Any other predicate (for example `deleted_at is null`) cannot.
 */
function usableForKey(ix: SchemaModel['indexes'][number], fkColumns: string[]): boolean {
  if (!ix.partial || ix.predicate === null) return true;
  const guard = notNullGuard(ix.predicate);
  return guard !== null && guard.every((col) => fkColumns.includes(col));
}

function checkForeignKeyIndexes(model: SchemaModel): Finding[] {
  const findings: Finding[] = [];
  for (const fk of model.foreignKeys) {
    const table = model.tables.get(fk.table);
    if (!table || table.temporary) continue;
    const indexes = model.indexes.filter((ix) => ix.table === fk.table);
    const n = fk.columns.length;
    const full = indexes.find((ix) => usableForKey(ix, fk.columns) && ix.columns.length >= n && sameSet(ix.columns.slice(0, n), fk.columns));
    if (full) continue;
    const partialOnly = indexes.find((ix) => !usableForKey(ix, fk.columns) && ix.columns.length >= n && sameSet(ix.columns.slice(0, n), fk.columns));
    const leading = indexes.find((ix) => usableForKey(ix, fk.columns) && ix.columns[0] === fk.columns[0]);
    const cols = fk.columns.join(', ');
    const target = `${fk.table}.${fk.name}`;
    if (leading && n > 1) {
      findings.push({
        rule: RULES.fkIndex, severity: 'warning', file: fk.file, line: fk.line, target,
        message: `clé étrangère ${fk.name} (${cols}) vers ${fk.refTable} : l'index ${leading.name} (${leading.columns.join(', ')}) ne couvre que sa première colonne ; un index (${cols}) couvre la clé entière`,
      });
      continue;
    }
    findings.push({
      rule: RULES.fkIndex, severity: 'error', file: fk.file, line: fk.line, target,
      message: `clé étrangère ${fk.name} (${cols}) vers ${fk.refTable} sans index dont les premières colonnes sont (${cols})`
        + (partialOnly ? ` ; l'index partiel ${partialOnly.name} (where ${partialOnly.predicate}) ne sert pas aux vérifications de la clé` : ''),
    });
  }
  return findings;
}

function checkRls(model: SchemaModel, config: DbConfig): Finding[] {
  const findings: Finding[] = [];
  for (const table of userTables(model)) {
    if (table.schema !== 'public') continue;
    const key = keyOf(table);
    const listed = config.rlsTables.includes(key) || config.rlsTables.includes(table.name);
    const policies = model.policies.filter((p) => p.table === key);
    if (table.columns.has('user_id') || listed) {
      const missing: string[] = [];
      if (!table.rlsEnabled) missing.push('RLS non activée (enable row level security)');
      if (!table.rlsForced) missing.push('RLS non forcée (force row level security)');
      if (policies.length === 0) missing.push('aucune politique');
      if (missing.length > 0) {
        findings.push({ rule: RULES.rls, severity: 'error', file: table.file, line: table.line, target: key, message: `table utilisateur ${key} : ${missing.join(' ; ')}` });
      }
    } else if (!table.rlsEnabled) {
      findings.push({ rule: RULES.rls, severity: 'warning', file: table.file, line: table.line, target: key, message: `table ${key} exposée par l'API sans RLS activée` });
    }
  }
  return findings;
}

const isTrue = (expr: string | null): boolean => expr !== null && expr.replace(/[()\s]/g, '').toLowerCase() === 'true';

function checkPolicies(model: SchemaModel): Finding[] {
  const findings: Finding[] = [];
  for (const policy of model.policies) {
    const roles = policy.roles.filter((r) => OPEN_ROLES.has(r));
    if (roles.length === 0) continue;
    const clauses = [isTrue(policy.using) ? 'using (true)' : null, isTrue(policy.withCheck) ? 'with check (true)' : null].filter(Boolean);
    if (clauses.length === 0) continue;
    findings.push({
      rule: RULES.policyBroad, severity: 'warning', file: policy.file, line: policy.line, target: `${policy.table}.${policy.name}`,
      message: `politique « ${policy.name} » sur ${policy.table} : ${clauses.join(' et ')} pour ${roles.join(', ')} (toutes les lignes)`,
    });
  }
  return findings;
}

function checkDefiners(model: SchemaModel): Finding[] {
  const findings: Finding[] = [];
  for (const fn of model.functions) {
    if (!fn.securityDefiner) continue;
    const target = `${fn.schema}.${fn.name}`;
    const signature = `${target}(${fn.argTypes})`;
    if (fn.searchPath === null) {
      findings.push({ rule: RULES.definerPath, severity: 'error', file: fn.file, line: fn.line, target, message: `fonction security definer ${signature} sans « set search_path = '' »` });
    } else if (!SAFE_SEARCH_PATHS.some((safe) => safe.length === fn.searchPath?.length && safe.every((s, i) => s === fn.searchPath?.[i]))) {
      findings.push({
        rule: RULES.definerPath, severity: 'error', file: fn.file, line: fn.line, target,
        message: `fonction security definer ${signature} : search_path « ${fn.searchPath.map((s) => (s === '' ? "''" : s)).join(', ')} » ; attendu '' ou pg_catalog`,
      });
    }
    if (/^(trigger|event_trigger)$/.test(fn.returns.trim())) continue;
    for (const role of ['public', 'anon']) {
      const grant = fn.executeGrants.get(role);
      if (!grant) continue;
      findings.push({
        rule: RULES.definerGrant, severity: 'error', file: grant.file, line: grant.line, target,
        message: grant.explicit
          ? `fonction security definer ${signature} : execute accordé à ${role}`
          : `fonction security definer ${signature} : execute reste accordé à ${role} par défaut ; ajouter « revoke execute on function ${signature} from public, anon »`,
      });
    }
  }
  return findings;
}

function hasOwnerGuard(fk: ForeignKey): boolean {
  const index = fk.columns.indexOf('user_id');
  return index >= 0 && fk.refColumns[index] === 'user_id';
}

function checkUserIdGuard(model: SchemaModel): Finding[] {
  const findings: Finding[] = [];
  for (const child of userTables(model)) {
    if (!child.columns.has('user_id')) continue;
    const key = keyOf(child);
    const fks = model.foreignKeys.filter((fk) => fk.table === key);
    for (const fk of fks) {
      const parent = model.tables.get(fk.refTable);
      if (!parent || !parent.columns.has('user_id') || hasOwnerGuard(fk)) continue;
      if (fks.some((other) => other.refTable === fk.refTable && hasOwnerGuard(other) && fk.columns.every((c) => other.columns.includes(c)))) continue;
      findings.push({
        rule: RULES.userIdGuard, severity: 'warning', file: fk.file, line: fk.line, target: `${key}.${fk.name}`,
        message: `${key}.user_id répète ${fk.refTable}.user_id sans garde-fou : clé étrangère composite (${[...fk.columns, 'user_id'].join(', ')}) vers ${fk.refTable} (${[...fk.refColumns, 'user_id'].join(', ')}) attendue, ou exception déclarée`,
      });
    }
  }
  return findings;
}

function checkIdempotency(model: SchemaModel): Finding[] {
  const findings: Finding[] = [];
  for (const table of userTables(model)) {
    if (!table.columns.has('user_id') || !table.columns.has('created_at')) continue;
    const key = keyOf(table);
    const uniques = model.indexes.filter((ix) => ix.table === key && ix.unique);
    const idempotent = uniques.some((ix) => ix.columns.includes('idempotency_key'));
    const natural = uniques.some((ix) => !ix.columns.includes('id'));
    if (idempotent || natural) continue;
    findings.push({
      rule: RULES.idempotency, severity: 'warning', file: table.file, line: table.line, target: key,
      message: `table de création ${key} sans clé d'idempotence unique (user_id, idempotency_key) ni autre clé naturelle unique (double clic, renvoi)`,
    });
  }
  return findings;
}

export function checkModel(model: SchemaModel, config: DbConfig): Finding[] {
  const notes: Finding[] = model.notes.map((note) => ({
    rule: note.message.startsWith('lecture impossible') ? 'parse.unreadable' : 'parse.statement',
    severity: note.message.startsWith('lecture impossible') ? 'error' : 'warning',
    file: note.file, line: note.line, target: note.file, message: note.message,
  }));
  return [
    ...notes,
    ...checkNaming(model, config),
    ...checkForeignKeyIndexes(model),
    ...checkRls(model, config),
    ...checkPolicies(model),
    ...checkDefiners(model),
    ...checkUserIdGuard(model),
    ...checkIdempotency(model),
  ];
}

/** Splits findings into kept and suppressed by declared exceptions (rule and target accept globs). */
export function applyExceptions(findings: Finding[], exceptions: DbException[]): { kept: Finding[]; suppressed: SuppressedFinding[] } {
  const matchers = exceptions.map((e) => ({ e, rule: globToRegExp(e.rule), target: globToRegExp(e.target) }));
  const kept: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const finding of findings) {
    const hit = matchers.find((m) => m.rule.test(finding.rule) && m.target.test(finding.target));
    if (hit) suppressed.push({ ...finding, reason: hit.e.reason });
    else kept.push(finding);
  }
  return { kept, suppressed };
}
