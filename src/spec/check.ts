import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import type { Issue } from '../domain/issues.js';
import { Git } from '../execution/git.js';
import { inspectRepository } from '../knowledge/repository.js';
import { specIssues, specSchema, type Spec } from '../lifecycle/contracts.js';
import { decisionLedgerIssues, decisionLedgerSchema, LEDGER_FILE, LEGACY_LEDGER_FILE, type DecisionLedger } from '../lifecycle/decisions.js';
import { assessSecurity, type SecurityContext } from '../security/owasp.js';
import { pathsMentioned } from '../security/change-signals.js';
import { loadConfig } from '../config/load.js';

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
  requestSource: 'option' | 'document' | 'spec';
  ledgerFile: string | null;
  configFile: string | null;
  security: SecurityContext;
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
  try {
    const loaded = loadConfig(repo, options.configFile);
    projectType = loaded.config.skills.projectType; configFile = loaded.file;
  } catch (error) { issues.push({ code: error instanceof PipelineError ? error.code : 'CONFIG', message: errorMessage(error) }); }
  const ledger = workingLedger(repo);
  issues.push(...ledger.issues);
  const explicit = options.request ?? options.document.request ?? undefined;
  const requestSource = options.request !== undefined ? 'option' : options.document.request !== null ? 'document' : 'spec';
  const request = explicit ?? specText(options.document.spec);
  const decisionsText = (ledger.ledger?.decisions ?? []).map(d => `${d.subject}: ${d.value}`).join('\n');
  const intelligence = await inspectRepository(repo, sha, `${request}\n${decisionsText}`, options.signal ? { signal: options.signal } : {});
  const tracked = [...intelligence.relevantFiles, ...intelligence.manifests, ...intelligence.securityFiles];
  const declared = (() => { try { return specSchema.parse(options.document.spec) as Spec; } catch { return null; } })();
  // Same inputs as V2 `scopedSecurity`: paths named by the request, plus literal task paths.
  const security = assessSecurity({ text: request, projectType,
    files: [...pathsMentioned(request, tracked), ...(declared?.tasks.flatMap(t => t.allowedPaths).filter(p => !/[*?]/.test(p)) ?? [])] });
  issues.push(...specIssues(options.document.spec, { ready: options.ready ?? true, securityContext: security,
    ...(ledger.ledger ? { ledger: ledger.ledger } : {}), ...(explicit !== undefined ? { operatorText: explicit } : {}) }));
  return { valid: issues.length === 0, issues, title: declared?.title ?? null, sha, requestSource, ledgerFile: ledger.file, configFile, security };
}
