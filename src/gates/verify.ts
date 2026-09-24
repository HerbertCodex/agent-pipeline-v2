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
  /** `full` (default): every declared check is required. `task`: the checks of stage task only. */
  stage?: GateStage;
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
  /** Receipts at this commit of the targeted variant (`affected`) of the check: never proof of it (ignored). */
  targeted: number;
}
export interface VerifyResult {
  repo: string;
  commit: string;
  stage: GateStage;
  configHash: string;
  required: string[];
  gates: GateEvidence[];
  /** Receipt files that could not be read or validated (ignored, reported). */
  unreadable: string[];
  ok: boolean;
}

interface Found { receipt: GateReceipt; dirty: boolean | null }

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
    try {
      const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as { dirty?: unknown };
      if (typeof summary.dirty === 'boolean') summaryDirty = summary.dirty;
    } catch { /* No summary: the tree state comes from the receipts or stays unknown. */ }
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json') || file === 'summary.json') continue;
      try {
        const receipt = validateReceipt(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        found.push({ receipt, dirty: receipt.dirty ?? summaryDirty });
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
 * Receipts of a targeted run (`targeted`, the `affected` command of a full check) never count.
 */
export async function verifyGates(options: VerifyOptions): Promise<VerifyResult> {
  const git = new Git();
  const repo = await git.root(options.repo);
  const commit = await git.sha(repo, options.commit);
  const stage = options.stage ?? 'full';
  invariant(options.config.gates.length > 0, 'NO_GATES', 'No checks configured; declare gates in .apv/config.json');
  const required = stageGates(options.config.gates, stage).run.map(g => g.id);
  invariant(required.length > 0, 'NO_GATES', `No check of stage ${stage} is configured: nothing to verify`);
  const configHash = gatesConfigHash(options.config);
  const { found, unreadable } = readReceipts(repo);
  const atCommit = found.filter(f => f.receipt.candidateSha === commit);
  const gates = required.map((gateId): GateEvidence => {
    const all = atCommit.filter(f => f.receipt.gateId === gateId);
    // A targeted run only covered the tests concerned by some changes: it proves nothing about the whole check.
    const mine = all.filter(f => f.receipt.targeted !== true);
    const targeted = all.length - mine.length;
    const current = mine.filter(f => f.receipt.configHash === configHash);
    const otherConfig = mine.length - current.length;
    const clean = current.filter(f => f.dirty === false);
    if (!clean.length) {
      const state: EvidenceState = current.length ? 'dirty' : 'missing';
      return { gateId, state, status: null, receipt: null, runId: null, otherConfig, targeted };
    }
    const last = clean.reduce(latest);
    return { gateId, state: success(last.receipt) ? 'passed' : 'failed', status: last.receipt.status, receipt: last.receipt.id,
      runId: last.receipt.runId, otherConfig, targeted };
  });
  return { repo, commit, stage, configHash, required, gates, unreadable, ok: gates.every(g => g.state === 'passed') };
}
