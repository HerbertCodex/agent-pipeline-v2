import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigAtCommit } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';
import { gitRead } from '../run/git-probe.js';
import type { GhRunner } from '../stack/github.js';
import { checkRunsNamed } from './ci-proof.js';
import { anchorKey, sign, signatureValid } from './operator.js';
import { orderTrailer } from '../orders/order.js';

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
  /** A merge on order: the proof the rules took (docs/PREUVE-REDUITE.md, 5.8); absent for any other merge. */
  proof?: { mode: 'full' } | { mode: 'reduced'; checkRun: number; run: number; name: string };
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

/**
 * A commit on the audited branch that no signed trace accounts for. `order`: it carries the trailer of a merge on order
 * (`Apv-Order`, src/orders/merge.ts) whose merged head is its second parent. The trailer is not signed and the audit does
 * not match it with its signed order (keys at its first parent, comments of the pull request, digest of the order): it
 * stays unaccounted, said « pied Apv-Order non vérifié », never laundered by a well-formed trailer.
 */
export interface UnaccountedCommit {
  sha: string; date: string; subject: string; merge: boolean; order?: { nonce: string; step: string };
  /** A merge on order: the check runs read at its merged head (`readOrderProofs`, F6), informative only. */
  proofs?: string[];
}
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
  /** Why the check runs of the merges on order were not read (offline, remote outside github.com). */
  proofsNote?: string;
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
  const empty = { ref, head: head || null, since, sinceReason, commits: 0, traces: traces.length, unaccounted: [] };
  if (!head) return empty;
  const raw = gitRead(repo, ['log', '--first-parent', `--since=${since}`, '--format=%H%x00%P%x00%cI%x00%s%x00', head]);
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
  let commits = 0;
  // NUL separators only: a commit message can never contain one, so no subject can forge or hide a record.
  const fields = raw.split('\0');
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const sha = fields[index]!.trim();
    const [parents, date, subject] = [fields[index + 1]!, fields[index + 2]!, fields[index + 3]!];
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    commits += 1;
    const list = parents.split(' ').filter(Boolean);
    if (merged.has(sha) || (list.length > 1 && heads.has(list[1]!))) continue;
    const order = list.length === 2 ? orderOf(repo, sha, list[1]!) : null;
    unaccounted.push({ sha, date: date ?? '', subject: (subject ?? '').slice(0, 120), merge: list.length > 1, ...(order ? { order } : {}) });
  }
  return { ...empty, commits, unaccounted };
}

/** The trailer of a merge on order in the own message of `sha` whose merged head is `secondParent`, or null. */
function orderOf(repo: string, sha: string, secondParent: string): { nonce: string; step: string } | null {
  const trailer = orderTrailer(gitRead(repo, ['log', '-1', '--format=%B', sha]) ?? '');
  return trailer && trailer.head === secondParent ? { nonce: trailer.nonce, step: trailer.step } : null;
}

/**
 * For each merge on order no trace accounts for (a merge made in another environment, the cloud routine), the check
 * runs read at its merged head (second parent): the reduced proof and the proof by the CI its first parent declares
 * (docs/PREUVE-REDUITE.md 5.8, F6). Informative: the commit stays unaccounted, never laundered by a green check run.
 */
export async function readOrderProofs(repo: string, audit: MergeAudit, gh: GhRunner | null, repository: string | null): Promise<MergeAudit> {
  if (!audit.unaccounted.some(c => c.order)) return audit;
  if (!gh) return { ...audit, proofsNote: 'preuves CI non relues (hors réseau)' };
  if (!repository) return { ...audit, proofsNote: 'preuves CI non relues (dépôt distant hors de github.com)' };
  const unaccounted: UnaccountedCommit[] = [];
  for (const c of audit.unaccounted) {
    if (!c.order) { unaccounted.push(c); continue; }
    const [, first, second] = (gitRead(repo, ['rev-list', '--parents', '-n', '1', c.sha]) ?? '').trim().split(' ');
    if (!first || !second) { unaccounted.push({ ...c, proofs: ['parents illisibles : preuve non relue'] }); continue; }
    let names: string[];
    try {
      const rules = loadConfigAtCommit(repo, first).config.rules;
      names = [rules?.operatorOrders?.reducedProof?.name, rules?.ciProof?.name].filter((n): n is string => typeof n === 'string');
    } catch (error) { unaccounted.push({ ...c, proofs: [`configuration illisible au premier parent ${first.slice(0, 12)} : ${errorMessage(error).split('\n')[0]}`] }); continue; }
    if (!names.length) { unaccounted.push({ ...c, proofs: [`aucune preuve CI déclarée au premier parent ${first.slice(0, 12)}`] }); continue; }
    const proofs: string[] = [];
    for (const name of names) {
      const read = await checkRunsNamed(gh, repository, second, name);
      const said = !read.ok ? `illisible (${read.why})` : !read.runs.length ? 'aucun check run'
        : read.runs.slice(0, 3).map(r => `check run ${r.id} ${r.status === 'completed' ? r.conclusion ?? 'sans conclusion' : r.status} (${r.app ?? 'application inconnue'})`).join(', ');
      proofs.push(`preuve lue sur GitHub à la tête fusionnée ${second.slice(0, 12)} : « ${name} » : ${said}`);
    }
    unaccounted.push({ ...c, proofs });
  }
  return { ...audit, unaccounted };
}

/** Lines of an audit, for `apv status`, `apv audit merges` and the head of the report of `apv stack merge`. */
export function auditLines(audit: MergeAudit): string[] {
  if (!audit.head) return [`Audit des fusions : ${audit.ref} introuvable (git fetch), rien n'est vérifié.`];
  const head = `Audit des fusions sur ${audit.ref} depuis ${audit.since.slice(0, 10)} (${audit.sinceReason}) : ${audit.commits} commit(s), ${audit.traces} fusion(s) enregistrée(s) par apv`;
  if (!audit.unaccounted.length) return [`${head}, aucun commit hors de apv stack merge.`];
  return [`${head}. ATTENTION : ${audit.unaccounted.length} commit(s) arrivé(s) sans apv stack merge (fusion à la main ou poussée directe : les règles n'ont pas été vérifiées) :`,
    ...audit.unaccounted.slice(0, 20).flatMap(c => [`  ${c.sha.slice(0, 12)} ${c.date.slice(0, 10)} ${c.merge ? 'fusion' : 'commit'} : ${c.subject}`
      + (c.order ? ` (pied Apv-Order non vérifié : ordre ${c.order.nonce}, étape ${c.order.step} ; à rapprocher de l'ordre signé de la PR)` : ''),
      ...(c.proofs ?? []).map(p => `    ${p}`)]),
    ...(audit.proofsNote ? [`  Fusions sur ordre : ${audit.proofsNote}.`] : []),
    ...(audit.unaccounted.length > 20 ? [`  et ${audit.unaccounted.length - 20} autre(s) (apv audit merges --json)`] : []),
    '  À examiner avec l\'opérateur ; si c\'est lui qui a fusionné sur GitHub, le noter au journal du pipeline.'];
}
