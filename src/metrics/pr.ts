import { median } from './run.js';

/**
 * Time measure of one pull request (docs/SHIFT-LEFT.md, section 11): opened, ready, first merge attempt, merged, with
 * the reviews recorded and the full suites run on its commits. From `gh pr view`, `.apv/state/stack.log`, the signed
 * merge traces, the review records and the receipt store; nothing typed by hand. Pure.
 */

export interface PrCommit { oid: string; committedDate: string }
export interface PrData {
  number: number; title: string; url: string; state: string; headRefName: string; baseRefName: string;
  createdAt: string; mergedAt: string | null; additions: number; deletions: number; changedFiles: number;
  commits: PrCommit[];
}
/** A line of `.apv/state/stack.log` that names the pull request (`pr`, or in `prs`). */
export interface StackEvent {
  at: string; event: string; pr: number | null; prs: number[];
  /** Lot branch and commit that carried the pull request (`batch-merge`): the suite of the lot proved the merge. */
  lot: string | null; lotCommit: string | null;
}
export interface ReviewSeen { commit: string; domain: string; at: string; sealed: boolean }
export interface SuiteSeen { runId: string; candidateSha: string; stage: string | null; full: boolean; ok: boolean | null; startedAt: string; endedAt: string | null }

export type PrKind = 'spec' | 'minime';

export interface PrMetrics {
  number: number; title: string; url: string; state: string; headRefName: string;
  /** `spec` when its head is the branch of a spec execution, `minime` otherwise (configuration, registre, maquette, docs). */
  kind: PrKind; spec: string | null;
  size: { files: number; additions: number; deletions: number; commits: number };
  createdAt: string; mergedAt: string | null;
  /** Ready: its content final, the latest of its opening and of its last commit. */
  readyAt: string;
  /** First run of `apv stack merge` or `apv stack batch` that named it (the merge was asked), from stack.log; null when absent. */
  firstMergeAttemptAt: string | null;
  openToMergeMs: number | null;
  /** Ready to merged: the target of section 11 (30 min for the lane without code, 40 for the settings lane). */
  readyToMergeMs: number | null;
  /** Ready to the first merge attempt: waiting for the operator's order. Null without an attempt in stack.log. */
  orderWaitMs: number | null;
  /** First merge attempt to merged: the batch, its suite, a stop and a new attempt. */
  mergeMs: number | null;
  batchStops: number;
  reviews: { count: number; sealed: number; domains: string[]; firstAt: string | null; lastAt: string | null };
  suites: { full: number; fullMs: number; fullFailed: number; task: number } | null;
}

const ms = (iso: string): number => Date.parse(iso);
const span = (from: string, to: string): number => Math.max(0, ms(to) - ms(from));
const sortIso = (values: readonly string[]): string[] => [...values].sort((a, b) => ms(a) - ms(b));

export function measurePr(input: { pr: PrData; spec: string | null; stack: readonly StackEvent[]; reviews: readonly ReviewSeen[] | null; suites: readonly SuiteSeen[] | null }): PrMetrics {
  const { pr } = input;
  const lastCommit = sortIso(pr.commits.map(c => c.committedDate).filter(d => !Number.isNaN(ms(d)))).at(-1) ?? null;
  const readyAt = lastCommit && ms(lastCommit) > ms(pr.createdAt) ? lastCommit : pr.createdAt;
  const mine = input.stack.filter(e => e.pr === pr.number || e.prs.includes(pr.number));
  // Attempts after the merge (a lot replayed) say nothing of this pull request.
  const before = mine.filter(e => !pr.mergedAt || ms(e.at) <= ms(pr.mergedAt) + 60_000);
  const firstMergeAttemptAt = sortIso(before.map(e => e.at))[0] ?? null;
  const reviewTimes = sortIso((input.reviews ?? []).map(r => r.at));
  const suites = input.suites ? {
    full: input.suites.filter(s => s.full).length,
    fullMs: input.suites.filter(s => s.full && s.endedAt).reduce((t, s) => t + span(s.startedAt, s.endedAt!), 0),
    fullFailed: input.suites.filter(s => s.full && s.ok === false).length,
    task: input.suites.filter(s => !s.full).length,
  } : null;
  return {
    number: pr.number, title: pr.title, url: pr.url, state: pr.state, headRefName: pr.headRefName,
    kind: input.spec ? 'spec' : 'minime', spec: input.spec,
    size: { files: pr.changedFiles, additions: pr.additions, deletions: pr.deletions, commits: pr.commits.length },
    createdAt: pr.createdAt, mergedAt: pr.mergedAt, readyAt, firstMergeAttemptAt,
    openToMergeMs: pr.mergedAt ? span(pr.createdAt, pr.mergedAt) : null,
    readyToMergeMs: pr.mergedAt ? span(readyAt, pr.mergedAt) : null,
    orderWaitMs: firstMergeAttemptAt ? (ms(firstMergeAttemptAt) > ms(readyAt) ? span(readyAt, firstMergeAttemptAt) : 0) : null,
    mergeMs: firstMergeAttemptAt && pr.mergedAt ? span(firstMergeAttemptAt, pr.mergedAt) : null,
    batchStops: before.filter(e => e.event === 'batch-stop').length,
    reviews: { count: input.reviews?.length ?? 0, sealed: (input.reviews ?? []).filter(r => r.sealed).length,
      domains: [...new Set((input.reviews ?? []).map(r => r.domain))].sort(), firstAt: reviewTimes[0] ?? null, lastAt: reviewTimes.at(-1) ?? null },
    suites,
  };
}

/**
 * Commits of the lots that merged pull request `n` (stack.log, `batch-merge`): every commit of such a lot, since its
 * suite runs once at the top of the lot and proves each pull request it carries.
 */
export function lotCommits(stack: readonly StackEvent[], n: number): string[] {
  const lots = new Set(stack.filter(e => e.event === 'batch-merge' && e.pr === n && e.lot).map(e => e.lot!));
  return [...new Set(stack.filter(e => e.event === 'batch-merge' && e.lotCommit && (e.pr === n || (e.lot !== null && lots.has(e.lot)))).map(e => e.lotCommit!))];
}

/** Number of past minimal pull requests of the comparison base (section 11: « les cinq dernières PR minimes »). */
export const BASELINE_PRS = 5;

export interface PrBaseline {
  prs: number[];
  readyToMergeMs: number | null; openToMergeMs: number | null; orderWaitMs: number | null; mergeMs: number | null;
}

/** Median of the last BASELINE_PRS merged minimal pull requests (by merge date). */
export function prBaseline(all: readonly PrMetrics[], count = BASELINE_PRS): PrBaseline {
  const picked = all.filter(p => p.kind === 'minime' && p.mergedAt).sort((a, b) => ms(b.mergedAt!) - ms(a.mergedAt!)).slice(0, count);
  const values = (f: (p: PrMetrics) => number | null): number[] => picked.map(f).filter((v): v is number => v !== null);
  return { prs: picked.map(p => p.number), readyToMergeMs: median(values(p => p.readyToMergeMs)), openToMergeMs: median(values(p => p.openToMergeMs)),
    orderWaitMs: median(values(p => p.orderWaitMs)), mergeMs: median(values(p => p.mergeMs)) };
}

/** Reads one `gh pr view --json` answer; null when it is not a pull request. */
export function parsePrData(text: string): PrData | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string => typeof v === 'string' ? v : '';
  const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
  if (typeof r['number'] !== 'number' || Number.isNaN(Date.parse(str(r['createdAt'])))) return null;
  const merged = str(r['mergedAt']);
  const commits = Array.isArray(r['commits']) ? r['commits'].flatMap(c => {
    const o = (c ?? {}) as Record<string, unknown>;
    return typeof o['oid'] === 'string' && /^[a-f0-9]{40,64}$/.test(o['oid']) ? [{ oid: o['oid'], committedDate: str(o['committedDate']) }] : [];
  }) : [];
  return { number: r['number'], title: str(r['title']), url: str(r['url']), state: str(r['state']), headRefName: str(r['headRefName']), baseRefName: str(r['baseRefName']),
    createdAt: str(r['createdAt']), mergedAt: merged && !Number.isNaN(Date.parse(merged)) ? merged : null,
    additions: num(r['additions']), deletions: num(r['deletions']), changedFiles: num(r['changedFiles']), commits };
}

/** Reads the lines of `.apv/state/stack.log` that name pull requests; unreadable lines are left out. */
export function parseStackLog(text: string): StackEvent[] {
  const out: StackEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      if (typeof v['at'] !== 'string' || Number.isNaN(Date.parse(v['at'])) || typeof v['event'] !== 'string') continue;
      const prs = Array.isArray(v['prs']) ? v['prs'].filter((n): n is number => Number.isInteger(n)) : Array.isArray(v['stack']) ? v['stack'].filter((n): n is number => Number.isInteger(n)) : [];
      const lot = typeof v['lotCommit'] === 'string' && /^[a-f0-9]{40,64}$/.test(v['lotCommit']) ? v['lotCommit'] : null;
      out.push({ at: v['at'], event: v['event'], pr: Number.isInteger(v['pr']) ? v['pr'] as number : null, prs, lot: typeof v['lot'] === 'string' ? v['lot'] : null, lotCommit: lot });
    } catch { /* not a line of the tool */ }
  }
  return out;
}
