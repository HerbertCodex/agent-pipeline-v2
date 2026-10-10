import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRead } from '../run/git-probe.js';
import { anchorKey, sign, signatureValid } from './operator.js';

/**
 * Merge traces: `apv stack merge` and `apv stack batch --merge` write one per merge, signed with the anchor key kept
 * outside the repository, in `<git common dir>/apv/merges/`. `apv audit merges` walks the default branch and names every
 * commit no trace accounts for: a merge or a push that did not go through the tool (and so skipped its rules). It is the
 * check after the fact that makes up for a branch protection GitHub does not offer (a private repository on the free plan).
 */
export const MERGES_DIR = ['apv', 'merges'] as const;

export interface MergeTraceBody {
  v: 1; pr: number; head: string; target: string; method: string; mergeCommit: string | null; at: string;
  /** A rebase merge: the number of commits it landed, `mergeCommit` the last one (absent: one commit). */
  commits?: number;
}
export interface MergeTrace extends MergeTraceBody { sig: string }

export function writeMergeTrace(common: string, body: Omit<MergeTraceBody, 'v'>, key: Buffer): string {
  const dir = join(common, ...MERGES_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const full: MergeTraceBody = { v: 1, ...body };
  const file = join(dir, `${body.pr}-${body.head.slice(0, 12)}-${Date.parse(body.at)}.json`);
  writeFileSync(file, `${JSON.stringify({ ...full, sig: sign(key, 'merge', JSON.stringify(full)) }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** The signed traces; unsigned, altered or unreadable files are ignored. */
export function readMergeTraces(common: string, key = anchorKey(common).key): MergeTrace[] {
  if (!key) return [];
  let names: string[];
  try { names = readdirSync(join(common, ...MERGES_DIR)).filter(n => n.endsWith('.json')); } catch { return []; }
  const out: MergeTrace[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(readFileSync(join(common, ...MERGES_DIR, name), 'utf8')) as MergeTrace;
      const { sig, ...body } = value;
      if (value.v === 1 && typeof value.head === 'string' && signatureValid(key, 'merge', JSON.stringify(body), sig)) out.push(value);
    } catch { /* ignored */ }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export interface UnaccountedCommit { sha: string; date: string; subject: string; merge: boolean }
/**
 * A merge commit made by `apv stack merge --order` (src/orders/merge.ts), possibly on another machine (the cloud routine):
 * recognised by its trailer, whose merged head is its second parent. A structural check only: the trailer is not signed,
 * so each one is listed with its order reference, to be matched with the signed order of its pull request.
 */
export interface OrderMerge { sha: string; date: string; nonce: string; step: string; head: string }
export interface MergeAudit {
  /** The branch audited (`origin/main`), and the commit it pointed to; null when it does not resolve. */
  ref: string;
  head: string | null;
  since: string;
  /** Why the audit starts there: the first trace, the option, or the default window. */
  sinceReason: string;
  commits: number;
  traces: number;
  unaccounted: UnaccountedCommit[];
  orderMerges: OrderMerge[];
}

/** Default window when no trace exists yet: 30 days. */
export const DEFAULT_AUDIT_DAYS = 30;

/**
 * Walks the first-parent history of `ref` since `since` (default: the first trace, else 30 days) and lists the commits
 * no signed trace accounts for: a merge commit is accounted for by the trace of its merge commit or of the head it
 * merged (second parent); a squash by the trace of its merge commit; a rebase by the trace of its last commit, which
 * also accounts for the commits before it that the same merge landed (`commits`).
 */
export function auditMerges(repo: string, common: string, ref: string, options: { since?: string; now?: Date } = {}): MergeAudit {
  const traces = readMergeTraces(common);
  const now = options.now ?? new Date();
  const since = options.since ?? traces[0]?.at ?? new Date(now.getTime() - DEFAULT_AUDIT_DAYS * 86_400_000).toISOString();
  const sinceReason = options.since ? 'date demandée' : traces.length ? 'première fusion enregistrée par apv stack merge' : `aucune fusion enregistrée : ${DEFAULT_AUDIT_DAYS} derniers jours`;
  const head = gitRead(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const empty = { ref, head: head || null, since, sinceReason, commits: 0, traces: traces.length, unaccounted: [], orderMerges: [] };
  if (!head) return empty;
  const raw = gitRead(repo, ['log', '--first-parent', `--since=${since}`, '--format=%H%x1f%P%x1f%cI%x1f%s%x1f%(trailers:key=Apv-Order,key=Apv-Order-Step,key=Apv-Merged-Head,unfold)%x1e', head]);
  if (!raw) return empty;
  const merged = new Set(traces.map(t => t.mergeCommit).filter((x): x is string => typeof x === 'string'));
  // A rebase merge landed `commits` commits, the last one being its merge commit: the ones before it on the first parent
  // are accounted for by the same signed trace (never more than it says).
  for (const t of traces) {
    if (!t.mergeCommit || !Number.isInteger(t.commits) || (t.commits ?? 1) <= 1 || (t.commits ?? 1) > 1000) continue;
    const landed = gitRead(repo, ['rev-list', '--first-parent', `--max-count=${t.commits}`, t.mergeCommit]);
    for (const sha of (landed ?? '').split('\n').map(x => x.trim()).filter(Boolean)) merged.add(sha);
  }
  const heads = new Set(traces.map(t => t.head));
  const unaccounted: UnaccountedCommit[] = [];
  const orderMerges: OrderMerge[] = [];
  let commits = 0;
  for (const record of raw.split('\x1e').map(r => r.trim()).filter(Boolean)) {
    const [sha, parents, date, subject, trailers] = record.split('\x1f');
    if (!sha) continue;
    commits += 1;
    const list = (parents ?? '').split(' ').filter(Boolean);
    if (merged.has(sha) || (list.length > 1 && heads.has(list[1]!))) continue;
    const order = list.length === 2 ? orderTrailer(trailers ?? '', list[1]!) : null;
    if (order) { orderMerges.push({ sha, date: date ?? '', ...order }); continue; }
    unaccounted.push({ sha, date: date ?? '', subject: (subject ?? '').slice(0, 120), merge: list.length > 1 });
  }
  return { ...empty, commits, unaccounted, orderMerges };
}

/** The trailer of a merge on order whose merged head is `secondParent`, or null. */
function orderTrailer(trailers: string, secondParent: string): { nonce: string; step: string; head: string } | null {
  const nonce = /^Apv-Order: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/m.exec(trailers)?.[1];
  const step = /^Apv-Order-Step: (publication|article)$/m.exec(trailers)?.[1];
  const head = /^Apv-Merged-Head: ([0-9a-f]{40})$/m.exec(trailers)?.[1];
  return nonce && step && head === secondParent ? { nonce, step, head } : null;
}

/** Lines of an audit, for `apv status`, `apv audit merges` and the head of the report of `apv stack merge`. */
export function auditLines(audit: MergeAudit): string[] {
  if (!audit.head) return [`Audit des fusions : ${audit.ref} introuvable (git fetch), rien n'est vérifié.`];
  const head = `Audit des fusions sur ${audit.ref} depuis ${audit.since.slice(0, 10)} (${audit.sinceReason}) : ${audit.commits} commit(s), ${audit.traces} fusion(s) enregistrée(s) par apv`;
  const orders = audit.orderMerges.length ? [`  ${audit.orderMerges.length} fusion(s) sur ordre signé (pied Apv-Order, contrôle de forme seulement : rapprocher chaque référence de son ordre signé sur la PR) :`,
    ...audit.orderMerges.slice(0, 20).map(o => `  ${o.sha.slice(0, 12)} ${o.date.slice(0, 10)} ordre ${o.nonce}, étape ${o.step}, tête ${o.head.slice(0, 12)}`)] : [];
  if (!audit.unaccounted.length) return [`${head}, aucun commit hors de apv stack merge.`, ...orders];
  return [`${head}. ATTENTION : ${audit.unaccounted.length} commit(s) arrivé(s) sans apv stack merge (fusion à la main ou poussée directe : les règles n'ont pas été vérifiées) :`,
    ...audit.unaccounted.slice(0, 20).map(c => `  ${c.sha.slice(0, 12)} ${c.date.slice(0, 10)} ${c.merge ? 'fusion' : 'commit'} : ${c.subject}`),
    ...(audit.unaccounted.length > 20 ? [`  et ${audit.unaccounted.length - 20} autre(s) (apv audit merges --json)`] : []),
    '  À examiner avec l\'opérateur ; si c\'est lui qui a fusionné sur GitHub, le noter au journal du pipeline.', ...orders];
}
