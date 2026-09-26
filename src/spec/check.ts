import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import type { Issue } from '../domain/issues.js';
import { Git } from '../execution/git.js';
import { inspectRepository } from '../knowledge/repository.js';
import { specIssues, specSchema, type Spec } from '../lifecycle/contracts.js';
import { decisionLedgerIssues, decisionLedgerSchema, LEDGER_FILE, LEGACY_LEDGER_FILE, type DecisionLedger } from '../lifecycle/decisions.js';
import { assessSecurity, type SecurityContext } from '../security/owasp.js';
import { pathsMentioned } from '../security/change-signals.js';
import { DEFAULT_SPEC_LIMITS, loadConfig, specLimits, type SpecLimits } from '../config/load.js';
import { longestChain } from '../run/state.js';

/**
 * A spec file is either the spec itself, or `{ "request": "...", "spec": { ... } }` when the author keeps the
 * operator request next to it. The request drives the security minimum and must contain resolution quotes.
 */
export interface SpecDocument { spec: unknown; request: string | null }

export function parseSpecDocument(raw: unknown): SpecDocument {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'spec') && !Object.hasOwn(raw, 'title')) {
    const doc = raw as Record<string, unknown>;
    const extra = Object.keys(doc).filter(k => k !== 'spec' && k !== 'request');
    if (extra.length) throw new PipelineError('SPEC_FILE', `Unknown property in spec document: ${extra.join(', ')} (expected "spec" and optional "request")`);
    if (doc['request'] !== undefined && (typeof doc['request'] !== 'string' || !doc['request'].trim())) throw new PipelineError('SPEC_FILE', '"request" must be a non-empty string');
    return { spec: doc['spec'], request: typeof doc['request'] === 'string' ? doc['request'] : null };
  }
  return { spec: raw, request: null };
}

export function readSpecDocument(file: string): SpecDocument {
  if (!existsSync(file)) throw new PipelineError('SPEC_FILE', `Spec file not found: ${file}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')) as unknown; }
  catch (error) { throw new PipelineError('SPEC_FILE', `Invalid JSON in ${file}: ${errorMessage(error)}`); }
  return parseSpecDocument(raw);
}

/** The ledger of the working tree (a spec is validated while it is written, before any commit). */
export function workingLedger(repo: string): { file: string | null; ledger: DecisionLedger | null; issues: Issue[] } {
  const file = [LEDGER_FILE, LEGACY_LEDGER_FILE].find(f => existsSync(join(repo, f))) ?? null;
  if (!file) return { file: null, ledger: { schemaVersion: 1, decisions: [] }, issues: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(repo, file), 'utf8')) as unknown; }
  catch (error) { return { file, ledger: null, issues: [{ code: 'DECISION', message: `Invalid JSON in ${file}: ${errorMessage(error)}` }] }; }
  const issues = decisionLedgerIssues(raw).map(i => ({ ...i, message: `${file}: ${i.message}` }));
  return { file, ledger: issues.length ? null : decisionLedgerSchema.parse(raw), issues };
}

/** Text a spec stands for when no request was provided: what it claims to change, not what it excludes. */
export function specText(spec: unknown): string {
  const parsed = (() => { try { return specSchema.parse(spec); } catch { return null; } })();
  if (!parsed) return '';
  return [parsed.title, parsed.problem, ...parsed.scope, ...parsed.acceptance.map(a => a.description), ...parsed.tasks.flatMap(t => [t.title, t.description])].join('\n');
}

export interface SpecCheckOptions {
  repo: string;
  document: SpecDocument;
  /** Operator request given on the command line; it wins over the one stored in the document. */
  request?: string;
  /** Spec file: its stored request `.apv/state/demande-<id>.md`, written by /apv:spec, is read when no request is given. */
  specFile?: string;
  /** Launch-time rules (default): no open question, every criterion implemented by a task. */
  ready?: boolean;
  configFile?: string;
  signal?: AbortSignal;
}
export interface SpecCheckResult {
  valid: boolean;
  issues: Issue[];
  title: string | null;
  sha: string;
  requestSource: 'option' | 'document' | 'stored' | 'spec';
  /** Path of the stored request, relative to the repository, when it was used. */
  requestFile: string | null;
  ledgerFile: string | null;
  configFile: string | null;
  security: SecurityContext;
  /** Size and depth warnings (`spec` section of the configuration): never make the spec invalid. */
  warnings: Issue[];
  /** Thresholds the warnings were measured against. */
  limits: SpecLimits;
}

/**
 * Warnings of a well-formed spec: more tasks or criteria than the thresholds (split it into independent specs
 * delivered in parallel), or a chain of dependency layers deeper than `maxDepth` (each layer waits for the
 * integration of the previous one). A malformed spec gets none: its errors come first.
 */
export function specWarnings(spec: Spec, limits: SpecLimits): Issue[] {
  const warnings: Issue[] = [];
  const split = 'découpe-la en specs indépendantes de 4 à 6 tâches, livrées en parallèle (sur des piles de test distinctes si le projet en déclare plusieurs), chacune avec sa PR';
  if (spec.tasks.length > limits.maxTasks) {
    warnings.push({ code: 'SPEC_SIZE', message: `La spec compte ${spec.tasks.length} tâches (seuil spec.maxTasks : ${limits.maxTasks}) : ${split}.` });
  }
  if (spec.acceptance.length > limits.maxAcceptance) {
    warnings.push({ code: 'SPEC_SIZE', message: `La spec compte ${spec.acceptance.length} critères d'acceptation (seuil spec.maxAcceptance : ${limits.maxAcceptance}) : ${split}.` });
  }
  let chain: string[] = [];
  try { chain = longestChain(spec.tasks.map(t => ({ id: t.id, title: t.title, dependsOn: [...t.dependsOn] }))); }
  catch { /* cycle or unknown dependency: already an error of the spec */ }
  if (chain.length > limits.maxDepth) {
    warnings.push({ code: 'SPEC_DEPTH', message: `Le graphe des tâches a ${chain.length} couches de dépendances (seuil spec.maxDepth : ${limits.maxDepth}), ` +
      `chemin le plus long : ${chain.join(' -> ')}. Chaque couche attend l'intégration de la précédente : pose d'abord les contrats partagés ` +
      '(types, schémas, signatures, interfaces de composants, migrations) avec des implémentations minimales testées, pour que les tâches suivantes ' +
      'se construisent en parallèle contre eux ; une dépendance ne se déclare que si la tâche a besoin du code de l\'autre.' });
  }
  return warnings;
}

/**
 * Validates a spec against the same security minimum V2 computed when it launched a spec (journal incident
 * 14: a spec declared valid against a draft context was refused at launch). The minimum comes from the
 * request, the project type and the paths the request names or the tasks declare, recognised on the
 * repository at HEAD.
 */
export async function checkSpec(options: SpecCheckOptions): Promise<SpecCheckResult> {
  const git = new Git(options.signal);
  const repo = await git.root(options.repo);
  const sha = await git.sha(repo);
  const issues: Issue[] = [];
  let projectType = 'unknown';
  let configFile: string | null = null;
  let limits: SpecLimits = { ...DEFAULT_SPEC_LIMITS };
  try {
    const loaded = loadConfig(repo, options.configFile);
    projectType = loaded.config.skills.projectType; configFile = loaded.file; limits = specLimits(loaded.config);
  } catch (error) { issues.push({ code: error instanceof PipelineError ? error.code : 'CONFIG', message: errorMessage(error) }); }
  const ledger = workingLedger(repo);
  issues.push(...ledger.issues);
  // Same request at validation and at launch (incident 14): the operator's words stored next to the spec by
  // /apv:spec count as the request whenever none is given, for `apv spec validate` and `apv run start` alike.
  const stored = options.request === undefined && options.document.request === null && options.specFile ? storedRequest(repo, options.specFile) : null;
  const explicit = options.request ?? options.document.request ?? stored?.text ?? undefined;
  const requestSource = options.request !== undefined ? 'option' : options.document.request !== null ? 'document' : stored ? 'stored' : 'spec';
  const request = explicit ?? specText(options.document.spec);
  const decisionsText = (ledger.ledger?.decisions ?? []).map(d => `${d.subject}: ${d.value}`).join('\n');
  const intelligence = await inspectRepository(repo, sha, `${request}\n${decisionsText}`, options.signal ? { signal: options.signal } : {});
  const tracked = [...intelligence.relevantFiles, ...intelligence.manifests, ...intelligence.securityFiles];
  const declared = (() => { try { return specSchema.parse(options.document.spec) as Spec; } catch { return null; } })();
  // Same inputs as V2 `scopedSecurity`: paths named by the request, plus literal task paths.
  const security = assessSecurity({ text: request, projectType,
    files: [...pathsMentioned(request, tracked), ...(declared?.tasks.flatMap(t => t.allowedPaths).filter(p => !/[*?]/.test(p)) ?? [])] });
  const specId = options.specFile ? basename(options.specFile).replace(/\.json$/, '') : undefined;
  issues.push(...specIssues(options.document.spec, { ready: options.ready ?? true, securityContext: security, ...(specId ? { specId } : {}),
    ...(ledger.ledger ? { ledger: ledger.ledger } : {}), ...(explicit !== undefined ? { operatorText: explicit } : {}) }));
  const warnings = declared ? specWarnings(declared, limits) : [];
  return { valid: issues.length === 0, issues, title: declared?.title ?? null, sha, requestSource, requestFile: stored?.file ?? null, ledgerFile: ledger.file, configFile, security,
    warnings, limits };
}

/** `.apv/state/demande-<id>.md` for a spec file `<id>.json`, when it exists and is a readable regular file. */
function storedRequest(repo: string, specFile: string): { file: string; text: string } | null {
  const id = basename(specFile).replace(/\.json$/, '');
  const file = join('.apv', 'state', `demande-${id}.md`);
  try {
    const full = join(repo, file);
    if (!statSync(full).isFile()) return null;
    const text = readFileSync(full, 'utf8').trim();
    return text ? { file: file.split(sep).join('/'), text } : null;
  } catch { return null; }
}
