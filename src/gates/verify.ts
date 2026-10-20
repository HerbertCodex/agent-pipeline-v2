import type { GateReceipt, GateStage } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { success } from '../engine/scheduler.js';
import type { ApvConfig } from '../config/load.js';
import { gatesConfigHash, stageGates } from './run.js';
import { mergeBase, repeatProofGap, resolveReference } from './repeat.js';
import { planScope } from './proof-scope.js';
import { sharedStore } from './store.js';
import { infrastructureCause, type InfrastructureCause } from './infrastructure.js';
import { checkReuse, latest, readLocal, readShared, reuseContext, reuseReason, type AlteredRun, type Found, type ReceiptSource } from './reuse-proof.js';
import { auditBase, changedBetween, webAuditGate, webImpact } from '../web/impact.js';

export type { AlteredRun, ReceiptSource } from './reuse-proof.js';

export interface VerifyOptions {
  repo: string;
  config: ApvConfig;
  /** Commit to verify: any revision Git resolves to a commit, compared by its full SHA. */
  commit: string;
  /**
   * `full` (default): every declared check is required, each proven by a complete (never targeted) receipt.
   * `task`: the checks of stage task, and the full checks that declare `affected`, each proven by its targeted
   * receipt (tests concerned by the changes since `base`) or by a complete one.
   */
  stage?: GateStage;
  /**
   * Stage task with targeted checks (required then): the commit the targeted tests must cover the changes from,
   * usually the last commit the full suite proved. A targeted receipt counts only when the base of its run is
   * this commit or one of its ancestors (it then covered at least these changes).
   */
  base?: string;
  /** In place of `repeatChanged.reference`: the branch the changed test files are counted from (`apv stack batch`: its target). */
  repeatReference?: string;
  /** In place of `skipWhenOnly.reference`: the branch the scope of a not required check is counted from (`apv stack batch`: its target). */
  reference?: string;
  /** The configuration file read (`--config`), always required by the scope of a check when inside the repository. */
  configFile?: string | null;
  /** Clock of the age check of reused receipts, in milliseconds (`Date.now()` when absent; tests pass a fixed one). */
  now?: number;
  /**
   * The branch the commit goes to (or a commit of it, such as the merge base of the checks of the base): the `reuse.maxAgeMs`
   * of a reused check is read at its merge base with the commit (5.5.1). A receipt reused by inputs is refused. Absent:
   * `reference`, then the default branch of the remote.
   */
  reuseReference?: string | null;
}
/**
 * State of one required check at the commit:
 * - `passed`: its latest receipt on a clean tree with the current configuration succeeded (`passed_after_retry` included:
 *   every test passed on this exact commit, the failed ones in a single relaunch; reported apart in `flaky`);
 * - `failed`: that latest receipt did not succeed (a later failure always overrides an earlier success);
 * - `dirty`: receipts exist at this commit, but only with uncommitted changes (or an unknown tree state);
 * - `missing`: no receipt at this commit with the current configuration;
 * - `unrepeated`: that latest receipt succeeded, but the check declares `repeatChanged` and the receipt does not show
 *   the repetition of every test file the commit adds or modifies (run without a base, a base too close, files missing);
 * - `unaudited`: that latest receipt succeeded, but its record of `apv web audit` says « audit not required » (whatever
 *   the command that ran it) and the recomputation from the commit says required; or the command shows such an audit
 *   and the receipt records nothing;
 * - `required`: that latest receipt says the check was not required (`not_required`, scope `skipWhenOnly`), but the scope
 *   recomputed from the commit requires it (a file with an effect, a base equal to the commit, a reference unresolved);
 * - `reuse`: that latest receipt is `cached` (reused from another commit) and its reuse does not check out against Git
 *   and the store (docs/ACCELERATION-LOTS.md, 5.5): no `reuse` record, origin absent, altered, not `passed` at first pass,
 *   dirty, targeted, of another configuration or environment, too old, another tree, another base for a command that reads
 *   `{{baseSha}}`, a check that is never reused, or a later failure on the same tree that cannot be excluded (checkReuse,
 *   src/gates/reuse-proof.ts, the check `apv gates run` passes before writing one). It refuses like `missing`, and neither
 *   the CI proof nor the reduced lane stands in for it.
 */
export type EvidenceState = 'passed' | 'failed' | 'dirty' | 'missing' | 'unrepeated' | 'unaudited' | 'required' | 'reuse';
/** A receipt `cached` retained for a check: where it says it comes from, and whether `verify` proved its reuse. */
export interface ReuseEvidence {
  /** True: the reuse is proven (origin read again, trees and digests recomputed); false: state `reuse`, see `reason`. */
  proven: boolean;
  /** Why it proves nothing, or how it was proven (« arbre identique »). */
  reason: string;
  /** Origin as the receipt declares it (null when the receipt has no `reuse` record). */
  fromRun: string | null;
  fromCommit: string | null;
  basis: 'tree' | 'inputs' | null;
  /** Identifier of the origin receipt (`reusedFrom`). */
  origin: string | null;
}
export interface GateEvidence {
  gateId: string;
  state: EvidenceState;
  /** Status of the receipt retained, when there is one. */
  status: GateReceipt['status'] | null;
  receipt: string | null;
  runId: string | null;
  /** Receipts at this commit written for another configuration of the checks (ignored). */
  otherConfig: number;
  /** Receipts at this commit of the targeted variant (`affected`) of the check: never proof of it at stage full. */
  targeted: number;
  /** Stage task: whether the check is required through its targeted variant (a full check that declares `affected`). */
  viaTargeted: boolean;
  /** The kind of the receipt retained: `full` (the whole check) or `targeted` (its `affected` command); null without one. */
  proof: 'full' | 'targeted' | null;
  /** Stage task: targeted receipts ignored because the base of their run does not cover `base` (another base, or none). */
  otherBase: number;
  /** Where the receipt retained was read (the worktree, or the shared store of the repository); null without one. */
  source: ReceiptSource | null;
  /** A check that declares `repeatChanged`: the test files its receipt should have repeated and did not, and why; null otherwise. */
  repeat: { missing: string[]; reason: string } | null;
  /**
   * A receipt `not_required`: the scope recomputed from the commit (`required` false: it proves the check; true: it
   * does not, with the reason and the files that require it); null otherwise.
   */
  scope: { required: boolean; reason: string; files: string[]; blocking: string[] } | null;
  /** A check that runs `apv web audit --preview --base`: why its successful receipt does not prove the audit (files with a web effect, reason); null otherwise. */
  web: { files: string[]; reason: string } | null;
  /** The receipt retained is `cached`: its origin and the outcome of its verification; null for any other receipt. */
  reuse: ReuseEvidence | null;
  /**
   * State `failed`: the infrastructure failure the tool itself observed and recorded in the receipt retained (`finding`:
   * the only one that may decide anything), the one its output only suggests (`probable`, read from the diagnostic by
   * src/gates/infrastructure.ts: shown, never acted upon), and when that receipt ended (`startedAt` plus its duration).
   */
  failure?: { infrastructure: InfrastructureCause | null; probable: InfrastructureCause | null; endedAt: number };
}
export interface VerifyResult {
  repo: string;
  commit: string;
  stage: GateStage;
  /** Base the targeted receipts had to cover (stage task with targeted checks), or null. */
  base: string | null;
  configHash: string;
  required: string[];
  /** Required checks proven through their targeted variant (stage task). */
  targeted: string[];
  /** Stage task: full checks without a targeted variant, left to the full suite (not required, never proven here). */
  reserved: string[];
  gates: GateEvidence[];
  /** Receipt files that could not be read or validated (ignored, reported). */
  unreadable: string[];
  /** Shared store of the repository, read after the worktree (`<git common dir>/apv/receipts`). */
  store: string;
  /** Runs of the shared store refused as a whole (files altered or contradicting their manifest). */
  altered: AlteredRun[];
  /** Required checks proven by a receipt `passed_after_retry`: passed, but only after the relaunch of their failed tests (unstable). */
  flaky: string[];
  /** Checks whose retained receipt took at least 85 % of their timeout (`nearTimeout`): the timeout to raise before it breaks. */
  nearTimeout: { gateId: string; timeoutMs: number; percent: number }[];
  /** Required checks that declare `repeatChanged`: their proof needs a run with `--base`. */
  repeating: string[];
  /** Required checks proven by a receipt `not_required` whose scope the commit confirms (never run: no effect on them). */
  notRequired: string[];
  /** Required checks that declare `skipWhenOnly`: their scope is counted from a run with `--base`. */
  scoped: string[];
  /** Required checks that run `apv web audit --preview --base`: « not required » is recomputed from the commit. */
  auditing: string[];
  /** Required checks proven by a receipt `cached` whose reuse `verify` proved (origin, tree, digests, age). */
  reused: string[];
  ok: boolean;
}

/**
 * Whether the receipts prove that every required check passed on this exact commit, on a clean tree and with
 * the current configuration of the checks. Receipts of any run count (a task run proves its checks as well as a
 * full one), but for each check only the latest such receipt does: a failure is never hidden by an older success.
 * At stage full, receipts of a targeted run (`targeted`, the `affected` command of a full check) never count.
 * At stage task, a full check that declares `affected` is required too: its targeted receipts count when their
 * run's base covers `base` (mandatory then), and so do its complete receipts; the latest of them decides.
 * Receipts are read from the worktree (`.apv/receipts/`), then from the shared store of the repository for the
 * runs the worktree does not have (a run proven in a worktree since removed): same requirements, and a shared
 * run counts only when intact (src/gates/store.ts).
 */
export async function verifyGates(options: VerifyOptions): Promise<VerifyResult> {
  const git = new Git();
  const repo = await git.root(options.repo);
  const commit = await git.sha(repo, options.commit);
  const stage = options.stage ?? 'full';
  invariant(options.config.gates.length > 0, 'NO_GATES', 'No checks configured; declare gates in .apv/config.json');
  const staged = stageGates(options.config.gates, stage);
  const viaTargeted = new Set(staged.targeted.map(g => g.id));
  // Configuration order, the targeted checks in their place.
  const required = options.config.gates.filter(g => staged.run.includes(g) || viaTargeted.has(g.id)).map(g => g.id);
  invariant(required.length > 0, 'NO_GATES', `No check of stage ${stage} is configured: nothing to verify`);
  invariant(!viaTargeted.size || options.base, 'GATE_BASE',
    `Targeted checks (${[...viaTargeted].join(', ')}) are verified against a base: pass --base <ref> (the last commit the full suite proved)`);
  const base = viaTargeted.size && options.base ? await git.sha(repo, options.base) : null;
  const configHash = gatesConfigHash(options.config);
  const local = readLocal(repo);
  const store = await sharedStore(git, repo);
  const shared = readShared(store, local.runs, named => named === null || named === commit);
  const found = [...local.found, ...shared.found];
  const { unreadable } = local;
  const atCommit = found.filter(f => f.receipt.candidateSha === commit);
  // Whether a targeted run from `runBase` covered the changes since `base`: same commit, or an ancestor of it.
  const covered = new Map<string, boolean>();
  const covers = async (runBase: string | null): Promise<boolean> => {
    if (!runBase || !base) return false;
    if (!covered.has(runBase)) covered.set(runBase, runBase === base || await git.contains(repo, base, runBase));
    return covered.get(runBase)!;
  };
  /**
   * Why a successful receipt of a check that declares `repeatChanged` does not prove the repetition of the changed test
   * files at this commit, or null when it does. The files are recomputed here, from the commit, against the base the
   * run recorded and, for a complete receipt at stage full, against the reference: a run without a base, with a base
   * equal to the commit, or with a base too close to leave out some changed tests never proves the check.
   */
  const references = new Map<string, { sha: string | null; reason: string }>();
  const repeatGap = async (settings: NonNullable<ApvConfig['gates'][number]['repeatChanged']>, receipt: GateReceipt, full: boolean): Promise<{ missing: string[]; reason: string } | null> => {
    let reference: { name: string; sha: string | null; reason: string } | null = null;
    if (full) {
      const name = options.repeatReference ?? settings.reference;
      if (!references.has(name)) references.set(name, await resolveReference(git, repo, name));
      reference = { name, ...references.get(name)! };
    }
    return repeatProofGap(git, repo, commit, settings, receipt.repeat, reference);
  };
  /**
   * The scope of a receipt `not_required`, recomputed here from the commit: never taken from the receipt. The base the run
   * recorded (it must not be the commit, nor below it), the reference of the configuration (or the one passed), the paths
   * read at that reference: the check is proven not required only when this recomputation says so.
   */
  const scopeGap = async (gate: ApvConfig['gates'][number], receipt: GateReceipt): Promise<{ required: boolean; reason: string; files: string[]; blocking: string[] }> => {
    const need = (reason: string): { required: boolean; reason: string; files: string[]; blocking: string[] } => ({ required: true, reason, files: [], blocking: [] });
    if (!gate.skipWhenOnly) return need('le contrôle ne déclare plus skipWhenOnly : il est requis');
    const base = receipt.scope?.base;
    if (!base) return need('reçu sans base : la portée ne se recompte pas');
    if (base === commit || await mergeBase(git, repo, base, commit) === commit) return need('base égale au commit ou en aval : aucun changement à comparer');
    const name = options.reference ?? gate.skipWhenOnly.reference;
    const resolved = await resolveReference(git, repo, name);
    if (!resolved.sha) return need(`référence ${name} ${resolved.reason} (skipWhenOnly.reference) : la portée ne se recompte pas`);
    const d = (await planScope(git, repo, options.config, { base, head: commit, reference: name, configFile: options.configFile ?? null })).get(gate.id);
    if (!d) return need('portée non recalculée');
    return { required: d.required, reason: d.reason, files: d.files, blocking: d.blocking };
  };
  /**
   * Why a successful receipt of a check that runs `apv web audit --preview --base <ref>` does not prove the audit, or null.
   * An audit made proves itself (its exit code is the receipt's); « not required » is recomputed here from the commit,
   * against the reference of the command and the base the run recorded: a file with a web effect changed since either,
   * a reference that no longer resolves, or a receipt without record, and nothing is proven.
   */
  const webGap = (receipt: GateReceipt, declared: { base: string | null } | undefined): { files: string[]; reason: string } | null => {
    const record = receipt.web;
    // No record: only a check whose command shows an audit with --base could have skipped it (fallback on the argv).
    if (!record) return declared?.base ? { files: [], reason: 'reçu sans relevé de l\'audit web (APV_WEB_RECORD) : relancer le contrôle avec cette version' } : null;
    if (record.required && record.auditId !== null) return null;
    // « Not required », whatever the command (wrapped in `apv lock run`, a script...): recomputed from the recorded reference and base.
    const bases: string[] = [];
    if (record.reference) {
      const recomputed = auditBase(repo, record.reference, commit);
      if (!recomputed.ok) return { files: [], reason: `« non requis » invérifiable : ${recomputed.message}` };
      bases.push(recomputed.base);
    }
    if (record.base) {
      if (record.base === commit) return { files: [], reason: 'base enregistrée égale au commit : « non requis » ne prouve rien' };
      bases.push(record.base);
    }
    if (!bases.length) return { files: [], reason: '« non requis » sans référence ni base enregistrées : invérifiable' };
    const changed = new Set<string>();
    for (const base of bases) for (const f of changedBetween(repo, base, commit) ?? []) changed.add(f);
    const impact = webImpact([...changed].sort(), options.config.web);
    return impact.required ? { files: impact.files, reason: `audit requis au commit (${impact.files.length} fichier(s) à effet web modifié(s) depuis ${bases[0]!.slice(0, 12)}), reçu « non requis »` } : null;
  };
  const now = options.now ?? Date.now();
  // The check of a receipt `cached`: the very one `apv gates run` passes before writing one (src/gates/reuse-proof.ts).
  const reuseCheck = reuseContext({ git, repo, commit, configHash, now, store, local, reference: options.reuseReference ?? options.reference ?? null });
  const gates: GateEvidence[] = [];
  const near: VerifyResult['nearTimeout'] = [];
  for (const gateId of required) {
    // A receipt of an early check (`early`) is feedback of the task stage, never proof of any check, whatever its id.
    const all = atCommit.filter(f => f.receipt.gateId === gateId && !f.receipt.early);
    const targetedOnes = all.filter(f => f.receipt.targeted === true);
    const targeted = targetedOnes.length;
    const via = viaTargeted.has(gateId);
    // A targeted run only covered the tests concerned by some changes: it proves nothing about the whole check,
    // and at the task stage it counts only when its base covers the changes since `base`.
    const accepted: Found[] = all.filter(f => f.receipt.targeted !== true);
    let otherBase = 0;
    if (via) for (const f of targetedOnes) { if (await covers(f.baseSha)) accepted.push(f); else otherBase += 1; }
    const current = accepted.filter(f => f.receipt.configHash === configHash);
    const otherConfig = accepted.length - current.length;
    const clean = current.filter(f => f.dirty === false);
    if (!clean.length) {
      const state: EvidenceState = current.length ? 'dirty' : 'missing';
      gates.push({ gateId, state, status: null, receipt: null, runId: null, otherConfig, targeted, viaTargeted: via, proof: null, otherBase, source: null, repeat: null, scope: null, web: null, reuse: null });
      continue;
    }
    const last = clean.reduce(latest);
    if (last.receipt.nearTimeout) near.push({ gateId, ...last.receipt.nearTimeout });
    const proof: 'full' | 'targeted' = last.receipt.targeted === true ? 'targeted' : 'full';
    const gate = options.config.gates.find(g => g.id === gateId)!;
    const common = { status: last.receipt.status, receipt: last.receipt.id, runId: last.receipt.runId, otherConfig, targeted, viaTargeted: via, proof, otherBase, source: last.source };
    if (last.receipt.status === 'not_required') {
      const scope = await scopeGap(gate, last.receipt);
      gates.push({ gateId, state: scope.required ? 'required' : 'passed', ...common, repeat: null, scope, web: null, reuse: null });
      continue;
    }
    // A receipt `cached` proves nothing by itself: its reuse is checked, then the repetition and the web audit are judged on
    // what its origin recorded (the copy in the receipt `cached` is never read), recomputed at this commit as for any receipt.
    let proven = last;
    let reuse: ReuseEvidence | null = null;
    if (last.receipt.status === 'cached') {
      const declared = last.receipt.reuse;
      const about = { fromRun: declared?.fromRun ?? null, fromCommit: declared?.fromCommit ?? null, basis: declared?.basis ?? null, origin: last.receipt.reusedFrom };
      const checked = await checkReuse(reuseCheck, gate, last);
      if ('reason' in checked) {
        gates.push({ gateId, state: 'reuse', ...common, repeat: null, scope: null, web: null, reuse: { proven: false, reason: checked.reason, ...about } });
        continue;
      }
      proven = checked.origin;
      reuse = { proven: true, reason: reuseReason(checked), ...about };
    }
    // `success` never counts a receipt `cached` by itself: here it counts once its reuse is proven just above.
    const succeeded = reuse?.proven === true || success(last.receipt);
    const repeat = succeeded && gate.repeatChanged ? await repeatGap(gate.repeatChanged, proven.receipt, stage === 'full' && proof === 'full') : null;
    const audit = webAuditGate(proof === 'targeted' ? gate.affected ?? gate.command : gate.command);
    const web = succeeded ? webGap(proven.receipt, audit) : null;
    const found = last.receipt.finding;
    const failure = succeeded ? {} : { failure: { infrastructure: found ? { gateId, kind: found.kind, detail: found.detail } : null,
      probable: infrastructureCause(last.receipt), endedAt: last.receipt.startedAt + Math.round(last.receipt.durationMs) } };
    gates.push({ gateId, state: !succeeded ? 'failed' : repeat ? 'unrepeated' : web ? 'unaudited' : 'passed', ...common, repeat, scope: null, web, reuse, ...failure });
  }
  return { repo, commit, stage, base, configHash, required, targeted: [...viaTargeted], reserved: staged.reserved.map(g => g.id), gates, unreadable, store, altered: shared.altered,
    flaky: gates.filter(g => g.state === 'passed' && g.status === 'passed_after_retry').map(g => g.gateId), nearTimeout: near,
    repeating: required.filter(id => options.config.gates.some(g => g.id === id && g.repeatChanged)),
    notRequired: gates.filter(g => g.state === 'passed' && g.status === 'not_required').map(g => g.gateId),
    scoped: required.filter(id => options.config.gates.some(g => g.id === id && g.skipWhenOnly)),
    auditing: [...new Set([...required.filter(id => options.config.gates.some(g => g.id === id && webAuditGate(g.command)?.base)),
      ...gates.filter(g => g.state === 'unaudited' || (g.web === null && atCommit.some(f => f.receipt.gateId === g.gateId && f.receipt.web))).map(g => g.gateId)])],
    reused: gates.filter(g => g.state === 'passed' && g.reuse?.proven === true).map(g => g.gateId), ok: gates.every(g => g.state === 'passed') };
}
