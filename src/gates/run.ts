import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { validateReceipt, type Gate, type GateReceipt } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import { hash } from '../domain/hash.js';
import { environmentIdentity, executableIdentity, proofKey } from '../evidence/key.js';
import { Git } from '../execution/git.js';
import { environment, expandCommand, redact, runProcess } from '../execution/process.js';
import { failureExcerpt, MAX_DIAGNOSTIC_CHARS } from '../engine/diagnostic.js';
import { schedule, success } from '../engine/scheduler.js';
import type { ApvConfig } from '../config/load.js';

/** Receipts of `apv gates run`, one directory per execution. Machine evidence, not versioned. */
export const RECEIPTS_DIR = '.apv/receipts';
/** Environment identity of a V3 local run; V2 read it from `environment.id`, a field V3 no longer reads. */
export const ENVIRONMENT_ID = 'apv3-local';

export interface GateRunOptions {
  repo: string;
  config: ApvConfig;
  /** Selected gate ids; their dependencies are added. Empty or absent: every configured gate. */
  only?: readonly string[];
  /** Commit the `{{baseSha}}` placeholder stands for. */
  base?: string;
  concurrency?: number;
  failFast?: boolean;
  signal?: AbortSignal;
  /** Source of passed variables (tests inject it); defaults to the process environment. */
  env?: NodeJS.ProcessEnv;
}
export interface GateRunResult {
  runId: string;
  repo: string;
  candidateSha: string;
  baseSha: string | null;
  /** True when the working tree had uncommitted changes: receipts then describe more than the commit. */
  dirty: boolean;
  selected: string[];
  added: string[];
  receipts: GateReceipt[];
  directory: string;
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
  const { gates, added } = selectGates(options.config.gates, options.only);
  invariant(gates.length > 0, 'NO_GATES', 'No checks configured; declare gates in .apv/config.json');
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
  const configHash = hash({ gates: options.config.gates, passEnv: options.config.environment.passEnv });
  const source = options.env ?? process.env;
  const keys = new Map<string, string>();
  const write = (receipt: GateReceipt): GateReceipt => {
    const valid = validateReceipt(receipt);
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
  const result: GateRunResult = { runId, repo, candidateSha, baseSha, dirty, selected: gates.map(g => g.id), added, receipts: list, directory, ok: list.every(success) };
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ runId, candidateSha, baseSha, dirty, ok: result.ok, selected: result.selected, added,
    receipts: list.map(r => ({ gateId: r.gateId, id: r.id, status: r.status, exitCode: r.exitCode, durationMs: Math.round(r.durationMs) })) }, null, 2) + '\n');
  return result;
}
