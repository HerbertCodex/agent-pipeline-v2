import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_LOCK_WAIT_MS, gateSchema, gateStage, validateReceipt, webRecordSchema, type EarlyCheck, type Gate, type GateReceipt, type GateStage } from '../domain/contracts.js';
import { setTimeout as sleep } from 'node:timers/promises';
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
import { matches } from '../policy/policy.js';
import { WEB_RECORD, runsWebAudit } from '../web/impact.js';
import { RECEIPTS_DIR, pruneStore, receiptRetention, sharedStore, syncRun, type PruneResult } from './store.js';
import { copyStateDigest, localStateDigest } from './reuse.js';
import { readEnvFile } from '../stacks/config.js';
import { readPreviewState } from '../preview/state.js';
import { repositoryWorktrees } from '../execution/procs.js';
import { flockFree, flockHeldByAncestor, judgeStack, markStacksUsed, readStackContainers, resolveStacks, stacksOfLock, stoppedSince, type ResolvedStack, type StackContainer, type StackHealth } from '../stacks/idle.js';
import { defaultLockDir } from '../lock/store.js';
import { classifyFailures, type InfrastructureCause } from './infrastructure.js';
import { planSpread, prepareCopies, prepareMainCopy, removeCopies, stackLock, stackVariables, usesStack, type MainSetup, type SpreadPlan } from './spread.js';
import { checkReuse, findOrigin, readLocal, reuseContext, reuseReason, type ReuseChoice, type ReuseEnvironment } from './reuse-proof.js';
import { fixedWaitRefusal, referenceMissing, mergeBase, optionLikeFile, planRepeat, repeatArgv, repeatDiagnostic, repeatFailures, repeatProofGap, resolveReference, tooManyFiles,
  type RepeatPlan } from './repeat.js';
import { planScope, scopeRecord, scopeReferenceMissing, type ScopeDecision } from './proof-scope.js';
import { FLOCK_TIMEOUT_EXIT, SUITE_MARKER, cleanupSuite, commonPath, enterQueue, withShare, flockCommand, freePorts, queuePlaces, resolveGateLock, withGateLease,
  type CleanupRecord, type PortProcess, type PortsRecord, type QueueHandle, type QueueRecord, type SuiteHooks } from './suite.js';

/** Receipts of `apv gates run`, one directory per execution. Machine evidence, not versioned. */
export { RECEIPTS_DIR } from './store.js';
/** Environment identity of a V3 local run; V2 read it from `environment.id`, a field V3 no longer reads. */
export const ENVIRONMENT_ID = 'apv3-local';

/** The stack a check runs on, for its identity of reuse: its declaration, the names of the variables it gives the check, its fingerprint. */
export interface IdentityStack {
  resolved: ResolvedStack;
  variables: readonly string[];
  /** sha256 of the output of `stacks[].fingerprint`; undefined when the stack declares none, null when it failed or printed nothing. */
  fingerprint: string | null | undefined;
}

/** The port of a URL (`scheme://[user[:password]@]host:port[/...]`), the host kept. */
const URL_PORT = /^([a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(?:\[[^\]/?#]*\]|[^:/?#@]*)):(\d{1,5})(?=[/?#]|$)/i;
/** The port of `host:port` (an IPv6 host between brackets). */
const HOST_PORT = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})$/;

/**
 * The value of a variable of a stack as its identity of reuse records it, with a fingerprint (5.4, relecture sécurité de A2,
 * F3, and of its delta): an address proper to the stack is normalized, its lock file and a port it declares in `ports` (a
 * whole value, the port of a URL, of `host:port`); the rest of the value stays (the host, the user, the database of a URL),
 * and so does any other value (`STACK=2`, a flag, a project name, `postgres:15` against `postgres:16`, a port the stack
 * does not declare, whatever the name of the variable).
 */
export function stackAddress(_name: string, value: string, stack: Pick<ResolvedStack, 'config' | 'lockFile'>): string {
  if (stack.lockFile && value === stack.lockFile) return '{{verrou de la pile}}';
  const declared = (port: string): boolean => (stack.config.ports ?? []).includes(Number(port));
  if (/^\d{1,5}$/.test(value) && declared(value)) return '{{port}}';
  const url = URL_PORT.exec(value);
  if (url && declared(url[2]!)) return `${url[1]}:{{port}}${value.slice(url[0].length)}`;
  const host = HOST_PORT.exec(value);
  if (host && declared(host[2]!)) return `${host[1]}:{{port}}`;
  return value;
}

/**
 * The identity of the environment for a reuse (docs/ACCELERATION-LOTS.md, 5.4), recorded in each receipt (`reuseIdentity`).
 * Without a stack: its `environmentHash`, unchanged. On a stack without `stacks[].fingerprint`: the same environment (the
 * values of the variables of the stack included) plus the id of the stack and its declaration without its envFile, never
 * equal from one stack to another. With a fingerprint: the addresses proper to the stack among the variables it gives the
 * check normalized (stackAddress: the ports it declares in `ports`, whole or in a URL or a `host:port`, its lock file), every other value kept as
 * is (relecture sécurité de A2, F3: `STACK=2` and `STACK=3`, a flag, a project name stay apart), plus the fingerprint
 * command and the digest of its output: equal for two stacks that print the same and differ by their addresses only. A
 * fingerprint that failed or printed nothing: an identity no other ever equals.
 */
export function reuseIdentityFor(env: NodeJS.ProcessEnv, extra: Record<string, unknown>, environmentHash: string, stack: IdentityStack | null): string {
  if (!stack) return environmentHash;
  const declaration = stack.resolved.config;
  if (!declaration.fingerprint) {
    const { envFile: _envFile, ...rest } = declaration;
    return environmentIdentity(ENVIRONMENT_ID, env, { ...extra, stack: { id: declaration.id, declaration: rest } });
  }
  if (!stack.fingerprint) return hash({ notComparable: randomUUID() });
  const replaced = Object.fromEntries(Object.entries(env).map(([name, value]) =>
    [name, stack.variables.includes(name) && value !== undefined ? stackAddress(name, value, stack.resolved) : value]));
  return environmentIdentity(ENVIRONMENT_ID, replaced, { ...extra, stack: { fingerprint: declaration.fingerprint, output: stack.fingerprint, variables: [...stack.variables].sort() } });
}

export interface GateRunOptions {
  repo: string;
  config: ApvConfig;
  /** Selected gate ids; their dependencies are added. Empty or absent: every configured gate. */
  only?: readonly string[];
  /**
   * `task`: the checks of stage task run, a full check with an `affected` command runs that targeted command instead,
   * the other full checks are reported as reserved; the early checks of the full checks (`early`) run too, when their
   * `when` matches a file changed since the base. `full` (default): every check, never targeted, never an early check.
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
  /**
   * Declared test stacks to spread the checks of a stack over (`--stacks 1,2`, docs/APV3-SPEC.md, section 18.6): a
   * full suite only, two stacks at least.
   */
  stacks?: readonly string[];
  /**
   * The reference the full checks that declare `repeatChanged` also compare their changed test files to, in place of
   * `repeatChanged.reference` (`apv stack batch`: its target). Absent: `repeatChanged.reference` of the configuration.
   */
  repeatReference?: string;
  /**
   * False when `repeatChanged.maxFiles` was already applied change by change (`apv stack batch`, pull request by pull
   * request): the run then repeats the union of their files. Default true.
   */
  repeatCeiling?: boolean;
  /**
   * The reference the full checks that declare `skipWhenOnly` count their changed files from, and whose configuration
   * gives their paths, in place of `skipWhenOnly.reference` (`apv stack batch`: its target).
   */
  reference?: string;
  /** The configuration file read (`--config`), always required by the scope of a check when inside the repository. */
  configFile?: string | null;
  /**
   * Incremental proof of a round of corrections (`--since`, src/gates/since.ts): the proven commit the run counts from
   * and the risk of the diff, written in the summary. A task run: never a proof of the full suite.
   */
  since?: { commit: string; head: string; risk: string; reason: string };
  /**
   * Checks run even when a green receipt of an identical tree could be reused (`--replay <id>,<id>` or `--replay all`,
   * docs/ACCELERATION-LOTS.md, A3): their receipt is an execution. Absent: every check that may be reused is.
   */
  replay?: 'all' | readonly string[];
  /**
   * The branch the change goes to (or a commit of it) whose merge base with the commit gives `reuse.maxAgeMs`
   * (docs/ACCELERATION-LOTS.md, 5.5.1): `apv gates run` passes the base of its checks (`--against`, else `--base`). Absent:
   * `reference`, then `base`, then the default branch of the remote.
   */
  reuseReference?: string | null;
  /**
   * `apv stack batch`: the copy of the suite is a fresh worktree, prepared by `batch.setup` whenever a check runs there (not
   * only for a package-lock.json without node_modules), and never when every check is reused (A4).
   */
  batchSetup?: boolean;
}
/** A check reused at an identical tree: the receipt `cached` written, its origin and why. */
export interface ReusedCheck {
  gateId: string;
  /** Identifier of the receipt `cached` written in this run. */
  receipt: string;
  fromRun: string;
  fromCommit: string;
  /** Identifier of the origin receipt (`reusedFrom`). */
  origin: string;
  /** Always `tree` (identical trees, A1): the reuse by inputs (`inputs`) is disabled until its declaration is proven. */
  basis: 'tree' | 'inputs';
  /** Files changed since the origin: 0 at an identical tree. */
  changed: number;
  /** The stack of the environment it is reused for (`--stacks`; the origin may have run on another one with the same fingerprint), or null. */
  stack: string | null;
  reason: string;
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
  /** Early checks of the full checks a task run selected (`early`): run or not required by their `when`, never proof of the full check. */
  early: EarlyDecision[];
  /** Early checks that took more than `EARLY_SLOW_MS`: too slow for the task stage. */
  slowEarly: string[];
  receipts: GateReceipt[];
  directory: string;
  /** Copy in the shared store (`<git common dir>/apv/receipts/<run>/`), null when not asked. */
  shared: SharedCopy | null;
  /** True when the run is a full suite (a check of stage full run in full): queue, clean tree and ports apply. */
  suite: boolean;
  /** The checks recorded as not required by the scope of their proof (`skipWhenOnly`): never run. */
  notRequired: string[];
  /** The scope decisions of the checks of the run that declare `skipWhenOnly` (full run). */
  scope: ScopeDecision[];
  /** The queue of the full suites: its lock, the wait, the load; null outside a full suite or when disabled. */
  queue: QueueRecord | null;
  /** The ports of `suite.ports` freed from orphans of this copy; null when none are declared or outside a full suite. */
  ports: PortsRecord | null;
  /** Checks passed only after the relaunch of their failed tests (`passed_after_retry`): unstable, shown apart. */
  flaky: string[];
  /** The end of a full suite: processes it started still alive, and orphans of this copy on `suite.ports`, stopped. */
  cleanup: CleanupRecord | null;
  /** Stacks the checks lock that `apv stacks idle-stop` stopped and nothing restarted since: their checks will likely fail. */
  stoppedStacks: { stack: string; since: string; gates: string[] }[];
  /**
   * Failed checks whose output points at their infrastructure (a variable of their environment absent, a test stack
   * unreachable, a copy not prepared), and whether every failure of the run is one (src/gates/infrastructure.ts).
   */
  infrastructure: { causes: InfrastructureCause[]; all: boolean };
  /** The checks spread over the stacks (`--stacks`): check, stack, copy where it ran; null without `--stacks`. */
  spread: { gate: string; stack: string; workspace: string; notPassed: string[]; error: string | null }[] | null;
  /**
   * The declared stacks a full suite uses (those of `--stacks`, else those its checks lock): the only ones whose lock and
   * ports it checks, and whose place it holds in the queue. Empty outside a full suite.
   */
  stacksUsed: string[];
  /**
   * The declared stacks whose lock and ports the suite really checks: those it uses, or every one when a check has a
   * lock of no declared stack (`stacksUnmapped`, those checks). Empty outside a full suite.
   */
  stacksChecked: string[];
  stacksUnmapped: string[];
  /** The preparation of the copy of the suite (`batch.setup`, a package-lock.json without node_modules); null when none was needed. */
  setup: MainSetup | null;
  /**
   * Stacks under whose lock a check was interrupted (cancelled, or past its delay: a reset of the stack may have been cut),
   * with the state read after the stop. Empty when none.
   */
  interruptedStacks: { stack: string; gates: string[]; health: StackHealth }[];
  /** Checks reused at an identical tree (receipts `cached`, never run), each checked as `apv gates verify` checks it. */
  reused: ReusedCheck[];
  /** The checks run on demand even when a reuse was possible (`--replay`), `all`, or null. */
  replay: 'all' | string[] | null;
  /**
   * Receipts `cached` of this run checked again at its end, with a fresh read of the store, and that no longer check out (a
   * later failure on the same tree written meanwhile by another copy, an origin removed): the run is not ok.
   */
  reuseStale: { gateId: string; reason: string }[];
  /** Cost of the reading of the store for the reuse (runs looked at, receipt files read, milliseconds), or null when none was looked for. */
  reuseScan: { runs: number; files: number; ms: number } | null;
  ok: boolean;
}

/**
 * The companion of a kernel lock held by an ancestor of the suite: the lock its checks take turns on. One per real lock
 * file (two paths to the same file share it), in the lock folder of the account (`apv lock`, writable even when the
 * folder of the lock is not), so that every project and process under that ancestor shares it, with the same
 * APV_LOCK_DIR (or XDG_STATE_HOME, HOME). That folder cannot be made: the system's temporary folder, per account, then
 * `<lock>.under` beside the lock. A folder is used only if it is a real folder of this account that nobody else can
 * enter (a shared /tmp: another account may have made it first, or put a link there).
 */
export function companionLock(file: string, env: NodeJS.ProcessEnv): string {
  let real = file;
  try { real = realpathSync(file); } catch { /* the path as given */ }
  const name = `${basename(real).replace(/[^\w.-]/g, '_').slice(0, 100)}-${hash(real).slice(0, 12)}.lock`;
  const uid = process.getuid?.();
  for (const dir of [join(defaultLockDir(env), 'under'), join(tmpdir(), `apv-under-${uid ?? 'user'}`)]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const st = lstatSync(dir);
      if (st.isDirectory() && !st.isSymbolicLink() && (uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0) return join(dir, name);
    } catch { /* the next place */ }
  }
  return `${real}.under`;
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

/** Longest duration of an early check before it is said too slow for the task stage: 5 minutes. */
export const EARLY_SLOW_MS = 300_000;
/** An early check (`early` of a full check) as a check of stage task: its own id, command, delay, variables, lock and resources. */
export interface EarlyGate { gate: Gate; parent: string; early: EarlyCheck }

/** The early checks of the full checks among `gates`, in configuration order. Nothing is inherited from the full check. */
export function earlyGates(gates: readonly Gate[]): EarlyGate[] {
  // Parsed as a declared check: the defaults of every other field, the optional ones left out.
  return gates.filter(g => gateStage(g) === 'full').flatMap(g => (g.early ?? []).map(early => ({ parent: g.id, early, gate: gateSchema.parse({
    id: early.id, command: early.command, timeoutMs: early.timeoutMs, passEnv: early.passEnv, dependsOn: early.dependsOn, resources: early.resources,
    stage: 'task', ...(early.lock ? { lock: early.lock } : {}) }) })));
}

/** Whether an early check runs: `required`, why, the full check it stands for and the changed files its `when` matched (50 at most). */
export interface EarlyDecision { id: string; gate: string; required: boolean; reason: string; files: string[] }

/**
 * Files changed since `base` in the working tree: committed, staged or not (both sides of a rename), and untracked files
 * outside those Git ignores. An uncommitted change counts: an early check is feedback on what is there.
 */
export async function changedSince(git: Git, repo: string, base: string): Promise<string[]> {
  const split = (out: string): string[] => out.split('\0').filter(Boolean);
  const tracked = split(await git.exec(repo, ['diff', '--name-only', '--no-renames', '-z', base, '--']));
  const untracked = split(await git.exec(repo, ['ls-files', '--others', '--exclude-standard', '-z']));
  return [...new Set([...tracked, ...untracked])].sort();
}

/**
 * Whether an early check runs. Without `when`: always. Without a base, `when` cannot be evaluated: it runs (an early check
 * only adds). Otherwise it runs when a file changed since the base matches one of its globs, else it is not required.
 */
export function earlyDecision(e: EarlyGate, base: string | null, changed: readonly string[] | null): EarlyDecision {
  const of = { id: e.gate.id, gate: e.parent };
  const when = e.early.when;
  if (!when) return { ...of, required: true, reason: 'toujours (sans when)', files: [] };
  if (!base || !changed) return { ...of, required: true, reason: 'sans --base : when non évalué, lancé', files: [] };
  const matched = changed.filter(f => when.some(glob => matches(f, glob)));
  // The receipt bounds its reason (2000 characters) and its files (4096 characters each).
  const bounded = (text: string): string => text.length > 2000 ? `${text.slice(0, 1996)} ...` : text;
  if (matched.length) {
    return { ...of, required: true, files: matched.filter(f => f.length <= 4096).slice(0, 50),
      reason: bounded(`${matched.length} fichier(s) changé(s) depuis ${base.slice(0, 12)} répond(ent) à when : ${matched.slice(0, 5).join(', ')}${matched.length > 5 ? ' ...' : ''}`) };
  }
  return { ...of, required: false, files: [], reason: bounded(`aucun des ${changed.length} fichier(s) changé(s) depuis ${base.slice(0, 12)} ne répond à when (${when.join(', ')})`) };
}

/** Identity of the declared checks and passed variables, recorded in every receipt and compared by `apv gates verify`. */
export function gatesConfigHash(config: ApvConfig): string {
  return hash({ gates: config.gates, passEnv: config.environment.passEnv });
}

const HELD_BY: Readonly<Record<string, string>> = {
  'other-copy': 'une autre copie du dépôt', 'main-checkout': 'le checkout principal', tool: 'un outil protégé', protected: 'la session',
  outside: 'un processus hors du dépôt', 'unknown-cwd': 'un processus au dossier illisible',
};

/** Why a full suite cannot start: ports of the suite held by others, declared stacks whose lock is held. */
export function busyReasons(ports: PortsRecord | null, stacks: readonly ResolvedStack[], free: (file: string) => boolean | null = flockFree, previewPorts: readonly number[] = [],
  heldByUs: (file: string) => boolean = () => false): string[] {
  const out = (ports?.left ?? []).map(p => `port ${p.ports.join(', ')} tenu par le pid ${p.pid} (${HELD_BY[p.reason] ?? p.reason}${p.worktree ? ` : ${p.worktree}` : ''}) : ${p.command.slice(0, 100)}` +
    `${p.ports.some(port => previewPorts.includes(port)) ? ' ; c\'est le serveur de l\'aperçu vivant : apv preview stop (depuis le checkout qui l\'a lancé), puis relancer la suite' : ''}`);
  // A lock held by the caller itself (the suite launched under `flock <lockFile>`) is its own, not another's.
  for (const s of stacks) if (s.lockFile && free(s.lockFile) === false && !heldByUs(s.lockFile)) out.push(`pile ${s.id} : son verrou (${s.lockFile}) est tenu`);
  return out;
}

/**
 * Whether every port of the suite still held is held by another copy of this repository (`other-copy`: a process whose
 * working directory is in another worktree of the repository: a review that captures screens, a dynamic scan, another
 * suite). Those are APV's own, and finite: the suite waits for them (pilot project, 3 October 2026: a full suite refused
 * because the fidelity review held the three test ports for its captures). A port held by the main checkout, a process
 * outside the repository, a protected tool or the session is never waited for: refused at once, as before.
 */
export function heldByCopies(ports: PortsRecord | null): boolean {
  return ports !== null && ports.left.length > 0 && ports.left.every(p => p.reason === 'other-copy');
}

/** How long a suite waits for its ports: the longest `lock.waitMs` of the checks that lock, else the default lock delay. */
export function portsWaitMs(gates: readonly Gate[]): number {
  const waits = gates.flatMap(g => g.lock ? [g.lock.waitMs] : []);
  return waits.length ? Math.max(...waits) : DEFAULT_LOCK_WAIT_MS;
}

/**
 * The ports of `suite.ports` a suite checks and frees: all but those of a declared stack it does not use (a port of
 * no stack, or also of a stack it uses, is kept).
 */
export function suitePorts(ports: readonly number[], declared: readonly ResolvedStack[], used: readonly string[]): number[] {
  const own = new Set(declared.filter(s => used.includes(s.id)).flatMap(s => s.config.ports ?? []));
  const others = new Set(declared.filter(s => !used.includes(s.id)).flatMap(s => s.config.ports ?? []));
  return ports.filter(p => own.has(p) || !others.has(p));
}

/**
 * The declared stacks a full suite uses: those of `--stacks`, else those the locks of its checks designate (their
 * variables resolved as at run time). `unmapped`: checks whose lock is no declared stack (the tool cannot say which
 * stack they use; the suite then checks and holds every declared stack, as before).
 */
export async function suiteStacks(options: { git: Git; repo: string; config: ApvConfig; gates: readonly Gate[]; declared: readonly ResolvedStack[]; ids?: readonly string[] | undefined; source: NodeJS.ProcessEnv }):
  Promise<{ used: string[]; unmapped: string[] }> {
  const used = new Set<string>(options.ids ?? []);
  const unmapped: string[] = [];
  for (const gate of options.gates) {
    if (!gate.lock) continue;
    const lock = await resolveGateLock(options.git, options.repo, gate.lock, environment([...options.config.environment.passEnv, ...gate.passEnv], options.source), options.source);
    const ids = stacksOfLock(options.declared, lock);
    if (!ids.length) { unmapped.push(gate.id); continue; }
    if (!options.ids) for (const id of ids) used.add(id);
  }
  return { used: options.declared.map(s => s.id).filter(id => used.has(id)), unmapped };
}

const seconds = (ms: number): string => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
const holderText = (p: PortProcess): string => `port ${p.ports.join(', ')} tenu par le pid ${p.pid} (${p.worktree ?? 'copie inconnue'}) : ${p.command.slice(0, 100)}`;

/** Share of its timeout beyond which a receipt warns (`nearTimeout`): 85 %. */
export const NEAR_TIMEOUT = 0.85;

/**
 * The warning of a receipt whose longest pass took at least 85 % of the timeout of its check (a relaunch has its own
 * timeout: each pass is compared alone), or null. A pass that ran out of time is at 100 % or more.
 */
export function nearTimeout(receipt: { status: string; durationMs: number; retry?: { first: { durationMs: number } } | undefined }, timeoutMs: number | undefined): { timeoutMs: number; percent: number } | null {
  if (!timeoutMs || receipt.status === 'blocked' || receipt.status === 'not_required' || receipt.status === 'cached') return null;
  const longest = receipt.retry ? Math.max(receipt.retry.first.durationMs, receipt.durationMs - receipt.retry.first.durationMs) : receipt.durationMs;
  const ratio = longest / timeoutMs;
  return ratio >= NEAR_TIMEOUT ? { timeoutMs, percent: Math.min(1_000_000, Math.max(85, Math.floor(ratio * 100))) } : null;
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
  // The incremental proof classified the diff up to one HEAD: a commit made since then is not what was classified.
  if (options.since && options.since.head !== candidateSha) {
    throw new PipelineError('GATE_SINCE', `--since refusé : HEAD a changé depuis le classement du diff (${options.since.head.slice(0, 12)} classé, ${candidateSha.slice(0, 12)} maintenant). Relancer la même commande.`);
  }
  const baseSha = options.base ? await git.sha(repo, options.base) : null;
  const treeStatus = (): Promise<string> => git.exec(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  const treeOf = (dir: string): Promise<string> => dir === repo ? treeStatus() : git.exec(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  let status = await treeStatus();
  let dirty = status !== '';
  const stage = options.stage ?? 'full';
  const log = options.log ?? ((): void => { /* silent */ });
  let selection = selectGates(options.config.gates, options.only);
  invariant(selection.gates.length > 0, 'NO_GATES', 'No checks configured; declare gates in .apv/config.json');
  // The task stage runs the early checks of the full checks selected, with the checks of stage task they depend on.
  const earlyOf = (selected: readonly Gate[]): EarlyGate[] => stage === 'task' ? earlyGates(selected) : [];
  const earlyNeeds = [...new Set(earlyOf(selection.gates).flatMap(e => e.gate.dependsOn))].filter(d => !selection.gates.some(g => g.id === d));
  if (earlyNeeds.length) {
    const only = options.only ?? [];
    const wider = selectGates(options.config.gates, [...only, ...earlyNeeds]);
    selection = { gates: wider.gates, added: wider.gates.map(g => g.id).filter(id => !only.includes(id)) };
  }
  const { added } = selection;
  const staged = stageGates(selection.gates, stage);
  const { reserved } = staged;
  const targeted = new Set(staged.targeted.map(g => g.id));
  const early = earlyOf(selection.gates);
  // Configuration order; a targeted check keeps its id, dependencies and resources, with its targeted command; each early
  // check right after its full check.
  const gates = selection.gates.flatMap(g => [
    ...(staged.run.includes(g) || targeted.has(g.id) ? [targeted.has(g.id) ? { ...g, command: g.affected! } : g] : []),
    ...early.filter(e => e.parent === g.id).map(e => e.gate)]);
  const duplicates = gates.map(g => g.id).filter((id, i, all) => all.indexOf(id) !== i);
  invariant(!duplicates.length, 'CONFIG', `Identifiant de contrôle en double (contrôle et contrôle tôt) : ${[...new Set(duplicates)].join(', ')}`);
  const asked = isFullSuite(gates, stage);
  if (options.stacks) {
    invariant(asked, 'GATE_STACKS', '--stacks répartit une suite complète : aucun contrôle de stage full à exécuter en entier ici');
    invariant(options.stacks.length >= 1 && new Set(options.stacks).size === options.stacks.length, 'GATE_STACKS', '--stacks attend une ou plusieurs piles différentes, par exemple --stacks 2 ou --stacks 1,2');
    invariant((options.config.stacks ?? []).length >= 1, 'GATE_STACKS', '--stacks : déclarer les piles (section stacks de .apv/config.json)');
  }
  // A full suite on a dirty tree proves nothing: refused before any wait, unless asked for.
  if (asked && dirty && !options.allowDirty) throw dirtyRefusal(status);
  // The scope of the proof (`skipWhenOnly`), decided before any wait: at the full stage, a check whose change only
  // touches files without effect on it is recorded as not required instead of running. Same rigour as repeatChanged:
  // --base required, HEAD strictly below it, the reference resolved; the paths are those of the reference.
  const scopeDecisions = new Map<string, ScopeDecision>();
  const scoped = stage === 'full' ? gates.filter(g => g.skipWhenOnly) : [];
  if (scoped.length) {
    invariant(baseSha, 'GATE_BASE', `${scoped.map(g => g.id).join(', ')} déclare(nt) skipWhenOnly : --base <base de la branche> est obligatoire à la suite complète (la portée se compte depuis elle et depuis la référence).`);
    invariant(await mergeBase(git, repo, baseSha!, candidateSha) !== candidateSha, 'GATE_BASE',
      `--base ${options.base} : HEAD n'en descend pas strictement (base égale à HEAD, ou en aval) ; la portée de ${scoped.map(g => g.id).join(', ')} ne peut pas se compter. Donner la base de la branche (le commit d'où elle part).`);
    for (const g of scoped) {
      const name = options.reference ?? g.skipWhenOnly!.reference;
      const resolved = await resolveReference(git, repo, name);
      if (!resolved.sha) throw new PipelineError('GATE_BASE', scopeReferenceMissing(g.id, name, resolved.reason));
    }
    const all = await planScope(git, repo, options.config, { base: baseSha!, head: candidateSha, dirty, configFile: options.configFile ?? null,
      ...(options.reference ? { reference: options.reference } : {}) });
    for (const g of scoped) if (all.has(g.id)) scopeDecisions.set(g.id, all.get(g.id)!);
  }
  // The early checks a task run selected: run when their `when` (read at the base by the base checks) matches a changed file.
  const changed = baseSha && early.some(e => e.early.when) ? await changedSince(git, repo, baseSha) : null;
  const earlyDecisions = new Map(early.map(e => [e.gate.id, earlyDecision(e, baseSha, changed)]));
  const skipped = new Set([...[...scopeDecisions.values()].filter(d => !d.required).map(d => d.gateId), ...[...earlyDecisions.values()].filter(d => !d.required).map(d => d.id)]);
  for (const d of scopeDecisions.values()) log(`${d.gateId} : ${d.required ? 'requis' : 'non requis'} (portée, skipWhenOnly) : ${d.reason}.`);
  for (const d of earlyDecisions.values()) log(`${d.id} (contrôle tôt de ${d.gate}) : ${d.required ? 'lancé' : 'non requis'} : ${d.reason}.`);
  // What actually runs: a check not required is never started (its dependents are not required either).
  const runnable = gates.filter(g => !skipped.has(g.id));
  // `--replay`: known checks of this run only, said before anything else.
  const replay = options.replay === undefined ? null : options.replay === 'all' ? 'all' as const : [...new Set(options.replay)];
  if (Array.isArray(replay)) {
    const unknown = replay.filter(id => !options.config.gates.some(g => g.id === id));
    invariant(!unknown.length, 'GATE_UNKNOWN', `--replay : contrôle inconnu ${unknown.join(', ')} (déclarés : ${options.config.gates.map(g => g.id).join(', ')})`);
    const outside = replay.filter(id => !gates.some(g => g.id === id));
    invariant(!outside.length, 'GATE_UNKNOWN', `--replay : ${outside.join(', ')} ne fait pas partie des contrôles de cette exécution (${gates.map(g => g.id).join(', ')})`);
  }
  const configHash = gatesConfigHash(options.config);
  const context: Record<string, string> = { workspace: repo, candidateSha, ...(baseSha ? { baseSha } : {}) };
  // Placeholders are resolved before anything runs: a missing --base never fails halfway through a batch.
  const expand = (g: Gate, argv: readonly string[]): string[] => {
    try { return expandCommand(argv, context); }
    catch (error) {
      invariant(!/\{\{baseSha\}\}/.test(argv.join(' ')) || baseSha, 'GATE_BASE', `Le contrôle ${g.id} utilise {{baseSha}} : passez --base <branche de base>, par exemple apv gates run --base origin/main (la base du passage entre dans la preuve).`);
      throw error;
    }
  };
  const commands = new Map(gates.map(g => [g.id, expand(g, g.command)]));
  const retries = new Map(gates.filter(g => g.retryFailed).map(g => [g.id, expand(g, g.retryFailed!.command)]));
  const repeats = new Map(gates.filter(g => g.repeatChanged).map(g => [g.id, expand(g, repeatArgv(g.repeatChanged!))]));
  // The changed test files each check repeats, decided before any wait: a ceiling exceeded or a refused fixed wait
  // stops the run here, explicitly, rather than after a full suite or by a silent skip. Null: no --base to compare to.
  const repeatPlans = new Map<string, RepeatPlan>();
  const repeating = runnable.filter(g => g.repeatChanged);
  if (repeating.length) {
    // Without a base, or with one HEAD does not strictly descend from, nothing would be repeated: refused, never a silent pass.
    invariant(baseSha, 'GATE_BASE', `${repeating.map(g => g.id).join(', ')} déclare(nt) repeatChanged : --base <base de la branche> est obligatoire (les tests ajoutés ou modifiés depuis elle sont répétés).`);
    invariant(await mergeBase(git, repo, baseSha!, candidateSha) !== candidateSha, 'GATE_BASE',
      `--base ${options.base} : HEAD n'en descend pas strictement (base égale à HEAD, ou en aval) ; aucun test modifié ne serait répété pour ${repeating.map(g => g.id).join(', ')}. Donner la base de la branche (le commit d'où elle part).`);
  }
  for (const g of repeating) {
    const settings = g.repeatChanged!;
    // A check run in full also compares to the reference (the branch the change goes to): a --base too close cannot narrow it.
    let reference: string | null = null;
    if (stage === 'full' && !targeted.has(g.id)) {
      const name = options.repeatReference ?? settings.reference;
      const resolved = await resolveReference(git, repo, name);
      reference = resolved.sha;
      if (!reference) throw new PipelineError('GATE_BASE', referenceMissing(g.id, name, resolved.reason));
    }
    const plan = await planRepeat(git, repo, { base: baseSha!, reference }, settings);
    const optionLike = plan.files.find(f => f.startsWith('-'));
    if (optionLike) throw optionLikeFile(g.id, optionLike);
    if (options.repeatCeiling !== false && plan.files.length > settings.maxFiles) throw tooManyFiles(g.id, plan, settings);
    if (plan.fixedWaits.length && settings.fixedWaits === 'refuse') throw fixedWaitRefusal(g.id, plan.fixedWaits);
    if (plan.importsOnly.length) log(`${g.id} : tests dont seuls les imports changent : non répétés (le contrôle les exécute comme les autres) : ${plan.importsOnly.join(', ')}.`);
    if (plan.movedPathsOnly.length) log(`${g.id} : tests dont seuls des chemins de fichiers déplacés changent : non répétés (le contrôle les exécute comme les autres) : ${plan.movedPathsOnly.join(', ')}.`);
    for (const w of plan.fixedWaits) log(`${g.id} : attente à durée fixe dans un test modifié, ${w.file}:${w.line} : ${w.text} (attendre un fait observable ; page.clock pour le temps).`);
    repeatPlans.set(g.id, plan);
  }
  // The stacks the suite uses, before any wait: only their locks and ports are checked, only their places taken.
  const settings = suiteSettings(options.config);
  const source = options.env ?? process.env;
  const common = options.config.stacks?.length ? await commonPath(git, repo, '.') : null;
  const stacks = common ? resolveStacks(options.config, common) : [];
  if (options.stacks) {
    const unknown = options.stacks.filter(id => !stacks.some(s => s.id === id));
    if (unknown.length) throw new PipelineError('STACK_UNKNOWN', `--stacks : pile inconnue ${unknown.join(', ')} (déclarées : ${stacks.map(s => s.id).join(', ') || 'aucune'}, section stacks de .apv/config.json)`);
  }
  // Reuse at an identical tree (docs/ACCELERATION-LOTS.md, A1), decided before any wait: a check whose latest green receipt
  // of an identical tree checks out exactly as `apv gates verify` will check it (findOrigin, then checkReuse) gets a receipt
  // `cached` instead of running. Never on a dirty tree, never a targeted or early check, never one asked by --replay, never one
  // declared reuse: false or that runs apv web audit or apv dast. Only the checks that run count for the queue, the stacks,
  // the ports and the preparations.
  const environmentOf = (gate: Gate, stack: ResolvedStack | null): NodeJS.ProcessEnv => ({ ...environment([...options.config.environment.passEnv, ...gate.passEnv], source),
    ...(stack ? stackVariables(stack, gate, options.config.environment.passEnv) : {}) });
  /** batch.setup must leave the tree of the copy as it was: what it writes is ignored by Git, or the suite is refused. */
  const setupKeptTree = async (): Promise<void> => {
    const now = await treeStatus();
    if (now === status) return;
    const was = new Set(statusLines(status));
    const added = statusLines(now).filter(l => !was.has(l));
    throw new PipelineError('GATE_SETUP', `Suite complète refusée, rien n'a été exécuté : batch.setup a modifié l'arbre de la copie (fichiers non ignorés : ${added.slice(0, 10).join(', ') || 'changement de git status'}). ` +
      'Ignorer ce que la préparation écrit (.gitignore), puis relancer.');
  };
  // `apv stack batch`: its copy is a fresh worktree, prepared by batch.setup BEFORE any reuse is decided (relecture sécurité
  // de A1, M2), so that the local state below is the one of the prepared copy: a copy never prepared never reuses an origin
  // that ran with dependencies installed, and an origin whose dependencies were stale is not the state a fresh install gives.
  let setup: MainSetup | null = null;
  const preparedFirst = options.batchSetup === true && options.config.batch?.setup !== undefined && options.config.batch.setup.length > 0;
  if (preparedFirst) {
    setup = await prepareMainCopy({ repo, config: options.config, env: source, signal: options.signal, log, always: 'copie neuve du lot' });
    if (setup?.status === 'done') await setupKeptTree();
  }
  // What Git ignores and the checks still run with in this copy (node_modules, .env* at any depth, every other ignored file):
  // part of the identity of the environment of each receipt, so a check is reused only from an origin that ran with the same
  // local state (src/gates/reuse.ts). The ignored files are measured once per copy, before anything runs there (copyStateOf).
  const localState = localStateDigest(repo);
  const copyStates = new Map<string, Promise<string>>();
  const copyStateOf = (workspace: string): Promise<string> => {
    if (!copyStates.has(workspace)) copyStates.set(workspace, copyStateDigest(workspace));
    return copyStates.get(workspace)!;
  };
  const copyState = await copyStateDigest(repo);
  // The fingerprint of each stack a check is dealt to (stacks[].fingerprint, docs/ACCELERATION-LOTS.md, 5.4), once per run:
  // undefined when the stack declares none, null when it failed or printed nothing (no reuse from another run on it).
  const fingerprints = new Map<string, Promise<string | null>>();
  const fingerprintOf = (stack: ResolvedStack): Promise<string | null> | undefined => {
    const argv = stack.config.fingerprint;
    if (!argv) return undefined;
    if (!fingerprints.has(stack.id)) fingerprints.set(stack.id, (async (): Promise<string | null> => {
      const env = { ...environment(options.config.environment.passEnv, source), ...(stack.envFile ? readEnvFile(stack.envFile) : {}), ...(stack.config.env ?? {}) };
      const r = await runProcess({ command: argv, cwd: repo, env, timeoutMs: Math.min(stack.config.commandTimeoutMs, 120_000), maxOutputBytes: 64 * 1024, ...(options.signal ? { signal: options.signal } : {}) });
      if (r.status === 'passed' && r.stdout.trim() !== '') return r.stdoutHash;
      log(`Pile ${stack.id} : empreinte (stacks[].fingerprint) ${r.status === 'passed' ? 'vide' : `en échec (${r.status}, code ${r.exitCode ?? '-'})`} : aucun contrôle de cette pile n'est repris d'une autre exécution, ni ne le sera de celle-ci.`);
      return null;
    })().catch(() => null));
    return fingerprints.get(stack.id)!;
  };
  const reuse = new Map<string, ReuseChoice & { environment: ReuseEnvironment & { executable: { path: string; sha256: string } } }>();
  let reuseScan: GateRunResult['reuseScan'] = null;
  const newReuseContext = async (): Promise<ReturnType<typeof reuseContext>> => {
    return reuseContext({ git, repo, commit: candidateSha, configHash, now: Date.now(), store: await sharedStore(git, repo), local: readLocal(repo),
      reference: options.reuseReference ?? options.reference ?? options.base ?? null });
  };
  if (!dirty && replay !== 'all') {
    const ctx = await newReuseContext();
    // The executable of each command, hashed once for the whole decision (relecture sécurité de A2, F4: the Node binary of ten
    // checks was hashed ten times), and again whenever the file changes (path, size, modification and change dates, inode; F4 of the delta review: ctime too). A check that runs hashes it again.
    const executables = new Map<string, { identity: { path: string; sha256: string }; stat: string }>();
    const statOf = (path: string): string => { try { const s = lstatSync(path, { bigint: true }); return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}:${s.dev}`; } catch { return 'illisible'; } };
    const executableOf = async (command: string, env: NodeJS.ProcessEnv): Promise<{ path: string; sha256: string }> => {
      const key = JSON.stringify([command, env['PATH'] ?? null]);
      const known = executables.get(key);
      if (known && statOf(known.identity.path) === known.stat) return known.identity;
      const identity = await executableIdentity(command, repo, env);
      executables.set(key, { identity, stat: statOf(identity.path) });
      return identity;
    };
    for (const gate of runnable) {
      if (targeted.has(gate.id) || earlyDecisions.has(gate.id)) continue;
      if (replay?.includes(gate.id)) { log(`${gate.id} : rejoué sur demande (--replay), même si une reprise était possible.`); continue; }
      const ofStack = options.stacks !== undefined && common !== null && await usesStack(git, repo, gate, stacks);
      // Outside a batch, a check of a stack that --stacks may deal to the copy of another stack (several stacks given, no
      // dependency that keeps it in this copy, planSpread) would run in a copy made after this decision: the local state
      // measured here is the one of this copy, never the one of that copy (relecture sécurité de A1, M2). It runs. A batch
      // prepares all its copies by the same batch.setup of the target, this one before any reuse.
      if (ofStack && options.batchSetup !== true && options.stacks!.length > 1 && gate.dependsOn.length === 0) {
        log(`${gate.id} : non repris : copie de pile hors lot (--stacks ${options.stacks!.join(',')} peut le répartir dans la copie d'une autre pile, ` +
          `dont l'état local n'est pas mesuré avant son exécution) : exécuté.`);
        continue;
      }
      // The environments it would run in now: its variables, its executable, and under --stacks those of each stack given.
      const onStacks = ofStack ? options.stacks!.map(id => stacks.find(s => s.id === id)!) : [null];
      const environments: (ReuseEnvironment & { executable: { path: string; sha256: string } })[] = [];
      for (const stack of onStacks) {
        try {
          const env = environmentOf(gate, stack);
          const executable = await executableOf(commands.get(gate.id)![0]!, env);
          const extra = { executable, local: localState, copy: copyState };
          const environmentHash = environmentIdentity(ENVIRONMENT_ID, env, extra);
          const identity = reuseIdentityFor(env, extra, environmentHash,
            stack ? { resolved: stack, variables: Object.keys(stackVariables(stack, gate, options.config.environment.passEnv)), fingerprint: await fingerprintOf(stack) } : null);
          environments.push({ hash: environmentHash, identity, stack: stack?.id ?? null, executable });
        } catch { /* No environment to compare (executable or env file unreadable): it runs, and says why. */ }
      }
      const found = await findOrigin(ctx, gate, environments, baseSha);
      if ('reason' in found) {
        if (found.candidate || found.reason.startsWith('jamais repris')) log(`${gate.id} : ${found.reason.startsWith('jamais repris') ? found.reason : `non repris (${found.reason})`} : exécuté.`);
        continue;
      }
      // The repetition of the changed test files is judged on the origin, recomputed at this commit, as `verify` judges it.
      if (gate.repeatChanged) {
        let reference: { name: string; sha: string | null; reason: string } | null = null;
        if (stage === 'full') { const name = options.repeatReference ?? gate.repeatChanged.reference; reference = { name, ...await resolveReference(git, repo, name) }; }
        const gap = await repeatProofGap(git, repo, candidateSha, gate.repeatChanged, found.origin.receipt.repeat, reference);
        if (gap) { log(`${gate.id} : non repris (répétition des tests modifiés non prouvée par l'origine : ${gap.reason}) : exécuté.`); continue; }
      }
      reuse.set(gate.id, { ...found, environment: environments.find(e => e.identity === found.identity)! });
    }
    // A check that runs reads what its dependencies wrote (build output...): a dependency of a check that runs runs too.
    for (let changed = true; changed;) {
      changed = false;
      for (const gate of runnable) {
        if (reuse.has(gate.id)) continue;
        for (const dep of gate.dependsOn) {
          if (!reuse.delete(dep)) continue;
          changed = true;
          log(`${dep} : exécuté quand même : ${gate.id}, qui en dépend, est exécuté et lit ce que ${dep} produit.`);
        }
      }
    }
    const scans = [...ctx.scans.values()];
    if (scans.length) { const scan = await scans[0]!; reuseScan = { runs: scan.runs, files: scan.files, ms: scan.ms }; }
    for (const [id, r] of reuse) log(`${id} : réutilisé de ${r.origin.receipt.candidateSha.slice(0, 12)} (exécution ${r.origin.receipt.runId}, ${reuseReason({ basis: r.reuse.basis, changed: r.changed })}) : non relancé.`);
  }
  const executing = runnable.filter(g => !reuse.has(g.id));
  const suite = isFullSuite(executing, stage);
  const usage = suite ? await suiteStacks({ git, repo, config: options.config, gates: executing, declared: stacks, ids: options.stacks, source }) : { used: [], unmapped: [] };
  // A check whose lock is no declared stack: every declared stack is checked and held, as before.
  const checkedStacks = usage.unmapped.length ? stacks : stacks.filter(s => usage.used.includes(s.id));
  const portList = suitePorts(settings.ports, stacks, checkedStacks.map(s => s.id));
  if (suite && usage.unmapped.length && stacks.length) log(`${usage.unmapped.join(', ')} : verrou qui n'est celui d'aucune pile déclarée ; la suite vérifie et tient toutes les piles (${stacks.map(s => s.id).join(', ')}).`);
  // A check that runs `apv web audit`: inside the suite the audit takes no place (APV_SUITE_RUN), so the suite takes
  // every place for it, as the audit does alone: no suite runs while Lighthouse measures, whatever suite.queue.slots.
  const measuring = suite ? executing.filter(g => runsWebAudit(commands.get(g.id) ?? g.command)).map(g => g.id) : [];
  if (measuring.length && settings.queue.enabled) log(`${measuring.join(', ')} : lance apv web audit ; la suite tient toutes les places de la file (aucune suite ne tourne pendant la mesure).`);
  if (suite && stacks.length && !checkedStacks.length) log(`Aucun contrôle de la suite ne verrouille une pile déclarée (${stacks.map(s => s.id).join(', ')}) : aucune pile vérifiée, ni son verrou ni ses ports.`);
  // The queue of the full suites, then the load: every timeout of a check starts after them.
  let queue: QueueHandle | null = null;
  // Set once the run has an id: the end of a full suite stops what it started, even when it is interrupted.
  let started: string | null = null;
  let cleanup: CleanupRecord | null = null;
  let spread: SpreadPlan | null = null;
  let webRecords: string | null = null;
  const endSuite = async (runId: string): Promise<CleanupRecord | null> => {
    if (!suite || cleanup) return cleanup;
    try { cleanup = await cleanupSuite(repo, runId, portList, { log }); }
    catch (error) { log(`Fin de suite : nettoyage des processus en échec (${errorMessage(error)}).`); }
    return cleanup;
  };
  if (suite && settings.queue.enabled) {
    queue = await enterQueue({ lockFile: await commonPath(git, repo, settings.queue.lockFile), settings: settings.queue, repo, log, signal: options.signal, hooks: options.hooks,
      copy: repo, env: source, places: queuePlaces(settings.queue.slots, { used: usage.used, declared: stacks.map(s => s.id), unmapped: usage.unmapped.length > 0, all: measuring.length > 0 }) });
  }
  // The containers of the stacks the suite checks, read before its checks: compared after a check interrupted under their lock.
  const containersBefore = new Map<string, StackContainer[]>();
  const readContainers = options.hooks?.stackContainers ?? ((stack: ResolvedStack) => readStackContainers(stack, repo, source));
  try {
    let ports: PortsRecord | null = null;
    if (suite) {
      if (portList.length) ports = await freePorts(repo, portList, { log });
      // One full suite at a time on a test stack, and no e2e beside it: a port of the suite held by the main checkout
      // or a tool, or a stack it uses whose lock is held, refuses the suite before anything runs (a stack it does not
      // use, and its ports, are another suite's or agent's business). Ports held by another
      // copy of this repository (a review, a dynamic scan, another suite: APV's own, finite) are waited for instead, up
      // to the lock delay of the checks, each wait said; a holder outside a copy appearing meanwhile refuses as before.
      const previews = [repo, repositoryWorktrees(repo)[0] ?? repo].map(r => { try { return readPreviewState(r)?.port ?? null; } catch { return null; } }).filter((x): x is number => x !== null);
      const heldByUs = (file: string): boolean => flockHeldByAncestor(file);
      const refusal = (busy: string[], waited: number): PipelineError => new PipelineError('GATE_BUSY', `Suite complète refusée, rien n'a été exécuté${waited ? ` après ${seconds(waited)} d'attente des ports` : ''} : ${busy.join(' ; ')}. ` +
        'Une autre suite, un e2e lancé par un agent ou un serveur utilise déjà la pile de test : deux exécutions en même temps rendent les tests instables. ' +
        'Attendre sa fin (apv lock status, apv stacks status), ou l\'arrêter s\'il est orphelin (apv procs list, puis apv procs stop --port <p>), puis relancer.');
      let portsWaited = 0;
      if (ports && heldByCopies(ports) && !busyReasons(null, checkedStacks, flockFree, previews, heldByUs).length) {
        const limit = portsWaitMs(executing);
        const pollMs = options.hooks?.portsPollMs ?? 5000;
        const holders = ports.left.map(({ pid, ports: held, command, worktree }) => ({ pid, ports: held, command, worktree }));
        const started = Date.now();
        log(`Ports de la suite tenus par une autre copie du dépôt (une relecture, un scan dynamique ou une autre suite) : ${holders.map(holderText).join(' ; ')}. ` +
          `Attente de leur libération, jusqu'à ${seconds(limit)} (délai de verrou des contrôles), relue toutes les ${seconds(pollMs)}.`);
        let outcome: NonNullable<PortsRecord['wait']>['outcome'] = 'timeout';
        let lastSaid = started;
        while (Date.now() - started < limit) {
          try { await sleep(pollMs, undefined, { signal: options.signal }); }
          catch { throw new PipelineError('CANCELLED', 'Attente des ports de la suite annulée.'); }
          const again = await freePorts(repo, portList, { log: () => { /* said at the end */ } });
          ports = { ...again, stopped: [...ports.stopped, ...again.stopped] };
          if (!ports.left.length) { outcome = 'freed'; break; }
          if (!heldByCopies(ports)) { outcome = 'foreign'; break; }
          if (Date.now() - lastSaid >= 60_000) { lastSaid = Date.now(); log(`Ports de la suite toujours tenus après ${seconds(Date.now() - started)} : ${ports.left.map(holderText).join(' ; ')}.`); }
        }
        portsWaited = Date.now() - started;
        ports.wait = { ms: portsWaited, holders, outcome };
        log(outcome === 'freed' ? `Ports de la suite libérés après ${seconds(portsWaited)} : la suite démarre.`
          : outcome === 'foreign' ? `Ports de la suite pris entre-temps par un processus hors d'une copie du dépôt : refus.`
          : `Ports de la suite toujours tenus après ${seconds(portsWaited)} (délai de verrou) : refus.`);
      }
      const busy = busyReasons(ports, checkedStacks, flockFree, previews, heldByUs);
      if (busy.length) throw refusal(busy, portsWaited);
      for (const stack of checkedStacks) {
        if (!stack.config.dockerProject && !options.hooks?.stackContainers) continue;
        const read = await readContainers(stack);
        if ('containers' in read) containersBefore.set(stack.id, read.containers);
      }
      // The copy may have changed during the waits: the run is on the commit and tree it was asked for, or not at all.
      if (portsWaited > 0 || (queue && queue.record.waitedMs + (queue.record.load?.waitedMs ?? 0) > 0)) {
        const head = await git.sha(repo);
        if (head !== candidateSha) throw new PipelineError('GATE_DIRTY', `Suite complète refusée : HEAD est passé de ${candidateSha.slice(0, 12)} à ${head.slice(0, 12)} pendant l'attente de la file ou des ports. Relancer sur le nouveau commit.`);
        const now = await treeStatus();
        if (now !== status) {
          if (now !== '' && !options.allowDirty) throw dirtyRefusal(now, ' (arbre modifié pendant l\'attente)');
          // The reuses were decided on the clean tree of the commit: a tree changed meanwhile would make them prove other code.
          if (reuse.size) throw new PipelineError('GATE_DIRTY', `Suite complète refusée : l'arbre a changé pendant l'attente de la file ou des ports, alors que ${[...reuse.keys()].join(', ')} devai(en)t être réutilisé(s) d'un arbre identique. Relancer sur un arbre propre.`);
          status = now; dirty = now !== '';
        }
      }
    }
    // The copy of the suite prepared like its copies on other stacks (a package-lock.json without node_modules runs
    // batch.setup): under its place in the queue and after every refusal, so that a refused suite has run nothing; never
    // when no check runs (every one reused). The copy of a batch with a batch.setup was prepared above, before the reuses.
    if (!preparedFirst && (suite || (options.batchSetup && executing.length > 0))) {
      setup = await prepareMainCopy({ repo, config: options.config, env: source, signal: options.signal, log, ...(options.batchSetup ? { always: 'copie neuve du lot' } : {}) });
      if (setup?.status === 'done') await setupKeptTree();
    }
    const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomUUID().slice(0, 8)}`;
    started = runId;
    const directory = join(repo, RECEIPTS_DIR, runId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Where `apv web audit`, run by a check, writes its record (`APV_WEB_RECORD`), outside the copy.
    webRecords = mkdtempSync(join(tmpdir(), 'apv-web-record-'));
    // Receipts are local evidence: keep them out of diffs, scope checks and commits, before any gate
    // (a gate that checks the working tree is clean must not see the receipts of its siblings).
    const ignore = join(repo, RECEIPTS_DIR, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
    // Each receipt visible in the shared store as soon as it is written (relecture sécurité de A1, F2): the run first, with a
    // provisional summary (commit, base, tree state), then every receipt, a failure in progress included, so that a reuse in
    // another copy of the same tree sees it. The full summary replaces it at the end (shareRun). A failure to publish is said
    // once, never fatal: shareRun publishes again at the end and reports.
    const store = options.share === false ? null : await sharedStore(git, repo).catch(() => null);
    let publishFailed = false;
    const publish = (): void => {
      if (!store || publishFailed) return;
      try { syncRun(store, directory, runId, candidateSha, repo); }
      catch (error) { publishFailed = true; log(`Publication en cours d'exécution dans le magasin partagé en échec (${errorMessage(error)}) : reprise à la fin de l'exécution.`); }
    };
    writeFileSync(join(directory, 'summary.json'), JSON.stringify({ runId, candidateSha, baseSha, dirty, stage, ok: null, inProgress: true }, null, 2) + '\n');
    publish();
    // The declared test stacks: a check under the lock of one of them notes its use (apv stacks idle-stop reads it).
    // A suite spread over stacks: checks dealt to the stacks, the copies of the other stacks made now.
    if (options.stacks && common) {
      spread = await planSpread({ git, repo, common, config: options.config, gates: executing, ids: options.stacks, runId });
      log(`Répartition sur les piles : ${[...spread.assignments.values()].map(a => `${a.gateId} sur la pile ${a.stack.id}${a.workspace === repo ? '' : ` (copie ${a.workspace})`}`).join(', ') || 'aucun contrôle de pile'}.`);
      for (const a of spread.assignments.values()) if (a.notPassed.length) log(`Note : ${a.gateId} ne reçoit pas ${a.notPassed.join(', ')} du fichier d'environnement de la pile ${a.stack.id} (absents de son passEnv).`);
      await prepareCopies(spread, { git, repo, sha: candidateSha, config: options.config, env: source, signal: options.signal, log });
    }
    // A stack stopped by idle-stop and not restarted: said before the checks, not discovered as a refused connection.
    const stoppedStacks: GateRunResult['stoppedStacks'] = [];
    if (common) {
      for (const gate of executing) {
        const assignedStack = spread?.assignments.get(gate.id)?.stack.id;
        if (!gate.lock && !assignedStack) continue;
        const ids = assignedStack ? [assignedStack]
          : stacksOfLock(stacks, await resolveGateLock(git, repo, gate.lock!, environment([...options.config.environment.passEnv, ...gate.passEnv], source), source));
        for (const id of ids) {
          const since = stoppedSince(common, id);
          if (!since) continue;
          const entry = stoppedStacks.find(x => x.stack === id) ?? (stoppedStacks.push({ stack: id, since, gates: [] }), stoppedStacks[stoppedStacks.length - 1]!);
          entry.gates.push(gate.id);
        }
      }
      for (const x of stoppedStacks) log(`ATTENTION : la pile ${x.stack} a été arrêtée par apv stacks idle-stop le ${x.since} et rien ne montre qu'elle ait redémarré depuis ; ${x.gates.join(', ')} la verrouille(nt). Redémarrer d'abord : apv stacks start ${x.stack}.`);
    }
    const keys = new Map<string, string>();
    const interrupted = new Map<string, string[]>();
    const missingEnv = new Map<string, string[]>();
    const heldAboveCache = new Map<string, boolean>();
    const heldAbove = (file: string): boolean => {
      if (!heldAboveCache.has(file)) {
        heldAboveCache.set(file, flockHeldByAncestor(file));
        if (heldAboveCache.get(file)) log(`Verrou ${file} déjà tenu par un processus parent de cette suite : les contrôles qui le demandent tournent sous lui, sans le reprendre.`);
      }
      return heldAboveCache.get(file)!;
    };
    const override = options.override ? { run: options.override.run, reason: options.override.reason } : null;
    type Repeat = NonNullable<GateReceipt['repeat']>;
    type RepeatFields = Omit<Repeat, 'command' | 'durationMs' | 'exitCode' | 'output'> & Partial<Pick<Repeat, 'command' | 'durationMs' | 'exitCode' | 'output'>>;
    type Fields = Omit<GateReceipt, 'stage' | 'dirty' | 'targeted' | 'override' | 'lockWaitMs' | 'retry' | 'stack' | 'repeat' | 'web' | 'scope' | 'nearTimeout' | 'early' | 'reuse' | 'reuseIdentity'> & Partial<Pick<GateReceipt, 'lockWaitMs' | 'retry' | 'stack' | 'reuse' | 'reuseIdentity'>> & { repeat?: RepeatFields; web?: NonNullable<GateReceipt['web']> };
    const write = (receipt: Fields): GateReceipt => {
      const decision = scopeDecisions.get(receipt.gateId);
      const earlyRun = earlyDecisions.get(receipt.gateId);
      const durationOf = options.hooks?.durationOf;
      const near = nearTimeout(durationOf ? { ...receipt, durationMs: durationOf(receipt.gateId, receipt.durationMs) } : receipt, gates.find(g => g.id === receipt.gateId)?.timeoutMs);
      if (near) log(`ATTENTION : ${receipt.gateId} a pris ${near.percent} % de son délai (${Math.round(near.timeoutMs / 1000)} s) : augmenter timeoutMs de ce contrôle avant qu'il ne casse une preuve.`);
      const valid = validateReceipt({ ...receipt, stage, dirty, ...(targeted.has(receipt.gateId) || earlyRun ? { targeted: true } : {}), ...(override ? { override } : {}),
        ...(earlyRun ? { early: { gate: earlyRun.gate, id: earlyRun.id, required: earlyRun.required, reason: earlyRun.reason, files: earlyRun.files } } : {}),
        ...(decision ? { scope: scopeRecord(decision) } : {}), ...(near ? { nearTimeout: near } : {}) });
      writeFileSync(join(directory, `${valid.gateId}.json`), JSON.stringify(valid, null, 2) + '\n');
      publish();
      return valid;
    };
    // The receipts `cached` this run wrote after checking their reuse (findOrigin, checkReuse): the only ones counted as passed.
    const reusedIds = new Set<string>();
    const succeeded = (r: GateReceipt): boolean => success(r) || (r.status === 'cached' && reusedIds.has(r.id));
    /** A check reused at an identical tree: a receipt `cached` that cites its origin, written once its dependencies passed, nothing run. */
    const writeReused = (gate: Gate, chosen: NonNullable<ReturnType<typeof reuse.get>>): GateReceipt => {
      const o = chosen.origin.receipt;
      const command = commands.get(gate.id)!;
      const key = proofKey({ repository: repo, baseSha: baseSha ?? candidateSha, candidateSha, taskHash: hash(null), configHash, environmentHash: o.environmentHash,
        workspace: repo, gate: { ...gate, command }, dependencyKeys: gate.dependsOn.map(d => keys.get(d) ?? hash(null)), executable: chosen.environment.executable });
      keys.set(gate.id, key);
      const receipt = write({ id: randomUUID(), runId, gateId: gate.id, key, candidateSha, configHash, environmentHash: o.environmentHash, startedAt: Date.now(),
        status: 'cached', durationMs: 0, exitCode: 0, stdoutHash: o.stdoutHash, stderrHash: o.stderrHash, reusedFrom: o.id, reuse: chosen.reuse,
        diagnostic: `Réutilisé de ${o.candidateSha.slice(0, 12)} (exécution ${o.runId}, reçu ${o.id}) : ${reuseReason({ basis: chosen.reuse.basis, changed: chosen.changed })}, même configuration, même environnement ; non relancé.`,
        ...(chosen.stack ? { stack: chosen.stack } : {}) });
      reusedIds.add(receipt.id);
      return receipt;
    };
    const execute = async (gate: Gate, signal: AbortSignal): Promise<GateReceipt> => {
      const chosen = reuse.get(gate.id);
      if (chosen) return writeReused(gate, chosen);
      const startedAt = Date.now();
      const webRecord = join(webRecords!, `${gate.id}.json`);
      const elapsedStart = performance.now();
      // On a stack of `--stacks`: its copy, its variables (over those of the check) and its lock.
      const assigned = spread?.assignments.get(gate.id) ?? null;
      const workspace = assigned?.workspace ?? repo;
      const env = { ...environment([...options.config.environment.passEnv, ...gate.passEnv], source),
        ...(assigned ? stackVariables(assigned.stack, gate, options.config.environment.passEnv) : {}) };
      // The variables the check asks for and does not get: read again if it fails (infrastructure or test).
      missingEnv.set(gate.id, gate.passEnv.filter(name => !env[name]));
      const command = workspace === repo ? commands.get(gate.id)! : expandCommand(targeted.has(gate.id) ? gate.affected! : gate.command, { ...context, workspace });
      let executable: { path: string; sha256: string } | null = null;
      try { executable = await executableIdentity(command[0]!, workspace, env); } catch { /* reported as spawn_error below */ }
      // The local state of the copy it runs in (this one, or the copy of its stack), measured as it starts, and the files Git
      // ignores there, measured once before the first check of that copy; on a stack, its identity for a reuse (5.4).
      const extra = { executable, local: localStateDigest(workspace), copy: await copyStateOf(workspace) };
      const environmentHash = environmentIdentity(ENVIRONMENT_ID, env, extra);
      const reuseIdentity = reuseIdentityFor(env, extra, environmentHash,
        assigned ? { resolved: assigned.stack, variables: Object.keys(stackVariables(assigned.stack, gate, options.config.environment.passEnv)), fingerprint: await fingerprintOf(assigned.stack) } : null);
      const key = proofKey({ repository: repo, baseSha: baseSha ?? candidateSha, candidateSha, taskHash: hash(null), configHash, environmentHash,
        workspace, gate: { ...gate, command }, dependencyKeys: gate.dependsOn.map(d => keys.get(d) ?? hash(null)),
        executable: executable ?? { path: command[0]!, sha256: hash('unresolved') } });
      keys.set(gate.id, key);
      const base = { id: randomUUID(), runId, gateId: gate.id, key, candidateSha, configHash, environmentHash, reuseIdentity, startedAt, reusedFrom: null,
        ...(assigned ? { stack: assigned.stack.id } : {}) };
      const copyError = assigned ? spread!.copies.find(c => c.dir === workspace)?.error ?? null : null;
      if (copyError) return write({ ...base, status: 'spawn_error', durationMs: 0, exitCode: null, stdoutHash: '', stderrHash: '',
        diagnostic: `Copie de la pile ${assigned!.stack.id} non préparée : ${copyError}. La commande n'a pas été lancée.` });
      if (!executable) return write({ ...base, status: 'spawn_error', durationMs: performance.now() - elapsedStart, exitCode: null,
        stdoutHash: '', stderrHash: '', diagnostic: `Executable unavailable: ${command[0]!}` });
      const secrets = { ...env, ...source };
      const excerpt = (r: ProcessResult, limit = MAX_DIAGNOSTIC_CHARS): string => redact(failureExcerpt(r.status, r.stderr, r.stdout, limit), secrets).slice(0, limit);
      const exitOf = (r: ProcessResult): number | null => r.exitCode !== null && r.exitCode >= 0 && r.exitCode <= 255 ? r.exitCode : null;
      const lock = assigned ? stackLock(assigned.stack, gate, defaultLockDir(source)) : gate.lock ? await resolveGateLock(git, repo, gate.lock, env, source) : null;
      const withLockWait = (ms: number): { lockWaitMs?: number } => lock ? { lockWaitMs: Math.round(ms) } : {};
      /** One pass of a command, under the flock of the check when it has one: the timeout starts once it is held. */
      const pass = async (argv: string[], checkEnv: NodeJS.ProcessEnv, timeoutMs = gate.timeoutMs): Promise<{ result: ProcessResult; commandMs: number; lockWaitMs: number; lockError: string | null }> => {
        // The marker of a full suite, outside the environment identity: its processes are found at its end.
        // The record file of `apv web audit`, outside the environment identity too: emptied before each pass.
        rmSync(webRecord, { force: true });
        const passEnv = { ...(suite ? { ...checkEnv, [SUITE_MARKER]: runId } : checkEnv), [WEB_RECORD]: webRecord };
        // A kernel lock already held by an ancestor (the suite launched under `flock <file>`) is held for the whole run and
        // never taken again: a second flock on the same file from a child would wait for its own parent. The checks that
        // ask for it take turns on a companion lock instead (companionLock: one per real lock file, in the lock folder of
        // the account, shared by every project and process), under the same lock.waitMs. A suite run by such a check
        // (its ancestor holds the companion too) runs under it without taking it again.
        const file = lock?.kind !== 'flock' ? null : !heldAbove(lock.file) ? lock.file : companionLock(lock.file, source);
        if (lock?.kind !== 'flock' || file === null || heldAbove(file)) {
          const result = await runProcess({ command: argv, cwd: workspace, env: passEnv, timeoutMs, signal, maxOutputBytes: 1024 * 1024 });
          return { result, commandMs: result.durationMs, lockWaitMs: 0, lockError: null };
        }
        const result = await runProcess({ command: flockCommand(file, lock.waitMs, argv), cwd: workspace, env: passEnv, timeoutMs, signal,
          maxOutputBytes: 1024 * 1024, waitReady: true });
        if (result.readyMs === null || result.readyMs === undefined) {
          const lockError = result.status === 'cancelled' ? null
            : result.status === 'spawn_error' ? `flock introuvable (util-linux) pour le verrou ${file} : ${result.stderr.slice(0, 500)}`
            : result.exitCode === FLOCK_TIMEOUT_EXIT ? `Verrou flock ${file} non obtenu après ${Math.round(lock.waitMs / 1000)} s (lock.waitMs) : la commande n'a pas été lancée.`
            : `flock en échec pour le verrou ${file} (code ${result.exitCode ?? '-'}) : ${redact(result.stderr, secrets).slice(0, 2000)}`;
          const status: ProcessResult['status'] = result.status === 'cancelled' ? 'cancelled' : result.status === 'spawn_error' ? 'spawn_error' : result.exitCode === FLOCK_TIMEOUT_EXIT ? 'timed_out' : 'failed';
          return { result: { ...result, status }, commandMs: 0, lockWaitMs: result.durationMs, lockError };
        }
        return { result, commandMs: result.durationMs - result.readyMs, lockWaitMs: result.readyMs, lockError: null };
      };
      /** The record of `apv web audit` left by the last pass, when the command is one: added to the receipt. */
      const withWebRecord = (fields: Fields): Fields => {
        try { return { ...fields, web: webRecordSchema.parse(JSON.parse(readFileSync(webRecord, 'utf8'))) }; }
        catch { return fields; }
        finally { rmSync(webRecord, { force: true }); }
      };
      const lockRefused = (reason: string, waitedMs: number): GateReceipt => write({ ...base, status: 'timed_out', durationMs: 0, exitCode: null,
        stdoutHash: '', stderrHash: '', diagnostic: `Verrou du contrôle non obtenu : ${reason}. La commande n'a pas été lancée.`, lockWaitMs: Math.round(waitedMs) });
      /** The command, and its single relaunch (`retryFailed`): the fields of the receipt, before any repetition. */
      const main = async (passEnv: NodeJS.ProcessEnv, leaseWaitMs: number): Promise<Fields> => {
        const first = await pass(command, passEnv);
        let lockWaitMs = leaseWaitMs + first.lockWaitMs;
        const r1 = first.result;
        if (first.lockError !== null || r1.status === 'cancelled' && first.commandMs === 0 && lock?.kind === 'flock') {
          return ({ ...base, status: r1.status, durationMs: 0, exitCode: null, stdoutHash: '', stderrHash: '',
            diagnostic: first.lockError ?? 'cancelled', ...withLockWait(lockWaitMs) });
        }
        const plain = (): Fields => ({ ...base, status: r1.status, durationMs: first.commandMs, exitCode: exitOf(r1),
          stdoutHash: r1.stdoutHash, stderrHash: r1.stderrHash, diagnostic: r1.status === 'passed' ? '' : excerpt(r1), ...withLockWait(lockWaitMs) });
        const retryCommand = retries.has(gate.id) && workspace !== repo ? expandCommand(gate.retryFailed!.command, { ...context, workspace }) : retries.get(gate.id);
        // Only a command that failed by itself is relaunched: a timeout, a cancellation or a missing command is not.
        if (r1.status !== 'failed' || !retryCommand) return plain();
        const tests = failedTests(gate.retryFailed!.testPattern, `${r1.stdout}\n${r1.stderr}`).map(t => redact(t, secrets));
        const firstPass = { status: 'failed' as const, exitCode: exitOf(r1), durationMs: first.commandMs, stdoutHash: r1.stdoutHash, stderrHash: r1.stderrHash, diagnostic: excerpt(r1, 8000) };
        // Same commit, same tree: otherwise the relaunch would prove other code.
        const head = await git.sha(workspace);
        const now = workspace === repo ? await treeStatus() : await git.exec(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
        if (head !== candidateSha || now !== (workspace === repo ? status : '')) {
          return ({ ...base, status: 'failed', durationMs: first.commandMs, exitCode: exitOf(r1), stdoutHash: r1.stdoutHash, stderrHash: r1.stderrHash,
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
          return ({ ...base, status: 'passed_after_retry', durationMs, exitCode: 0, stdoutHash: r2.stdoutHash, stderrHash: r2.stderrHash,
            diagnostic: `Réussi après relance (retryFailed) : première passe en échec (code ${firstPass.exitCode ?? '-'})${tests.length ? ` ; tests relancés : ${tests.join(' ; ')}` : ''}.\n${excerpt(r1, 8000)}`.slice(0, MAX_DIAGNOSTIC_CHARS),
            retry, ...withLockWait(lockWaitMs) });
        }
        const failure = second.lockError ?? excerpt(r2, MAX_DIAGNOSTIC_CHARS - 300);
        return ({ ...base, status: r2.status === 'passed' ? 'failed' : r2.status, durationMs, exitCode: second.lockError === null ? exitOf(r2) : null,
          stdoutHash: second.lockError === null ? r2.stdoutHash : '', stderrHash: second.lockError === null ? r2.stderrHash : '',
          diagnostic: `Relance (retryFailed) en échec aussi :\n${failure}`.slice(0, MAX_DIAGNOSTIC_CHARS), retry, ...withLockWait(lockWaitMs) });
      };
      /**
       * The repetition of the changed test files (`repeatChanged`), once the command passed (after its relaunch
       * included), under the same lock: never relaunched, and any failure turns the check red whatever `retryFailed`
       * said. Without a plan (no --base), no changed file or a command that did not pass, only recorded.
       */
      const repeated = async (fields: Fields, passEnv: NodeJS.ProcessEnv, before: { head: string; tree: string } | null): Promise<Fields> => {
        const settings = gate.repeatChanged;
        const plan = repeatPlans.get(gate.id);
        if (!settings || !plan) return fields;
        const times = settings.times;
        const record = { base: plan.base, reference: plan.reference, files: plan.files, importsOnly: plan.importsOnly, movedPathsOnly: plan.movedPathsOnly, times, fixedWaits: plan.fixedWaits };
        if (!plan.files.length) return { ...fields, repeat: { ...record, status: 'none', failures: [] } };
        const afterRetry = fields.status === 'passed_after_retry';
        if (fields.status !== 'passed' && !afterRetry) return { ...fields, repeat: { ...record, status: 'not_run', failures: [] } };
        const prefix = workspace === repo ? repeats.get(gate.id)! : expandCommand(repeatArgv(settings), { ...context, workspace });
        const withWait = (ms: number): { lockWaitMs?: number } => lock ? { lockWaitMs: Math.round((fields.lockWaitMs ?? 0) + ms) } : {};
        // Same commit, same tree as just before the command of the check: otherwise the repetition would prove other code.
        const head = await git.sha(workspace);
        const tree = await treeOf(workspace);
        if (!before || head !== before.head || tree !== before.tree) {
          const was = new Set(statusLines(before?.tree ?? '')); const now = new Set(statusLines(tree));
          const changes = [...[...now].filter(l => !was.has(l)).map(l => `+ ${l}`), ...[...was].filter(l => !now.has(l)).map(l => `- ${l}`)];
          const why = !before ? 'état de l\'arbre avant la commande inconnu'
            : head !== before.head ? `HEAD est passé de ${before.head.slice(0, 12)} à ${head.slice(0, 12)} pendant la commande du contrôle`
            : `l'arbre de travail a changé pendant la commande du contrôle (${changes.length} entrée(s) de git status : ${changes.slice(0, 10).join(' ; ')}${changes.length > 10 ? ' ...' : ''})`;
          return { ...fields, status: 'failed', exitCode: null, repeat: { ...record, status: 'failed', command: prefix, failures: [] },
            diagnostic: `Répétition des tests modifiés refusée : ${why} ; elle ne prouverait pas le même code. Une commande de contrôle ne doit écrire que des fichiers ignorés par Git.` };
        }
        log(`${gate.id} : répétition des tests modifiés (repeatChanged), ${times} fois chacun : ${plan.files.join(', ')}${settings.stressArgs ? ` ; charge : ${settings.stressArgs.join(' ')}` : ''}.`);
        const timeoutMs = settings.timeoutMs ?? gate.timeoutMs;
        const run = await pass([...prefix, ...plan.files], passEnv, timeoutMs);
        const r = run.result;
        const output = `${r.stdout}\n${r.stderr}`;
        const pattern = settings.testPattern ?? gate.retryFailed?.testPattern;
        const failures = run.lockError === null ? repeatFailures(pattern, output).map(f => ({ ...f, test: redact(f.test, secrets).slice(0, 500) })) : [];
        const durationMs = fields.durationMs + run.commandMs;
        const repeat = { ...record, command: prefix, durationMs: run.commandMs, exitCode: run.lockError === null ? exitOf(r) : null, failures,
          output: redact(output.trim(), secrets).slice(-4000) };
        if (run.lockError === null && r.status === 'passed') {
          log(`${gate.id} : répétition des tests modifiés réussie (${plan.files.length} fichier(s), ${times} fois).`);
          return { ...fields, durationMs, repeat: { ...repeat, status: 'passed' }, ...withWait(run.lockWaitMs) };
        }
        const failed = r.status === 'passed' ? 'failed' : r.status;
        log(`${gate.id} : répétition des tests modifiés en échec (${failed})${failures.length ? ` : ${failures.slice(0, 5).map(f => `${f.test} échoue ${f.count} fois sur ${times}`).join(' ; ')}` : ''}.`);
        const diagnostic = repeatDiagnostic({ files: plan.files, times, failures, afterRetry, status: failed, timeoutMs, hasPattern: pattern !== undefined,
          excerpt: run.lockError ?? excerpt(r, 6000) });
        return { ...fields, status: failed, durationMs, exitCode: repeat.exitCode, stdoutHash: run.lockError === null ? r.stdoutHash : '', stderrHash: run.lockError === null ? r.stderrHash : '',
          diagnostic: diagnostic.slice(0, MAX_DIAGNOSTIC_CHARS), repeat: { ...repeat, status: failed }, ...withWait(run.lockWaitMs) };
      };
      const body = async (passEnv: NodeJS.ProcessEnv, leaseWaitMs: number): Promise<GateReceipt> => {
        // The state the repetition must find again: taken just before the command, under the lock.
        const plan = repeatPlans.get(gate.id);
        const before = plan?.files.length ? { head: await git.sha(workspace), tree: await treeOf(workspace) } : null;
        return write(await repeated(withWebRecord(await main(passEnv, leaseWaitMs)), passEnv, before));
      };
      const used = lock && common ? stacksOfLock(stacks, lock) : [];
      let outcome: GateReceipt | null = null;
      // A browser or stack check outside the full suite (a stack lock, or the targeted command) takes a shared part of the queue.
      const sharing = !suite && settings.queue.enabled && (targeted.has(gate.id) || used.length > 0);
      const execute = async (checkEnv: NodeJS.ProcessEnv): Promise<GateReceipt> => lock?.kind === 'lease'
        ? withGateLease(lock, { label: `apv gates run ${gate.id} (${workspace})`, env: checkEnv, source, signal, log, hooks: options.hooks }, body, lockRefused)
        : body(checkEnv, 0);
      try {
        outcome = sharing
          ? await withShare({ lockFile: await commonPath(git, repo, settings.queue.lockFile), waitMs: settings.queue.waitMs, label: `apv gates run ${gate.id} (${workspace})`, purpose: `contrôle ${gate.id}`,
            env, source, signal, log, hooks: options.hooks }, execute, lockRefused)
          : await execute(env);
        return outcome;
      } finally {
        if (used.length && common) markStacksUsed(common, used, outcome !== null && success(outcome));
        // Its command started under the lock of a stack and was stopped (cancelled, or past its delay): a reset of the
        // stack may have been cut halfway. The stack is read again once the suite has stopped what it started.
        if (suite && used.length && outcome && (outcome.status === 'cancelled' || outcome.status === 'timed_out') && outcome.durationMs > 0) {
          for (const id of used) interrupted.set(id, [...(interrupted.get(id) ?? []), gate.id]);
        }
      }
    };
    const blocked = (gate: Gate, reason: string): GateReceipt => write({ id: randomUUID(), runId, gateId: gate.id, key: hash({ blocked: gate.id, candidateSha }), candidateSha, configHash,
      environmentHash: hash('not-executed'), status: 'blocked', startedAt: Date.now(), durationMs: 0, exitCode: null,
      stdoutHash: '', stderrHash: '', diagnostic: reason, reusedFrom: null });
    const failFast = options.failFast ?? true;
    // The checks not required: a receipt that says so, with the scope, and nothing run.
    const notRequired = new Map(gates.filter(g => skipped.has(g.id)).map(g => {
      const e = earlyDecisions.get(g.id);
      if (e) {
        return [g.id, write({ id: randomUUID(), runId, gateId: g.id, key: hash({ notRequired: g.id, early: e.gate, candidateSha, configHash, base: baseSha }),
          candidateSha, configHash, environmentHash: hash('not-executed'), status: 'not_required', startedAt: Date.now(), durationMs: 0, exitCode: null,
          stdoutHash: '', stderrHash: '', diagnostic: `Non requis (contrôle tôt de ${e.gate}, hors when) : ${e.reason}.`.slice(0, MAX_DIAGNOSTIC_CHARS), reusedFrom: null })] as const;
      }
      const d = scopeDecisions.get(g.id)!;
      return [g.id, write({ id: randomUUID(), runId, gateId: g.id, key: hash({ notRequired: g.id, candidateSha, configHash, base: d.base, reference: d.reference, referenceSha: d.referenceSha }),
        candidateSha, configHash, environmentHash: hash('not-executed'), status: 'not_required', startedAt: Date.now(), durationMs: 0, exitCode: null,
        stdoutHash: '', stderrHash: '', diagnostic: `Non requis (portée, skipWhenOnly) : ${d.reason}.`.slice(0, MAX_DIAGNOSTIC_CHARS), reusedFrom: null })] as const;
    }));
    let list: GateReceipt[];
    if (!spread?.copies.length) {
      list = await schedule(runnable, { concurrency: options.concurrency ?? 3, failFast, signal: options.signal ?? new AbortController().signal, execute, blocked, succeeded });
    } else {
      // One scheduler per copy (each has its own workspace), run together; a failure stops them all under failFast.
      const stop = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
      const inCopy = new Set(spread.copies.flatMap(c => c.gates));
      const groups = [runnable.filter(g => !inCopy.has(g.id)), ...spread.copies.map(c => runnable.filter(g => c.gates.includes(g.id)))].filter(g => g.length);
      const run = async (gate: Gate, s: AbortSignal): Promise<GateReceipt> => {
        const receipt = await execute(gate, s);
        if (failFast && !succeeded(receipt)) stop.abort();
        return receipt;
      };
      const results = await Promise.all(groups.map(group => schedule(group, { concurrency: options.concurrency ?? 3, failFast, signal, execute: run, blocked, succeeded })));
      const byId = new Map(results.flat().map(r => [r.gateId, r]));
      list = runnable.map(g => byId.get(g.id)!);
    }
    const ran = new Map(list.map(r => [r.gateId, r]));
    list = gates.map(g => notRequired.get(g.id) ?? ran.get(g.id)!);
    const flaky = list.filter(r => r.status === 'passed_after_retry').map(r => r.gateId);
    // An early check is fast feedback: one that takes longer than EARLY_SLOW_MS is said, to be narrowed or left to the full suite.
    const measured = (r: GateReceipt): number => options.hooks?.durationOf ? options.hooks.durationOf(r.gateId, r.durationMs) : r.durationMs;
    const slowEarly = list.filter(r => r.early && r.status !== 'not_required' && r.status !== 'blocked' && measured(r) > EARLY_SLOW_MS).map(r => r.gateId);
    for (const id of slowEarly) log(`ATTENTION : ${id} (contrôle tôt de ${earlyDecisions.get(id)!.gate}) : plus de ${EARLY_SLOW_MS / 60_000} min, trop lent pour le stage task ; le resserrer (when, fichiers lancés) ou le laisser à la suite complète.`);
    await endSuite(runId);
    const interruptedStacks: GateRunResult['interruptedStacks'] = [];
    for (const [id, ids] of interrupted) {
      const stack = stacks.find(s => s.id === id)!;
      let health: StackHealth;
      try { health = judgeStack(await readContainers(stack), containersBefore.get(id) ?? null); }
      catch (error) { health = { state: 'unknown', detail: errorMessage(error), containers: [], missing: [] }; }
      interruptedStacks.push({ stack: id, gates: ids, health });
      log(`ATTENTION : pile ${id} : ${ids.join(', ')} interrompu(s) sous son verrou (annulation ou délai dépassé) ; une remise à zéro de la pile a pu être coupée. ` +
        `État relu après l'arrêt : ${health.state === 'running' ? 'en marche' : health.state === 'degraded' ? 'abîmée' : health.state === 'absent' ? 'aucun conteneur' : 'non vérifié'} (${health.detail}).` +
        `${health.state === 'running' ? '' : ` Avant la prochaine suite sur cette pile : apv stacks status, puis au besoin redémarrer la pile (apv stacks start ${id}).`}`);
    }
    const spreadRecord = spread ? [...spread.assignments.values()].map(a => ({ gate: a.gateId, stack: a.stack.id, workspace: a.workspace, notPassed: a.notPassed,
      error: spread!.copies.find(c => c.dir === a.workspace)?.error ?? null })) : null;
    // Each receipt `cached` checked again, with a fresh read of the store, exactly as `apv gates verify` will: a later failure of
    // the same tree written meanwhile by another copy, or an origin removed, and the run says so instead of passing.
    const written = list.filter(r => r.status === 'cached' && reusedIds.has(r.id));
    const reuseStale: GateRunResult['reuseStale'] = [];
    if (written.length) {
      const again = await newReuseContext();
      for (const r of written) {
        const checked = await checkReuse(again, gates.find(g => g.id === r.gateId), { receipt: r, dirty: r.dirty ?? null, baseSha, source: 'local' });
        if (!('reason' in checked)) continue;
        reuseStale.push({ gateId: r.gateId, reason: checked.reason });
        log(`ATTENTION : ${r.gateId} : reprise devenue invérifiable pendant l'exécution (${checked.reason}) ; relancer avec --replay ${r.gateId}.`);
      }
    }
    const reused: ReusedCheck[] = written.map(r => ({ gateId: r.gateId, receipt: r.id, fromRun: r.reuse!.fromRun, fromCommit: r.reuse!.fromCommit, origin: r.reusedFrom!, basis: r.reuse!.basis,
      changed: r.reuse!.changed, stack: r.stack ?? null, reason: reuseReason({ basis: r.reuse!.basis, changed: r.reuse!.changed }) }));
    const result: GateRunResult = { runId, repo, candidateSha, baseSha, dirty, stage, selected: gates.map(g => g.id), added,
      reserved: reserved.map(g => g.id), targeted: [...targeted], early: [...earlyDecisions.values()], slowEarly, receipts: list, directory, shared: null, suite, notRequired: [...notRequired.keys()], scope: [...scopeDecisions.values()],
      queue: queue?.record ?? null, ports, flaky, cleanup, stoppedStacks, infrastructure: classifyFailures(list, missingEnv), spread: spreadRecord,
      stacksUsed: suite ? usage.used : [], stacksChecked: suite ? checkedStacks.map(s => s.id) : [], stacksUnmapped: suite ? usage.unmapped : [], setup, interruptedStacks,
      reused, replay, reuseStale, reuseScan,
      ok: list.every(r => succeeded(r) || r.status === 'not_required') && !reuseStale.length };
    writeFileSync(join(directory, 'summary.json'), JSON.stringify({ runId, candidateSha, baseSha, dirty, stage, ok: result.ok, selected: result.selected, added,
      reserved: result.reserved, targeted: result.targeted, ...(result.early.length ? { early: result.early } : {}), ...(slowEarly.length ? { slowEarly } : {}),
      ...(override ? { override } : {}), ...(options.since ? { since: options.since } : {}),
      ...(suite ? { suite: true, queue: result.queue, ports, flaky, cleanup, stacksUsed: result.stacksUsed, stacksChecked: result.stacksChecked } : {}), ...(setup ? { setup } : {}),
      ...(interruptedStacks.length ? { interruptedStacks } : {}), ...(spreadRecord ? { spread: spreadRecord } : {}), ...(stoppedStacks.length ? { stoppedStacks } : {}),
      ...(result.infrastructure.causes.length ? { infrastructure: result.infrastructure } : {}),
      ...(reused.length ? { reused: reused.map(r => ({ gateId: r.gateId, fromRun: r.fromRun, fromCommit: r.fromCommit, origin: r.origin, basis: r.basis })) } : {}),
      ...(replay ? { replay } : {}), ...(reuseStale.length ? { reuseStale } : {}),
      receipts: list.map(r => ({ gateId: r.gateId, id: r.id, status: r.status, ...(r.targeted ? { targeted: true } : {}), ...(r.early ? { early: r.early.gate } : {}), exitCode: r.exitCode, durationMs: Math.round(r.durationMs),
        ...(r.lockWaitMs !== undefined ? { lockWaitMs: r.lockWaitMs } : {}), ...(r.retry ? { retriedTests: r.retry.tests } : {}), ...(r.stack ? { stack: r.stack } : {}),
        ...(r.nearTimeout ? { nearTimeout: r.nearTimeout } : {}),
        ...(r.repeat ? { repeat: { status: r.repeat.status, files: r.repeat.files, times: r.repeat.times, failures: r.repeat.failures } } : {}),
        ...(r.scope ? { scope: { required: r.scope.required, reason: r.scope.reason, fileCount: r.scope.fileCount } } : {}),
        ...(r.web ? { web: { required: r.web.required, auditId: r.web.auditId, ok: r.web.ok } } : {}) })) }, null, 2) + '\n');
    if (options.share !== false) result.shared = await shareRun(git, repo, directory, runId, candidateSha, options.config);
    return result;
  } finally {
    if (webRecords) rmSync(webRecords, { recursive: true, force: true });
    if (started) await endSuite(started);
    if (spread) await removeCopies(spread, git, repo, log);
    await queue?.release();
  }
}

/**
 * Brings the copy of a finished run in the shared store of the repository up to date (its full summary, every receipt;
 * published as it went, syncRun), so that it survives its worktree, then applies the retention of the store. A failure
 * is reported, never fatal: the run and its local receipts stand.
 */
async function shareRun(git: Git, repo: string, directory: string, runId: string, candidateSha: string, config: ApvConfig): Promise<SharedCopy> {
  let target: string;
  let store: string;
  try {
    store = await sharedStore(git, repo);
    target = syncRun(store, directory, runId, candidateSha, repo);
  } catch (error) { return { directory: null, error: errorMessage(error), pruned: null }; }
  let pruned: PruneResult | null = null;
  try { pruned = pruneStore(store, receiptRetention(config)); } catch { /* Retention is retried by the next run. */ }
  return { directory: target, error: null, pruned };
}
