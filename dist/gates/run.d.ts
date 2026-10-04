import { type Gate, type GateReceipt, type GateStage } from '../domain/contracts.js';
import { Git } from '../execution/git.js';
import { type ApvConfig } from '../config/load.js';
import { PipelineError } from '../domain/errors.js';
import { type PruneResult } from './store.js';
import { type ResolvedStack, type StackHealth } from '../stacks/idle.js';
import { type InfrastructureCause } from './infrastructure.js';
import { type MainSetup } from './spread.js';
import { type ScopeDecision } from './proof-scope.js';
import { type CleanupRecord, type PortsRecord, type QueueRecord, type SuiteHooks } from './suite.js';
/** Receipts of `apv gates run`, one directory per execution. Machine evidence, not versioned. */
export declare const RECEIPTS_DIR = ".apv/receipts";
/** Environment identity of a V3 local run; V2 read it from `environment.id`, a field V3 no longer reads. */
export declare const ENVIRONMENT_ID = "apv3-local";
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
    override?: {
        run: string;
        reason: string;
    };
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
    since?: {
        commit: string;
        head: string;
        risk: string;
        reason: string;
    };
}
/** The copy of a run in the shared store: its directory, or why it could not be made (the run itself stands). */
export interface SharedCopy {
    directory: string | null;
    error: string | null;
    pruned: PruneResult | null;
}
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
    stoppedStacks: {
        stack: string;
        since: string;
        gates: string[];
    }[];
    /**
     * Failed checks whose output points at their infrastructure (a variable of their environment absent, a test stack
     * unreachable, a copy not prepared), and whether every failure of the run is one (src/gates/infrastructure.ts).
     */
    infrastructure: {
        causes: InfrastructureCause[];
        all: boolean;
    };
    /** The checks spread over the stacks (`--stacks`): check, stack, copy where it ran; null without `--stacks`. */
    spread: {
        gate: string;
        stack: string;
        workspace: string;
        notPassed: string[];
        error: string | null;
    }[] | null;
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
    interruptedStacks: {
        stack: string;
        gates: string[];
        health: StackHealth;
    }[];
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
export declare function companionLock(file: string, env: NodeJS.ProcessEnv): string;
/** Files of a `git status --porcelain=v1 -z` output, as `XY path` lines. */
export declare function statusLines(porcelain: string): string[];
/** The refusal of a full suite on a working tree with uncommitted changes, listing them (50 at most). */
export declare function dirtyRefusal(porcelain: string, when?: string): PipelineError;
/** A run that executes at least one check of stage full in full: the full suite, under its queue and guards. */
export declare const isFullSuite: (gates: readonly Gate[], stage: GateStage) => boolean;
/** Lines of a test output that name tests: `pattern` (capture group 1 when present), ANSI codes removed, 100 at most. */
export declare function failedTests(pattern: string | undefined, output: string): string[];
/** Selected gates in configuration order, with their transitive dependencies. */
export declare function selectGates(gates: readonly Gate[], only?: readonly string[]): {
    gates: Gate[];
    added: string[];
};
/**
 * Checks a stage requires (`run`), the full checks a task stage runs through their targeted `affected` command
 * (`targeted`, never proof of the full check) and the selected checks it leaves to the full suite (`reserved`).
 */
export declare function stageGates(gates: readonly Gate[], stage: GateStage): {
    run: Gate[];
    targeted: Gate[];
    reserved: Gate[];
};
/** Identity of the declared checks and passed variables, recorded in every receipt and compared by `apv gates verify`. */
export declare function gatesConfigHash(config: ApvConfig): string;
/** Why a full suite cannot start: ports of the suite held by others, declared stacks whose lock is held. */
export declare function busyReasons(ports: PortsRecord | null, stacks: readonly ResolvedStack[], free?: (file: string) => boolean | null, previewPorts?: readonly number[], heldByUs?: (file: string) => boolean): string[];
/**
 * Whether every port of the suite still held is held by another copy of this repository (`other-copy`: a process whose
 * working directory is in another worktree of the repository: a review that captures screens, a dynamic scan, another
 * suite). Those are APV's own, and finite: the suite waits for them (pilot project, 3 October 2026: a full suite refused
 * because the fidelity review held the three test ports for its captures). A port held by the main checkout, a process
 * outside the repository, a protected tool or the session is never waited for: refused at once, as before.
 */
export declare function heldByCopies(ports: PortsRecord | null): boolean;
/** How long a suite waits for its ports: the longest `lock.waitMs` of the checks that lock, else the default lock delay. */
export declare function portsWaitMs(gates: readonly Gate[]): number;
/**
 * The ports of `suite.ports` a suite checks and frees: all but those of a declared stack it does not use (a port of
 * no stack, or also of a stack it uses, is kept).
 */
export declare function suitePorts(ports: readonly number[], declared: readonly ResolvedStack[], used: readonly string[]): number[];
/**
 * The declared stacks a full suite uses: those of `--stacks`, else those the locks of its checks designate (their
 * variables resolved as at run time). `unmapped`: checks whose lock is no declared stack (the tool cannot say which
 * stack they use; the suite then checks and holds every declared stack, as before).
 */
export declare function suiteStacks(options: {
    git: Git;
    repo: string;
    config: ApvConfig;
    gates: readonly Gate[];
    declared: readonly ResolvedStack[];
    ids?: readonly string[] | undefined;
    source: NodeJS.ProcessEnv;
}): Promise<{
    used: string[];
    unmapped: string[];
}>;
/** Share of its timeout beyond which a receipt warns (`nearTimeout`): 85 %. */
export declare const NEAR_TIMEOUT = 0.85;
/**
 * The warning of a receipt whose longest pass took at least 85 % of the timeout of its check (a relaunch has its own
 * timeout: each pass is compared alone), or null. A pass that ran out of time is at 100 % or more.
 */
export declare function nearTimeout(receipt: {
    status: string;
    durationMs: number;
    retry?: {
        first: {
            durationMs: number;
        };
    } | undefined;
}, timeoutMs: number | undefined): {
    timeoutMs: number;
    percent: number;
} | null;
/**
 * Runs configured checks in the project working tree: dependency graph, named resources and read/write
 * exclusion through the V2 scheduler, only the declared variables passed, each command bounded by its
 * timeout, secrets redacted from diagnostics. Each receipt is validated and written as JSON.
 * Extracted from the V2 controller validation step, without its disposable worktree, its receipt cache
 * or its approval state: an implementer runs this in the worktree it owns.
 */
export declare function runGates(options: GateRunOptions): Promise<GateRunResult>;
