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
import { suiteSettings, type ApvConfig } from '../config/load.js';
import type { ProcessResult } from '../domain/contracts.js';
import { PipelineError } from '../domain/errors.js';
import { publishRun, pruneStore, receiptRetention, sharedStore, type PruneResult } from './store.js';
import { FLOCK_TIMEOUT_EXIT, commonPath, enterQueue, flockCommand, freePorts, resolveGateLock, withGateLease,
  type PortsRecord, type QueueHandle, type QueueRecord, type SuiteHooks } from './suite.js';

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
  /**
   * A full suite (a check of stage full run in full) refuses a working tree with uncommitted changes (`GATE_DIRTY`)
   * unless this is set: its receipts are then marked `dirty` and prove nothing (`apv gates verify` refuses them).
   */
  allowDirty?: boolean;
  /** Progress lines of the waits (queue, load, locks, ports, relaunches); default: nowhere. */
  log?: (line: string) => void;
  /** Injected by tests: load average and polling delays. */
  hooks?: SuiteHooks;
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
  /** True when the run is a full suite (a check of stage full run in full): queue, clean tree and ports apply. */
  suite: boolean;
  /** The queue of the full suites: its lock, the wait, the load; null outside a full suite or when disabled. */
  queue: QueueRecord | null;
  /** The ports of `suite.ports` freed from orphans of this copy; null when none are declared or outside a full suite. */
  ports: PortsRecord | null;
  /** Checks passed only after the relaunch of their failed tests (`passed_after_retry`): unstable, shown apart. */
  flaky: string[];
  ok: boolean;
}

/** Files of a `git status --porcelain=v1 -z` output, as `XY path` lines. */
export function statusLines(porcelain: string): string[] {
  const parts = porcelain.split('\0');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    out.push(`${entry.slice(0, 2)} ${entry.slice(3)}`);
    if (/[RC]/.test(entry.slice(0, 2))) i += 1;
  }
  return out;
}

/** The refusal of a full suite on a working tree with uncommitted changes, listing them (50 at most). */
export function dirtyRefusal(porcelain: string, when = ''): PipelineError {
  const lines = statusLines(porcelain);
  const shown = lines.slice(0, 50).map(l => `  ${l}`).join('\n');
  return new PipelineError('GATE_DIRTY', `Suite complète refusée${when} : l'arbre de travail a des modifications non commitées (${lines.length} fichier(s)), ` +
    `ses reçus ne prouveraient rien (apv gates verify les refuse) :\n${shown}${lines.length > 50 ? `\n  ... et ${lines.length - 50} autre(s)` : ''}\n` +
    'Commiter (ou retirer) ces fichiers, puis relancer ; --allow-dirty la lance quand même, reçus non prouvants.');
}

/** A run that executes at least one check of stage full in full: the full suite, under its queue and guards. */
export const isFullSuite = (gates: readonly Gate[], stage: GateStage): boolean => stage === 'full' && gates.some(g => gateStage(g) === 'full');

/** Lines of a test output that name tests: `pattern` (capture group 1 when present), ANSI codes removed, 100 at most. */
export function failedTests(pattern: string | undefined, output: string): string[] {
  if (!pattern) return [];
  const re = new RegExp(pattern);
  const found = new Set<string>();
  for (const raw of output.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    const m = re.exec(line);
    const name = m ? (m[1] ?? m[0]).trim().slice(0, 500) : '';
    if (name) found.add(name);
    if (found.size >= 100) break;
  }
  return [...found];
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
  const treeStatus = (): Promise<string> => git.exec(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  let status = await treeStatus();
  let dirty = status !== '';
  const stage = options.stage ?? 'full';
  const log = options.log ?? ((): void => { /* silent */ });
  const selection = selectGates(options.config.gates, options.only);
  invariant(selection.gates.length > 0, 'NO_GATES', 'No checks configured; declare gates in .apv/config.json');
  const { added } = selection;
  const staged = stageGates(selection.gates, stage);
  const { reserved } = staged;
  const targeted = new Set(staged.targeted.map(g => g.id));
  // Configuration order; a targeted check keeps its id, dependencies and resources, with its targeted command.
  const gates = selection.gates.filter(g => staged.run.includes(g) || targeted.has(g.id))
    .map(g => targeted.has(g.id) ? { ...g, command: g.affected! } : g);
  const suite = isFullSuite(gates, stage);
  // A full suite on a dirty tree proves nothing: refused before any wait, unless asked for.
  if (suite && dirty && !options.allowDirty) throw dirtyRefusal(status);
  const context: Record<string, string> = { workspace: repo, candidateSha, ...(baseSha ? { baseSha } : {}) };
  // Placeholders are resolved before anything runs: a missing --base never fails halfway through a batch.
  const expand = (g: Gate, argv: readonly string[]): string[] => {
    try { return expandCommand(argv, context); }
    catch (error) {
      invariant(!/\{\{baseSha\}\}/.test(argv.join(' ')) || baseSha, 'GATE_BASE', `Gate ${g.id} uses {{baseSha}}: pass --base <ref>`);
      throw error;
    }
  };
  const commands = new Map(gates.map(g => [g.id, expand(g, g.command)]));
  const retries = new Map(gates.filter(g => g.retryFailed).map(g => [g.id, expand(g, g.retryFailed!.command)]));
  // The queue of the full suites, then the load: every timeout of a check starts after them.
  const settings = suiteSettings(options.config);
  let queue: QueueHandle | null = null;
  if (suite && settings.queue.enabled) {
    queue = await enterQueue({ lockFile: await commonPath(git, repo, settings.queue.lockFile), settings: settings.queue, repo, log, signal: options.signal, hooks: options.hooks });
  }
  try {
    let ports: PortsRecord | null = null;
    if (suite) {
      // The copy may have changed during the wait: the run is on the commit and tree it was asked for, or not at all.
      if (queue && queue.record.waitedMs + (queue.record.load?.waitedMs ?? 0) > 0) {
        const head = await git.sha(repo);
        if (head !== candidateSha) throw new PipelineError('GATE_DIRTY', `Suite complète refusée : HEAD est passé de ${candidateSha.slice(0, 12)} à ${head.slice(0, 12)} pendant l'attente de la file. Relancer sur le nouveau commit.`);
        const now = await treeStatus();
        if (now !== status) {
          if (now !== '' && !options.allowDirty) throw dirtyRefusal(now, ' (arbre modifié pendant l\'attente de la file)');
          status = now; dirty = now !== '';
        }
      }
      if (settings.ports.length) ports = await freePorts(repo, settings.ports, { log });
    }
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
    const write = (receipt: Omit<GateReceipt, 'stage' | 'dirty' | 'targeted' | 'override' | 'lockWaitMs' | 'retry'> & Partial<Pick<GateReceipt, 'lockWaitMs' | 'retry'>>): GateReceipt => {
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
      const secrets = { ...env, ...source };
      const excerpt = (r: ProcessResult, limit = MAX_DIAGNOSTIC_CHARS): string => redact(failureExcerpt(r.status, r.stderr, r.stdout, limit), secrets).slice(0, limit);
      const exitOf = (r: ProcessResult): number | null => r.exitCode !== null && r.exitCode >= 0 && r.exitCode <= 255 ? r.exitCode : null;
      const lock = gate.lock ? await resolveGateLock(git, repo, gate.lock, env, source) : null;
      const withLockWait = (ms: number): { lockWaitMs?: number } => lock ? { lockWaitMs: Math.round(ms) } : {};
      /** One pass of a command, under the flock of the check when it has one: the timeout starts once it is held. */
      const pass = async (argv: string[], passEnv: NodeJS.ProcessEnv): Promise<{ result: ProcessResult; commandMs: number; lockWaitMs: number; lockError: string | null }> => {
        if (lock?.kind !== 'flock') {
          const result = await runProcess({ command: argv, cwd: repo, env: passEnv, timeoutMs: gate.timeoutMs, signal, maxOutputBytes: 1024 * 1024 });
          return { result, commandMs: result.durationMs, lockWaitMs: 0, lockError: null };
        }
        const result = await runProcess({ command: flockCommand(lock.file, lock.waitMs, argv), cwd: repo, env: passEnv, timeoutMs: gate.timeoutMs, signal,
          maxOutputBytes: 1024 * 1024, waitReady: true });
        if (result.readyMs === null || result.readyMs === undefined) {
          const lockError = result.status === 'cancelled' ? null
            : result.status === 'spawn_error' ? `flock introuvable (util-linux) pour le verrou ${lock.file} : ${result.stderr.slice(0, 500)}`
            : result.exitCode === FLOCK_TIMEOUT_EXIT ? `Verrou flock ${lock.file} non obtenu après ${Math.round(lock.waitMs / 1000)} s (lock.waitMs) : la commande n'a pas été lancée.`
            : `flock en échec pour le verrou ${lock.file} (code ${result.exitCode ?? '-'}) : ${redact(result.stderr, secrets).slice(0, 2000)}`;
          const status: ProcessResult['status'] = result.status === 'cancelled' ? 'cancelled' : result.status === 'spawn_error' ? 'spawn_error' : result.exitCode === FLOCK_TIMEOUT_EXIT ? 'timed_out' : 'failed';
          return { result: { ...result, status }, commandMs: 0, lockWaitMs: result.durationMs, lockError };
        }
        return { result, commandMs: result.durationMs - result.readyMs, lockWaitMs: result.readyMs, lockError: null };
      };
      const lockRefused = (reason: string, waitedMs: number): GateReceipt => write({ ...base, status: 'timed_out', durationMs: 0, exitCode: null,
        stdoutHash: '', stderrHash: '', diagnostic: `Verrou du contrôle non obtenu : ${reason}. La commande n'a pas été lancée.`, lockWaitMs: Math.round(waitedMs) });
      const body = async (passEnv: NodeJS.ProcessEnv, leaseWaitMs: number): Promise<GateReceipt> => {
        const first = await pass(command, passEnv);
        let lockWaitMs = leaseWaitMs + first.lockWaitMs;
        const r1 = first.result;
        if (first.lockError !== null || r1.status === 'cancelled' && first.commandMs === 0 && lock?.kind === 'flock') {
          return write({ ...base, status: r1.status, durationMs: 0, exitCode: null, stdoutHash: '', stderrHash: '',
            diagnostic: first.lockError ?? 'cancelled', ...withLockWait(lockWaitMs) });
        }
        const plain = (): GateReceipt => write({ ...base, status: r1.status, durationMs: first.commandMs, exitCode: exitOf(r1),
          stdoutHash: r1.stdoutHash, stderrHash: r1.stderrHash, diagnostic: r1.status === 'passed' ? '' : excerpt(r1), ...withLockWait(lockWaitMs) });
        const retryCommand = retries.get(gate.id);
        // Only a command that failed by itself is relaunched: a timeout, a cancellation or a missing command is not.
        if (r1.status !== 'failed' || !retryCommand) return plain();
        const tests = failedTests(gate.retryFailed!.testPattern, `${r1.stdout}\n${r1.stderr}`).map(t => redact(t, secrets));
        const firstPass = { status: 'failed' as const, exitCode: exitOf(r1), durationMs: first.commandMs, stdoutHash: r1.stdoutHash, stderrHash: r1.stderrHash, diagnostic: excerpt(r1, 8000) };
        // Same commit, same tree: otherwise the relaunch would prove other code.
        const head = await git.sha(repo);
        const now = await treeStatus();
        if (head !== candidateSha || now !== status) {
          return write({ ...base, status: 'failed', durationMs: first.commandMs, exitCode: exitOf(r1), stdoutHash: r1.stdoutHash, stderrHash: r1.stderrHash,
            diagnostic: `Relance refusée : ${head !== candidateSha ? 'HEAD a changé' : 'l\'arbre de travail a changé'} pendant la première passe (la relance ne prouverait pas le même code).\n${excerpt(r1, MAX_DIAGNOSTIC_CHARS - 300)}`,
            ...withLockWait(lockWaitMs) });
        }
        log(`${gate.id} : échec (code ${exitOf(r1) ?? '-'}) ; relance unique des tests en échec (retryFailed)${tests.length ? ` : ${tests.slice(0, 5).join(' ; ')}${tests.length > 5 ? ' ...' : ''}` : ''}.`);
        const second = await pass(retryCommand, passEnv);
        lockWaitMs += second.lockWaitMs;
        const r2 = second.result;
        const output = redact(`${r2.stdout}\n${r2.stderr}`.trim(), secrets).slice(-4000);
        const retry = { command: retryCommand, first: firstPass, output, tests };
        const durationMs = first.commandMs + second.commandMs;
        if (second.lockError === null && r2.status === 'passed') {
          log(`${gate.id} : réussi après relance (instable).`);
          return write({ ...base, status: 'passed_after_retry', durationMs, exitCode: 0, stdoutHash: r2.stdoutHash, stderrHash: r2.stderrHash,
            diagnostic: `Réussi après relance (retryFailed) : première passe en échec (code ${firstPass.exitCode ?? '-'})${tests.length ? ` ; tests relancés : ${tests.join(' ; ')}` : ''}.\n${excerpt(r1, 8000)}`.slice(0, MAX_DIAGNOSTIC_CHARS),
            retry, ...withLockWait(lockWaitMs) });
        }
        const failure = second.lockError ?? excerpt(r2, MAX_DIAGNOSTIC_CHARS - 300);
        return write({ ...base, status: r2.status === 'passed' ? 'failed' : r2.status, durationMs, exitCode: second.lockError === null ? exitOf(r2) : null,
          stdoutHash: second.lockError === null ? r2.stdoutHash : '', stderrHash: second.lockError === null ? r2.stderrHash : '',
          diagnostic: `Relance (retryFailed) en échec aussi :\n${failure}`.slice(0, MAX_DIAGNOSTIC_CHARS), retry, ...withLockWait(lockWaitMs) });
      };
      if (lock?.kind === 'lease') {
        return withGateLease(lock, { label: `apv gates run ${gate.id} (${repo})`, env, source, signal, log, hooks: options.hooks }, body, lockRefused);
      }
      return body(env, 0);
    };
    const list = await schedule(gates, {
      concurrency: options.concurrency ?? 3, failFast: options.failFast ?? true, signal: options.signal ?? new AbortController().signal, execute,
      blocked: (gate, reason) => write({ id: randomUUID(), runId, gateId: gate.id, key: hash({ blocked: gate.id, candidateSha }), candidateSha, configHash,
        environmentHash: hash('not-executed'), status: 'blocked', startedAt: Date.now(), durationMs: 0, exitCode: null,
        stdoutHash: '', stderrHash: '', diagnostic: reason, reusedFrom: null }),
    });
    const flaky = list.filter(r => r.status === 'passed_after_retry').map(r => r.gateId);
    const result: GateRunResult = { runId, repo, candidateSha, baseSha, dirty, stage, selected: gates.map(g => g.id), added,
      reserved: reserved.map(g => g.id), targeted: [...targeted], receipts: list, directory, shared: null, suite, queue: queue?.record ?? null, ports, flaky, ok: list.every(success) };
    writeFileSync(join(directory, 'summary.json'), JSON.stringify({ runId, candidateSha, baseSha, dirty, stage, ok: result.ok, selected: result.selected, added,
      reserved: result.reserved, targeted: result.targeted, ...(override ? { override } : {}),
      ...(suite ? { suite: true, queue: result.queue, ports, flaky } : {}),
      receipts: list.map(r => ({ gateId: r.gateId, id: r.id, status: r.status, ...(r.targeted ? { targeted: true } : {}), exitCode: r.exitCode, durationMs: Math.round(r.durationMs),
        ...(r.lockWaitMs !== undefined ? { lockWaitMs: r.lockWaitMs } : {}), ...(r.retry ? { retriedTests: r.retry.tests } : {}) })) }, null, 2) + '\n');
    if (options.share !== false) result.shared = await shareRun(git, repo, directory, runId, candidateSha, options.config);
    return result;
  } finally {
    await queue?.release();
  }
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
