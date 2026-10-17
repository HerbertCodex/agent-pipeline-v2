import { ALWAYS_REVIEWED, type ReviewDomainName } from '../review/config.js';
import { carriedHeads, chainSpans, deltaFiles, isAncestor, prChain, type ChainLink, type ChainNode } from './carry.js';
import { latestReviews, type ReadRecord } from './reviews.js';

/**
 * Reviews carried over a delta that leaves their perimeter, and reviews of the delta (docs/ACCELERATION-LOTS.md, part B).
 *
 * A review recorded at C, a commit of the pull request below the head C', counts at C' for a domain other than securite
 * when every step of the change from C to C' (each first-parent link, and each run of links as one change) is outside
 * the perimeter of the domain: the plan of the reviews (planReviews, settings read at the base of the pull request)
 * does not retain the domain for it, and, for fidelite, it touches no screen (touchesNoScreen). The chain is walked from
 * the head, nearest first, MAX_REPORT_WALK commits at most (carry.ts); a blocking review (a critical or high finding) of
 * the domain at any commit of the walk blocks, and the first step that touches the perimeter breaks the report: a new
 * review is asked for, of the whole change or of the delta.
 *
 * securite is never carried that way: a review of the delta (`apv review record --delta-from C`) is recorded at C' by
 * its reviewer, and counts when C is an ancestor of C' on the branch, the files it recorded are the diff C..C'
 * recomputed, and the review it starts from is usable at C (itself a review of a delta, MAX_DELTA_CHAIN in a row at
 * most). Every domain has the same review of the delta, for a delta that touches its perimeter.
 *
 * The review of the head always decides; this only applies when the head has none of the domain.
 */

/** Reviews of the delta in a row, each starting from the one before, until a review of the whole change. */
export const MAX_DELTA_CHAIN = 5;
/** Causes shown when a step of the chain touches the perimeter. */
const MAX_REASONS = 5;

const short = (sha: string): string => sha.slice(0, 12);

export interface DeltaContext {
  repo: string;
  common: string;
  /** The target, resolved; null: nothing is carried. */
  target: string | null;
  /** Why the change of a span touches the perimeter of the domain, one line per cause; empty when it touches nothing. */
  touches(domain: ReviewDomainName, span: ChainLink): string[];
  /** The anchor key the seals of the reviews are checked with (tests); the key of the machine by default. */
  key?: Buffer | null;
}

/** What counts for one domain at a commit. */
export interface Picked {
  found: ReadRecord | undefined;
  /** The commit whose review counts, when not the commit itself. */
  from: string | null;
  /** `own`: recorded at the commit; `carried`: over merges of the target (carry.ts); `reported`: over a delta outside its perimeter. */
  how: 'own' | 'carried' | 'reported' | null;
  /** A review of the delta, verified: its starting commit and how many files it read. */
  delta?: { from: string; files: number };
  /** A reported review: the files of the delta, none in the perimeter of the domain. */
  reported?: { files: string[] };
  /** The nearest review the chain had, not reported because a step touches the perimeter: its commit and the causes. */
  broken?: { from: string; reasons: string[] };
}

export const usableReview = (r: ReadRecord | undefined): boolean => !!r && !r.problem && !!r.record && r.record.findings.critical === 0 && r.record.findings.high === 0;
export const blockingReview = (r: ReadRecord | undefined): boolean => !!r?.record && (r.record.findings.critical > 0 || r.record.findings.high > 0);

export interface ReviewChain {
  /** The review of the domain at `commit`: its own, or carried over merges of the target; a review of the delta verified. */
  resolve(commit: string, domain: ReviewDomainName): Picked;
  /** A review of an earlier commit of the branch carried to the head over a delta outside the perimeter; never securite. */
  reported(domain: ReviewDomainName): Picked | null;
  /** The nearest commit of the branch below the head with a usable review of the domain: where a review of the delta starts. */
  deltaStart(domain: ReviewDomainName): string | null;
  /** The commits of the branch walked from the head (carry.ts, prChain). */
  chain(): ChainNode[];
}

export function reviewChain(ctx: DeltaContext, head: string): ReviewChain {
  const records = new Map<string, Map<ReviewDomainName, ReadRecord>>();
  const at = (commit: string): Map<ReviewDomainName, ReadRecord> => {
    let found = records.get(commit);
    if (!found) { found = ctx.key === undefined ? latestReviews(ctx.common, commit) : latestReviews(ctx.common, commit, ctx.key); records.set(commit, found); }
    return found;
  };
  let nodes: ChainNode[] | null = null;
  const chain = (): ChainNode[] => (nodes ??= prChain(ctx.repo, head, ctx.target));
  const touched = new Map<string, string[]>();

  const resolve = (commit: string, domain: ReviewDomainName, depth: number): Picked => {
    const own = at(commit).get(domain);
    let picked: Picked = { found: own, from: null, how: own ? 'own' : null };
    if (!own) {
      // The review of the commit decides; over merges of the target, a blocking review anywhere blocks (carry.ts).
      const carried = carriedHeads(ctx.repo, commit, ctx.target).map(h => ({ head: h, r: at(h).get(domain) })).filter(x => x.r);
      const stop = carried.find(x => blockingReview(x.r)) ?? carried.find(x => usableReview(x.r));
      if (stop) picked = { found: stop.r, from: stop.head, how: 'carried' };
    }
    const delta = picked.found?.record?.delta;
    if (!delta || !usableReview(picked.found)) return picked;
    const problem = verifyDelta(picked.found!, domain, depth);
    if (problem) return { ...picked, found: { ...picked.found!, problem: `relecture de delta non prouvante : ${problem}` } };
    return { ...picked, delta: { from: delta.from, files: delta.files.length } };
  };

  const verifyDelta = (read: ReadRecord, domain: ReviewDomainName, depth: number): string | null => {
    const record = read.record!;
    const delta = record.delta!;
    if (depth + 1 > MAX_DELTA_CHAIN) return `plus de ${MAX_DELTA_CHAIN} relectures de delta à la suite : une relecture complète est demandée`;
    if (delta.from === record.commit || !isAncestor(ctx.repo, delta.from, record.commit)) return `${short(delta.from)} n'est pas un ancêtre de ${short(record.commit)} (un rebase ne reporte rien)`;
    if (ctx.target && isAncestor(ctx.repo, delta.from, ctx.target)) return `${short(delta.from)} est un commit de la cible, pas de la branche`;
    const span = deltaFiles(ctx.repo, delta.from, record.commit);
    if (span.problem !== null) return span.problem;
    const recomputed = [...span.files].sort();
    const recorded = [...delta.files].sort();
    if (recomputed.length !== recorded.length || recomputed.some((f, k) => f !== recorded[k])) {
      return `fichiers enregistrés (${recorded.length}) différents du delta recalculé ${short(delta.from)}..${short(record.commit)} (${recomputed.length})`;
    }
    const start = resolve(delta.from, domain, depth + 1);
    const where = short(start.from ?? delta.from);
    if (!start.found) return `aucune relecture ${domain} à ${short(delta.from)}, départ du delta`;
    if (blockingReview(start.found)) return `relecture ${domain} de départ à ${where} : ${start.found.record!.findings.critical} constat(s) critique(s) et ${start.found.record!.findings.high} haut(s)`;
    if (!usableReview(start.found)) return `relecture ${domain} de départ inutilisable à ${where} (${start.found.problem ?? 'illisible'})`;
    return null;
  };

  /**
   * Why the steps from the node to the head touch the perimeter: each run of links, then each link; empty when none. A
   * step whose delta cannot be read as a list of files (a submodule link, trees that differ with no file listed) touches
   * every perimeter (deltaFiles, security review of #141, A1).
   */
  const reasonsFor = (domain: ReviewDomainName, node: ChainNode): string[] => {
    for (const span of [...chainSpans(node.links), ...node.links]) {
      const key = `${domain}|${span.from}..${span.to}`;
      let why = touched.get(key);
      if (!why) {
        const read = deltaFiles(ctx.repo, span.from, span.to);
        why = read.problem !== null ? [read.problem] : ctx.touches(domain, span);
        touched.set(key, why);
      }
      if (why.length) return why.slice(0, MAX_REASONS).map(w => `${short(span.from)}..${short(span.to)} : ${w}`);
    }
    return [];
  };

  const reported = (domain: ReviewDomainName): Picked | null => {
    if (domain === ALWAYS_REVIEWED) return null;
    for (const node of chain()) {
      const picked = resolve(node.commit, domain, 0);
      if (!picked.found) continue;
      const from = picked.from ?? node.commit;
      if (blockingReview(picked.found)) return { found: picked.found, from, how: 'reported' };
      if (!usableReview(picked.found)) continue;
      const reasons = reasonsFor(domain, node);
      if (reasons.length) return { found: undefined, from: null, how: null, broken: { from, reasons } };
      const files = [...new Set(chainSpans(node.links).flatMap(s => deltaFiles(ctx.repo, s.from, s.to).files ?? []))].sort();
      return { ...picked, from, how: 'reported', reported: { files } };
    }
    return null;
  };

  const deltaStart = (domain: ReviewDomainName): string | null => {
    for (const node of chain()) {
      const picked = resolve(node.commit, domain, 0);
      if (blockingReview(picked.found)) return null;
      if (usableReview(picked.found)) return node.commit;
    }
    return null;
  };

  return { resolve: (commit, domain) => resolve(commit, domain, 0), reported, deltaStart, chain };
}
