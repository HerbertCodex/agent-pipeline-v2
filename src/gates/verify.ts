import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateReceipt, type GateReceipt, type GateStage } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { success } from '../engine/scheduler.js';
import type { ApvConfig } from '../config/load.js';
import { RECEIPTS_DIR, gatesConfigHash, stageGates } from './run.js';

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
}
/**
 * State of one required check at the commit:
 * - `passed`: its latest receipt on a clean tree with the current configuration succeeded;
 * - `failed`: that latest receipt did not succeed (a later failure always overrides an earlier success);
 * - `dirty`: receipts exist at this commit, but only with uncommitted changes (or an unknown tree state);
 * - `missing`: no receipt at this commit with the current configuration.
 */
export type EvidenceState = 'passed' | 'failed' | 'dirty' | 'missing';
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
  ok: boolean;
}

interface Found { receipt: GateReceipt; dirty: boolean | null; baseSha: string | null }

/** Every readable receipt of `.apv/receipts/`, with the tree state from the receipt or, for older ones, its run summary. */
function readReceipts(repo: string): { found: Found[]; unreadable: string[] } {
  const root = join(repo, RECEIPTS_DIR);
  const found: Found[] = [];
  const unreadable: string[] = [];
  if (!existsSync(root)) return { found, unreadable };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let summaryDirty: boolean | null = null;
    let baseSha: string | null = null;
    try {
      const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as { dirty?: unknown; baseSha?: unknown };
      if (typeof summary.dirty === 'boolean') summaryDirty = summary.dirty;
      if (typeof summary.baseSha === 'string' && /^[a-f0-9]{40,64}$/.test(summary.baseSha)) baseSha = summary.baseSha;
    } catch { /* No summary: the tree state comes from the receipts or stays unknown, the base stays unknown. */ }
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json') || file === 'summary.json') continue;
      try {
        const receipt = validateReceipt(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        found.push({ receipt, dirty: receipt.dirty ?? summaryDirty, baseSha });
      } catch { unreadable.push(join(RECEIPTS_DIR, entry.name, file)); }
    }
  }
  return { found, unreadable };
}

const latest = (a: Found, b: Found): Found =>
  b.receipt.startedAt > a.receipt.startedAt || (b.receipt.startedAt === a.receipt.startedAt && b.receipt.runId > a.receipt.runId) ? b : a;

/**
 * Whether the receipts prove that every required check passed on this exact commit, on a clean tree and with
 * the current configuration of the checks. Receipts of any run count (a task run proves its checks as well as a
 * full one), but for each check only the latest such receipt does: a failure is never hidden by an older success.
 * At stage full, receipts of a targeted run (`targeted`, the `affected` command of a full check) never count.
 * At stage task, a full check that declares `affected` is required too: its targeted receipts count when their
 * run's base covers `base` (mandatory then), and so do its complete receipts; the latest of them decides.
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
  const { found, unreadable } = readReceipts(repo);
  const atCommit = found.filter(f => f.receipt.candidateSha === commit);
  // Whether a targeted run from `runBase` covered the changes since `base`: same commit, or an ancestor of it.
  const covered = new Map<string, boolean>();
  const covers = async (runBase: string | null): Promise<boolean> => {
    if (!runBase || !base) return false;
    if (!covered.has(runBase)) covered.set(runBase, runBase === base || await git.contains(repo, base, runBase));
    return covered.get(runBase)!;
  };
  const gates: GateEvidence[] = [];
  for (const gateId of required) {
    const all = atCommit.filter(f => f.receipt.gateId === gateId);
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
      gates.push({ gateId, state, status: null, receipt: null, runId: null, otherConfig, targeted, viaTargeted: via, proof: null, otherBase });
      continue;
    }
    const last = clean.reduce(latest);
    gates.push({ gateId, state: success(last.receipt) ? 'passed' : 'failed', status: last.receipt.status, receipt: last.receipt.id,
      runId: last.receipt.runId, otherConfig, targeted, viaTargeted: via, proof: last.receipt.targeted === true ? 'targeted' : 'full', otherBase });
  }
  return { repo, commit, stage, base, configHash, required, targeted: [...viaTargeted], reserved: staged.reserved.map(g => g.id), gates, unreadable, ok: gates.every(g => g.state === 'passed') };
}
