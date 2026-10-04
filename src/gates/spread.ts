import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ApvConfig } from '../config/load.js';
import type { Gate, ProcessResult } from '../domain/contracts.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import type { Git } from '../execution/git.js';
import { environment, redact, runProcess } from '../execution/process.js';
import { canonicalPath } from '../domain/paths.js';
import { repositoryWorktrees } from '../execution/procs.js';
import { readEnvFile } from '../stacks/config.js';
import { resolveStacks, type ResolvedStack } from '../stacks/idle.js';
import { commonPath, type GateLock } from './suite.js';

/**
 * A full suite spread over several declared test stacks (docs/APV3-SPEC.md, section 18.6): the checks of a stack
 * (those whose `lock` is the lock of a declared stack) are dealt to the stacks given, in configuration order, one each
 * in turn. On the first stack, a check runs in the copy of the suite; on another, in a detached copy of the same
 * commit, prepared by `batch.setup`, with the variables of its stack and under its lock. A check with dependencies, or
 * that others depend on, stays in the copy of the suite (on the first stack): its inputs and outputs live there.
 */
export interface SpreadAssignment {
  gateId: string; stack: ResolvedStack; workspace: string;
  /** Keys of the env file of the stack the check does not receive (not in its passEnv): listed, never passed. */
  notPassed: string[];
}
export interface SpreadCopy { stack: ResolvedStack; dir: string; gates: string[]; error: string | null }
export interface SpreadPlan { assignments: Map<string, SpreadAssignment>; copies: SpreadCopy[] }

/** Whether the lock of `gate`, as configured (its file relative to the Git common directory, or its lease), is the lock of a declared stack. */
async function usesStack(git: Git, repo: string, gate: Gate, stacks: readonly ResolvedStack[]): Promise<boolean> {
  if (!gate.lock) return false;
  if ('resource' in gate.lock) { const resource = gate.lock.resource; return stacks.some(s => s.resource === resource); }
  const file = await commonPath(git, repo, gate.lock.file);
  return stacks.some(s => s.lockFile === file);
}

export async function planSpread(options: { git: Git; repo: string; common: string; config: ApvConfig; gates: readonly Gate[]; ids: readonly string[]; runId: string }): Promise<SpreadPlan> {
  const declared = resolveStacks(options.config, options.common);
  const unknown = options.ids.filter(id => !declared.some(s => s.id === id));
  if (unknown.length) throw new PipelineError('STACK_UNKNOWN', `--stacks : pile inconnue ${unknown.join(', ')} (déclarées : ${declared.map(s => s.id).join(', ') || 'aucune'}, section stacks de .apv/config.json)`);
  const selected = options.ids.map(id => declared.find(s => s.id === id)!);
  const stackGates: Gate[] = [];
  for (const gate of options.gates) if (await usesStack(options.git, options.repo, gate, declared)) stackGates.push(gate);
  const dependents = new Set(options.gates.flatMap(g => g.dependsOn));
  const assignments = new Map<string, SpreadAssignment>();
  const copies = new Map<string, SpreadCopy>();
  let turn = 0;
  for (const gate of stackGates) {
    const movable = gate.dependsOn.length === 0 && !dependents.has(gate.id);
    const stack = movable ? selected[turn++ % selected.length]! : selected[0]!;
    let workspace = options.repo;
    if (stack !== selected[0]) {
      const copy = copies.get(stack.id) ?? { stack, dir: join(options.common, 'apv', 'copies', `${options.runId}-${stack.id.replace(/[^A-Za-z0-9._-]/g, '_')}`), gates: [], error: null };
      copy.gates.push(gate.id);
      copies.set(stack.id, copy);
      workspace = copy.dir;
    }
    // The variables that select the stack must reach the check: otherwise it would run against another stack
    // (its default) while its receipt says this one.
    const received = new Set([...options.config.environment.passEnv, ...gate.passEnv]);
    const missing = Object.keys(stack.config.env ?? {}).filter(k => !received.has(k));
    if (missing.length) {
      throw new PipelineError('GATE_STACKS', `--stacks : le contrôle ${gate.id} ne reçoit pas ${missing.join(', ')}, variable(s) qui désignent la pile ${stack.id} (stacks.${stack.id}.env) : ` +
        `l'ajouter à son passEnv, sinon il tournerait sur une autre pile que celle de son reçu.`);
    }
    // The env file is the whole environment of the stack: its other keys are not for this check, but are said.
    let notPassed: string[] = [];
    if (stack.envFile) {
      try { notPassed = Object.keys(readEnvFile(stack.envFile)).filter(k => !received.has(k)); }
      catch (error) { throw new PipelineError('GATE_STACKS', `--stacks : fichier d'environnement de la pile ${stack.id} illisible (${stack.envFile}) : ${errorMessage(error)}`); }
    }
    assignments.set(gate.id, { gateId: gate.id, stack, workspace, notPassed });
  }
  return { assignments, copies: [...copies.values()] };
}

/**
 * Runs `batch.setup` at the root of `dir` (HOME and `batch.passEnv` passed), bounded by `batch.setupTimeoutMs`: the
 * result, and the tail of its output with the secrets of the environment redacted, ready to be said.
 */
async function runSetup(setup: readonly string[], dir: string, options: { config: ApvConfig; env: NodeJS.ProcessEnv; signal?: AbortSignal | undefined }): Promise<{ result: ProcessResult; output: string }> {
  const env = environment([...options.config.environment.passEnv, 'HOME', ...(options.config.batch?.passEnv ?? [])], options.env);
  const result = await runProcess({ command: [...setup], cwd: dir, env, timeoutMs: options.config.batch!.setupTimeoutMs, maxOutputBytes: 256 * 1024,
    ...(options.signal ? { signal: options.signal } : {}) });
  return { result, output: redact(`${result.stdout}\n${result.stderr}`.trim(), { ...env, ...options.env }).slice(-800) };
}

/**
 * Makes each copy: a detached worktree of `sha`, `batch.setup` run at its root (HOME passed), then a clean tree
 * required. A copy that cannot be made keeps the reason: its checks are not run and their receipts say why.
 */
export async function prepareCopies(plan: SpreadPlan, options: { git: Git; repo: string; sha: string; config: ApvConfig; env: NodeJS.ProcessEnv; signal?: AbortSignal | undefined; log: (line: string) => void }): Promise<void> {
  for (const copy of plan.copies) {
    try {
      if (existsSync(copy.dir)) throw new Error(`la copie ${copy.dir} existe déjà`);
      await options.git.exec(options.repo, ['worktree', 'add', '--detach', copy.dir, options.sha]);
      const setup = options.config.batch?.setup;
      if (setup) {
        options.log(`Pile ${copy.stack.id} : préparation de la copie ${copy.dir} (${setup.join(' ')}).`);
        const { result: r, output } = await runSetup(setup, copy.dir, options);
        if (r.status !== 'passed') throw new Error(`batch.setup en échec (${r.status}, code ${r.exitCode ?? '-'}) : ${output}`);
      }
      const status = await options.git.exec(copy.dir, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (status.trim() !== '') throw new Error(`copie modifiée après sa préparation (fichiers non ignorés) : ${status.trim().split('\n').slice(0, 5).join(', ')}`);
    } catch (error) {
      copy.error = errorMessage(error);
      options.log(`Pile ${copy.stack.id} : copie non préparée (${copy.error}) ; ses contrôles (${copy.gates.join(', ')}) ne tournent pas.`);
    }
  }
}

/**
 * The preparation of the copy of the suite itself (`batch.setup`): `done` when it ran and passed, `missing` when the
 * copy needed it and no `batch.setup` is declared (said, the suite goes on: its checks will likely fail).
 */
export interface MainSetup { status: 'done' | 'missing'; command: string[] | null; durationMs: number; reason: string }

/** Why the copy of a suite needs its preparation: a `package-lock.json` without `node_modules`, else null. */
export function setupNeeded(repo: string): string | null {
  return existsSync(join(repo, 'package-lock.json')) && !existsSync(join(repo, 'node_modules')) ? 'package-lock.json sans node_modules' : null;
}

/**
 * Prepares the copy a full suite runs in, as its copies on other stacks are (prepareCopies) and as `apv dast run`
 * prepares its own: with a `package-lock.json` and no `node_modules`, `batch.setup` at its root (HOME passed), bounded
 * by `batch.setupTimeoutMs`. Nothing needed: null. A setup that fails refuses the suite (`GATE_SETUP`) before anything
 * of it runs; the caller then checks the tree is as clean as before. Never in the main checkout (the folder open in
 * the editor): refused (`GATE_SETUP`). The caller runs it under the place of the copy in the queue, after every refusal.
 */
export async function prepareMainCopy(options: { repo: string; config: ApvConfig; env: NodeJS.ProcessEnv; signal?: AbortSignal | undefined; log: (line: string) => void }): Promise<MainSetup | null> {
  const reason = setupNeeded(options.repo);
  if (!reason) return null;
  const setup = options.config.batch?.setup;
  // Never in the main checkout (the folder open in the editor, the operator's own): a linked worktree only.
  const main = repositoryWorktrees(options.repo)[0];
  if (setup && main !== undefined && main === canonicalPath(options.repo)) {
    throw new PipelineError('GATE_SETUP', `Suite complète refusée, rien n'a été exécuté : copie non préparée (${reason}) et la suite tourne dans le checkout principal (${main}) : ` +
      'batch.setup ne s\'y lance jamais. Installer les dépendances (par exemple npm ci) puis relancer, ou lancer la suite depuis un worktree lié.');
  }
  if (!setup) {
    options.log(`ATTENTION : copie de la suite non préparée (${reason}) et aucun batch.setup déclaré : les contrôles qui lancent les outils du projet échoueront probablement. Déclarer batch.setup (par exemple npm ci) ou installer les dépendances, puis relancer.`);
    return { status: 'missing', command: null, durationMs: 0, reason };
  }
  options.log(`Copie de la suite non préparée (${reason}) : préparation par batch.setup (${setup.join(' ')}).`);
  const { result: r, output } = await runSetup(setup, options.repo, options);
  if (r.status === 'cancelled') throw new PipelineError('CANCELLED', 'Préparation de la copie de la suite (batch.setup) annulée : rien n\'a été exécuté.');
  if (r.status !== 'passed') {
    throw new PipelineError('GATE_SETUP', `Suite complète refusée, rien n'a été exécuté : préparation de la copie de la suite (batch.setup : ${setup.join(' ')}) en échec (${r.status}, code ${r.exitCode ?? '-'}) : ` +
      `${output}`);
  }
  options.log(`Copie de la suite préparée en ${Math.round(r.durationMs / 1000)} s.`);
  return { status: 'done', command: [...setup], durationMs: Math.round(r.durationMs), reason };
}

export async function removeCopies(plan: SpreadPlan, git: Git, repo: string, log: (line: string) => void): Promise<void> {
  for (const copy of plan.copies) {
    if (!existsSync(copy.dir)) continue;
    try { await git.exec(repo, ['worktree', 'remove', '--force', copy.dir]); }
    catch (error) { log(`Copie ${copy.dir} non retirée (${errorMessage(error)}) : git worktree remove --force ${copy.dir}`); }
  }
}

/**
 * The variables of a stack for a check: its env file, then its `env`, then the `fileEnv` variable of the lock of the
 * check pointed at the lock file of the stack; only the names the check receives (`passEnv`), like every variable.
 */
export function stackVariables(stack: ResolvedStack, gate: Gate, passEnv: readonly string[]): Record<string, string> {
  const all: Record<string, string> = { ...(stack.envFile ? readEnvFile(stack.envFile) : {}), ...(stack.config.env ?? {}) };
  if (gate.lock && 'file' in gate.lock && gate.lock.fileEnv && stack.lockFile) all[gate.lock.fileEnv] = stack.lockFile;
  const names = new Set([...passEnv, ...gate.passEnv]);
  return Object.fromEntries(Object.entries(all).filter(([k]) => names.has(k)));
}

/** The lock of a check run on `stack`: the lock of the stack, with the wait the check declares. */
export function stackLock(stack: ResolvedStack, gate: Gate, leaseDir: string): GateLock {
  const waitMs = gate.lock?.waitMs ?? 1_800_000;
  return stack.lockFile ? { kind: 'flock', file: stack.lockFile, waitMs } : { kind: 'lease', resource: stack.resource!, dir: leaseDir, waitMs };
}
