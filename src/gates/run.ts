import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gateStage, validateReceipt, type Gate, type GateReceipt, type GateStage } from '../domain/contracts.js';
import { errorMessage, invariant } from '../domain/errors.js';
import { hash } from '../domain/hash.js';
import { environmentIdentity, executableIdentity, proofKey } from '../evidence/key.js';
import { Git } from '../execution/git.js';
import { environment, expandCommand, redact, runProcess } from '../execution/process.js';
import { failureExcerpt, MAX_DIAGNOSTIC_CHARS } from '../engine/diagnostic.js';
import { schedule, success } from '../engine/scheduler.js';
import type { ApvConfig } from '../config/load.js';
import { publishRun, pruneStore, receiptRetention, sharedStore, type PruneResult } from './store.js';

/** Receipts of `apv gates run`, one directory per execution. Machine evidence, not versioned. */
export const RECEIPTS_DIR = '.apv/receipts';
/** Environment identity of a V3 local run; V2 read it from `environment.id`, a field V3 no longer reads. */
export const ENVIRONMENT_ID = 'apv3-local';

export interface GateRunOptions {
  repo: string;
  config: ApvConfig;
  /** Selected gate ids; their dependencies are added. Empty or absent: every configured gate. */
  only?: readonly string[];
  /**
   * `task`: the checks of stage task run, a full check with an `affected` command runs that targeted command instead,
   * the other full checks are reported as reserved. `full` (default): every check, never targeted.
   */
  stage?: GateStage;
  /** Commit the `{{baseSha}}` placeholder stands for. */
  base?: string;
  concurrency?: number;
  failFast?: boolean;
  signal?: AbortSignal;
  /** Source of passed variables (tests inject it); defaults to the process environment. */
  env?: NodeJS.ProcessEnv;
  /** A full suite run out of the rhythm of an execution (`--reason`): written in every receipt and in the summary. */
  override?: { run: string; reason: string };
  /** Copy the run into the shared store of the repository (default true), then apply its retention. */
  share?: boolean;
}
/** The copy of a run in the shared store: its directory, or why it could not be made (the run itself stands). */
export interface SharedCopy { directory: string | null; error: string | null; pruned: PruneResult | null }
export interface GateRunResult {
  runId: string;
  repo: string;
  candidateSha: string;
  baseSha: string | null;
  /** True when the working tree had uncommitted changes: receipts then describe more than the commit. */
  dirty: boolean;
  stage: GateStage;
  selected: string[];
  added: string[];
  /** Selected checks of stage full left out of a task run: never executed, never counted as passed. */
  reserved: string[];
  /** Full checks a task run executed through their `affected` command (receipts marked `targeted`). */
  targeted: string[];
  receipts: GateReceipt[];
  directory: string;
  /** Copy in the shared store (`<git common dir>/apv/receipts/<run>/`), null when not asked. */
  shared: SharedCopy | null;
  ok: boolean;
}

/** Selected gates in configuration order, with their transitive dependencies. */
export function selectGates(gates: readonly Gate[], only: readonly string[] = []): { gates: Gate[]; added: string[] } {
  if (!only.length) return { gates: [...gates], added: [] };
  const byId = new Map(gates.map(g => [g.id, g]));
  const unknown = only.filter(id => !byId.has(id));
  invariant(!unknown.length, 'GATE_UNKNOWN', `Unknown gate: ${unknown.join(', ')}. Configured: ${[...byId.keys()].join(', ') || 'none'}`);
  const chosen = new Set<string>();
  const include = (id: string): void => { if (chosen.has(id)) return; chosen.add(id); byId.get(id)!.dependsOn.forEach(include); };
  only.forEach(include);
  return { gates: gates.filter(g => chosen.has(g.id)), added: [...chosen].filter(id => !only.includes(id)) };
}

/**
 * Checks a stage requires (`run`), the full checks a task stage runs through their targeted `affected` command
 * (`targeted`, never proof of the full check) and the selected checks it leaves to the full suite (`reserved`).
 */
export function stageGates(gates: readonly Gate[], stage: GateStage): { run: Gate[]; targeted: Gate[]; reserved: Gate[] } {
  if (stage === 'full') return { run: [...gates], targeted: [], reserved: [] };
  const full = gates.filter(g => gateStage(g) === 'full');
  return { run: gates.filter(g => gateStage(g) === 'task'), targeted: full.filter(g => g.affected), reserved: full.filter(g => !g.affected) };
}

/** Identity of the declared checks and passed variables, recorded in every receipt and compared by `apv gates verify`. */
export function gatesConfigHash(config: ApvConfig): string {
  return hash({ gates: config.gates, passEnv: config.environment.passEnv });
}

/**
 * Runs configured checks in the project working tree: dependency graph, named resources and read/write
 * exclusion through the V2 scheduler, only the declared variables passed, each command bounded by its
 * timeout, secrets redacted from diagnostics. Each receipt is validated and written as JSON.
 * Extracted from the V2 controller validation step, without its disposable worktree, its receipt cache
 * or its approval state: an implementer runs this in the worktree it owns.
 */
export async function runGates(options: GateRunOptions): Promise<GateRunResult> {
  const git = new Git(options.signal);
  const repo = await git.root(options.repo);
  const candidateSha = await git.sha(repo);
  const baseSha = options.base ? await git.sha(repo, options.base) : null;
  const dirty = (await git.exec(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) !== '';
  const stage = options.stage ?? 'full';
  const selection = selectGates(options.config.gates, options.only);
  invariant(selection.gates.length > 0, 'NO_GATES', 'No checks configured; declare gates in .apv/config.json');
  const { added } = selection;
  const staged = stageGates(selection.gates, stage);
  const { reserved } = staged;
  const targeted = new Set(staged.targeted.map(g => g.id));
  // Configuration order; a targeted check keeps its id, dependencies and resources, with its targeted command.
  const gates = selection.gates.filter(g => staged.run.includes(g) || targeted.has(g.id))
    .map(g => targeted.has(g.id) ? { ...g, command: g.affected! } : g);
  const context: Record<string, string> = { workspace: repo, candidateSha, ...(baseSha ? { baseSha } : {}) };
  // Placeholders are resolved before anything runs: a missing --base never fails halfway through a batch.
  const commands = new Map(gates.map(g => {
    try { return [g.id, expandCommand(g.command, context)]; }
    catch (error) {
      invariant(!/\{\{baseSha\}\}/.test(g.command.join(' ')) || baseSha, 'GATE_BASE', `Gate ${g.id} uses {{baseSha}}: pass --base <ref>`);
      throw error;
    }
  }));
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomUUID().slice(0, 8)}`;
  const directory = join(repo, RECEIPTS_DIR, runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Receipts are local evidence: keep them out of diffs, scope checks and commits, before any gate
  // (a gate that checks the working tree is clean must not see the receipts of its siblings).
  const ignore = join(repo, RECEIPTS_DIR, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const configHash = gatesConfigHash(options.config);
  const source = options.env ?? process.env;
  const keys = new Map<string, string>();
  const override = options.override ? { run: options.override.run, reason: options.override.reason } : null;
  const write = (receipt: Omit<GateReceipt, 'stage' | 'dirty' | 'targeted' | 'override'>): GateReceipt => {
    const valid = validateReceipt({ ...receipt, stage, dirty, ...(targeted.has(receipt.gateId) ? { targeted: true } : {}), ...(override ? { override } : {}) });
    writeFileSync(join(directory, `${valid.gateId}.json`), JSON.stringify(valid, null, 2) + '\n');
    return valid;
  };
  const execute = async (gate: Gate, signal: AbortSignal): Promise<GateReceipt> => {
    const startedAt = Date.now();
    const elapsedStart = performance.now();
    const env = environment([...options.config.environment.passEnv, ...gate.passEnv], source);
    const command = commands.get(gate.id)!;
    let executable: { path: string; sha256: string } | null = null;
    try { executable = await executableIdentity(command[0]!, repo, env); } catch { /* reported as spawn_error below */ }
    const environmentHash = environmentIdentity(ENVIRONMENT_ID, env, { executable });
    const key = proofKey({ repository: repo, baseSha: baseSha ?? candidateSha, candidateSha, taskHash: hash(null), configHash, environmentHash,
      workspace: repo, gate: { ...gate, command }, dependencyKeys: gate.dependsOn.map(d => keys.get(d) ?? hash(null)),
      executable: executable ?? { path: command[0]!, sha256: hash('unresolved') } });
    keys.set(gate.id, key);
    const base = { id: randomUUID(), runId, gateId: gate.id, key, candidateSha, configHash, environmentHash, startedAt, reusedFrom: null };
    if (!executable) return write({ ...base, status: 'spawn_error', durationMs: performance.now() - elapsedStart, exitCode: null,
      stdoutHash: '', stderrHash: '', diagnostic: `Executable unavailable: ${command[0]!}` });
    const result = await runProcess({ command, cwd: repo, env, timeoutMs: gate.timeoutMs, signal, maxOutputBytes: 1024 * 1024 });
    const exitCode = result.exitCode !== null && result.exitCode >= 0 && result.exitCode <= 255 ? result.exitCode : null;
    return write({ ...base, status: result.status, durationMs: performance.now() - elapsedStart, exitCode,
      stdoutHash: result.stdoutHash, stderrHash: result.stderrHash,
      diagnostic: result.status === 'passed' ? '' : redact(failureExcerpt(result.status, result.stderr, result.stdout), { ...env, ...source }).slice(0, MAX_DIAGNOSTIC_CHARS) });
  };
  const list = await schedule(gates, {
    concurrency: options.concurrency ?? 3, failFast: options.failFast ?? true, signal: options.signal ?? new AbortController().signal, execute,
    blocked: (gate, reason) => write({ id: randomUUID(), runId, gateId: gate.id, key: hash({ blocked: gate.id, candidateSha }), candidateSha, configHash,
      environmentHash: hash('not-executed'), status: 'blocked', startedAt: Date.now(), durationMs: 0, exitCode: null,
      stdoutHash: '', stderrHash: '', diagnostic: reason, reusedFrom: null }),
  });
  const result: GateRunResult = { runId, repo, candidateSha, baseSha, dirty, stage, selected: gates.map(g => g.id), added,
    reserved: reserved.map(g => g.id), targeted: [...targeted], receipts: list, directory, shared: null, ok: list.every(success) };
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ runId, candidateSha, baseSha, dirty, stage, ok: result.ok, selected: result.selected, added,
    reserved: result.reserved, targeted: result.targeted, ...(override ? { override } : {}),
    receipts: list.map(r => ({ gateId: r.gateId, id: r.id, status: r.status, ...(r.targeted ? { targeted: true } : {}), exitCode: r.exitCode, durationMs: Math.round(r.durationMs) })) }, null, 2) + '\n');
  if (options.share !== false) result.shared = await shareRun(git, repo, directory, runId, candidateSha, options.config);
  return result;
}

/**
 * Copies a finished run into the shared store of the repository, so that it survives its worktree, then applies
 * the retention of the store. A failure is reported, never fatal: the run and its local receipts stand.
 */
async function shareRun(git: Git, repo: string, directory: string, runId: string, candidateSha: string, config: ApvConfig): Promise<SharedCopy> {
  let target: string;
  let store: string;
  try {
    store = await sharedStore(git, repo);
    target = publishRun(store, directory, runId, candidateSha, repo);
  } catch (error) { return { directory: null, error: errorMessage(error), pruned: null }; }
  let pruned: PruneResult | null = null;
  try { pruned = pruneStore(store, receiptRetention(config)); } catch { /* Retention is retried by the next run. */ }
  return { directory: target, error: null, pruned };
}
