import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyExceptions, checkModel, type Finding, type SuppressedFinding } from './checks.js';
import { scanCode } from './code-scan.js';
import { loadDbConfig, type DbConfig } from './config.js';
import { expandGlobs } from './glob.js';
import { LIVE_RULES, runLiveChecks, type LiveReport, type PsqlRunner } from './live.js';
import { parseMigrations } from './parser.js';
import type { SchemaModel } from './model.js';

export interface DbCheckOptions {
  root: string;
  configPath?: string;
  live?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Test seam for `--live`. */
  psql?: PsqlRunner;
}

export interface DbCheckReport {
  root: string;
  configPath: string | null;
  config: DbConfig;
  migrations: string[];
  codeFiles: string[];
  model: SchemaModel;
  findings: Finding[];
  suppressed: SuppressedFinding[];
  live: LiveReport | null;
  errors: number;
  warnings: number;
}

const severityOrder = (f: Finding) => (f.severity === 'error' ? 0 : 1);

export function runDbCheck(options: DbCheckOptions): DbCheckReport {
  const { config, path, problems } = loadDbConfig(options.root, options.configPath);
  const findings: Finding[] = problems.map((message) => ({ rule: 'config.invalid', severity: 'error', file: path ?? '.apv/config.json', line: 0, target: 'config', message }));

  const migrations = expandGlobs(options.root, config.migrations);
  if (migrations.length === 0) {
    findings.push({
      rule: 'config.no_migrations', severity: 'error', file: path ?? '.apv/config.json', line: 0, target: 'config',
      message: `aucune migration trouvée pour ${config.migrations.join(', ')} (régler db.migrations dans .apv/config.json)`,
    });
  }
  const files = migrations
    .sort((a, b) => (a.split('/').pop() ?? a).localeCompare(b.split('/').pop() ?? b))
    .map((file) => ({ path: file, sql: readFileSync(join(options.root, file), 'utf8') }));
  const model = parseMigrations(files, { supabaseDefaults: config.supabaseDefaults });
  findings.push(...checkModel(model, config));

  const code = scanCode(options.root, config.codeGlobs, config.codeExclude);
  findings.push(...code.findings);

  let live: LiveReport | null = null;
  if (options.live) {
    live = runLiveChecks(config, options.env ?? process.env, options.psql);
    findings.push(...live.findings);
    if (live.status === 'skipped') {
      findings.push({ rule: LIVE_RULES.skipped, severity: 'warning', file: '(base en direct)', line: 0, target: 'live', message: `contrôles en direct ignorés : ${live.reason}` });
    }
  }

  const { kept, suppressed } = applyExceptions(findings, config.exceptions);
  kept.sort((a, b) => severityOrder(a) - severityOrder(b) || a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return {
    root: options.root,
    configPath: path,
    config,
    migrations,
    codeFiles: code.files,
    model,
    findings: kept,
    suppressed,
    live,
    errors: kept.filter((f) => f.severity === 'error').length,
    warnings: kept.filter((f) => f.severity === 'warning').length,
  };
}

const location = (f: Finding): string => (f.line > 0 ? `${f.file}:${f.line}` : f.file);
const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`;

export function formatHuman(report: DbCheckReport): string {
  const m = report.model;
  const lines: string[] = [];
  lines.push(`apv db check : ${plural(report.migrations.length, 'migration')}, ${plural([...m.tables.values()].filter((t) => !t.temporary).length, 'table')}, `
    + `${m.foreignKeys.length} clés étrangères, ${m.indexes.length} index, ${plural(m.policies.length, 'politique')}, ${plural(m.functions.length, 'fonction')} ; `
    + `${plural(report.codeFiles.length, 'fichier')} de code lus.`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('Aucun problème trouvé.');
  } else {
    const rows = report.findings.map((f) => [f.severity === 'error' ? 'erreur' : 'avertissement', f.rule, location(f), f.message]);
    const header = ['SÉVÉRITÉ', 'RÈGLE', 'EMPLACEMENT', 'MESSAGE'];
    const widths = [0, 1, 2].map((i) => Math.max(header[i]?.length ?? 0, ...rows.map((r) => r[i]?.length ?? 0)));
    const format = (r: string[]) => r.map((cell, i) => (i < 3 ? cell.padEnd(widths[i] ?? 0) : cell)).join('  ');
    lines.push(format(header));
    for (const row of rows) lines.push(format(row));
  }
  if (report.suppressed.length > 0) {
    lines.push('');
    lines.push(`Exceptions déclarées appliquées (${report.suppressed.length}) :`);
    for (const s of report.suppressed) lines.push(`  ${s.rule}  ${s.target}  ${location(s)} : ${s.reason}`);
  }
  if (report.live) {
    lines.push('');
    if (report.live.status === 'skipped') lines.push(`Contrôles en direct : ignorés (${report.live.reason}).`);
    else if (report.live.status === 'failed') lines.push(`Contrôles en direct : en échec (${report.live.reason}).`);
    else lines.push('Contrôles en direct : exécutés.');
    for (const detail of report.live.details) lines.push(`  ${detail}`);
  }
  lines.push('');
  lines.push(`Résultat : ${plural(report.errors, 'erreur')}, ${plural(report.warnings, 'avertissement')}${report.suppressed.length ? `, ${plural(report.suppressed.length, 'exception')}` : ''}.`);
  return `${lines.join('\n')}\n`;
}

export function formatJson(report: DbCheckReport): string {
  const m = report.model;
  return `${JSON.stringify({
    version: 1,
    root: report.root,
    config: report.configPath,
    summary: { errors: report.errors, warnings: report.warnings, suppressed: report.suppressed.length },
    model: {
      migrations: report.migrations.length,
      tables: [...m.tables.values()].filter((t) => !t.temporary).length,
      foreignKeys: m.foreignKeys.length,
      indexes: m.indexes.length,
      policies: m.policies.length,
      functions: m.functions.length,
      types: m.types.size,
      codeFiles: report.codeFiles.length,
    },
    findings: report.findings,
    suppressed: report.suppressed,
    live: report.live ? { status: report.live.status, reason: report.live.reason, details: report.live.details } : null,
  }, null, 2)}\n`;
}

export { parseMigrations } from './parser.js';
export { checkModel, applyExceptions, RULES } from './checks.js';
export type { Finding, SuppressedFinding } from './checks.js';
