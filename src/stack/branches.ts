import { errorMessage } from '../domain/errors.js';
import { hostname, pullRequestPath, refSegment, type GhCall, type GhRunner, type MergedHead, type PullRequestPath } from './github.js';

/**
 * Deletion of the head branches of the pull requests `apv stack merge` and `apv stack batch --merge` merged (pilot
 * project, 1 October 2026: 54 merged branches had piled up on a repository without GitHub's « delete branch after merge »).
 * After the merges, each branch is deleted through the REST API, never through a shell, unless a rule keeps it:
 * `--keep-branches`; a pull request from a fork (or whose origin GitHub did not give); the target or the default branch
 * of the repository; a protected branch; a branch that is the base or the head of a pull request still open (read from
 * the API: in a stack, the next pull request was retargeted before); a branch whose head is no longer the commit that was
 * merged. A branch already gone (GitHub deleted it, `delete_branch_on_merge`) is noted, without error. A failure never
 * undoes nor fails the merge: it is reported as a warning.
 */

export type BranchStatus = 'deleted' | 'kept' | 'absent' | 'failed';
export interface BranchOutcome {
  pr: number; branch: string;
  /** The head the merge carried: the commit the branch pointed to, to recreate it if needed. */
  head: string;
  status: BranchStatus;
  reason: string;
}

/** What the cleanup read of a repository: its default branch and whether GitHub deletes merged branches itself. */
export interface RepositorySettings {
  host: string;
  /** `<owner>/<name>`. */
  repo: string;
  defaultBranch: string | null;
  /** Null when the answer does not carry it (read without the rights to see the merge settings). */
  deleteBranchOnMerge: boolean | null;
  error: string | null;
}

export interface BranchCleanup { branches: BranchOutcome[]; repositories: RepositorySettings[] }

export const REPOSITORY_JQ = '{default_branch, delete_branch_on_merge}';
const BRANCH_JQ = '{sha: .commit.sha, protected}';

type Where = Pick<PullRequestPath, 'host' | 'repo'>;

/** `gh api repos/<owner>/<repo> --jq …`: the default branch and `delete_branch_on_merge`. */
export function repositoryArgs(where: Where): string[] {
  return ['api', ...hostname(where), where.repo, '--jq', REPOSITORY_JQ];
}

/** `gh api repos/<owner>/<repo>/branches/<branch> --jq …`: the head of the branch and whether it is protected. */
export function branchArgs(where: Where, branch: string): string[] {
  return ['api', ...hostname(where), `${where.repo}/branches/${refSegment(branch)}`, '--jq', BRANCH_JQ];
}

/** `gh api -X GET repos/<owner>/<repo>/pulls -f state=open -f <field>=<value>`: the open pull requests with this base or head. */
export function openPullsArgs(where: Where, field: 'base' | 'head', value: string): string[] {
  return ['api', ...hostname(where), '-X', 'GET', `${where.repo}/pulls`, '-f', 'state=open', '-f', `${field}=${value}`, '-f', 'per_page=100', '--jq', '[.[].number]'];
}

/** `gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>`. */
export function deleteBranchArgs(where: Where, branch: string): string[] {
  return ['api', ...hostname(where), '-X', 'DELETE', `${where.repo}/git/refs/heads/${refSegment(branch)}`];
}

/** The command that makes GitHub delete the head branch of each merged pull request itself. Given, never run. */
export function deleteOnMergeCommand(where: Where): string {
  return ['gh', 'api', ...hostname(where), '-X', 'PATCH', where.repo, '-F', 'delete_branch_on_merge=true'].join(' ');
}

const failed = (call: GhCall): boolean => call.status !== 0 || call.error !== null;
const notFound = (call: GhCall): boolean => failed(call) && /\(HTTP 404\)/.test(`${call.stderr}\n${call.stdout}`);
const outcome = (call: GhCall): string => call.error ?? `code ${call.status}`;
const short = (sha: string): string => sha.slice(0, 12);

/** Reads the answer of `repositoryArgs`. */
export function parseRepositorySettings(text: string): { defaultBranch: string | null; deleteBranchOnMerge: boolean | null } {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') throw new Error('réponse illisible');
  const defaultBranch = typeof raw['default_branch'] === 'string' && raw['default_branch'] ? raw['default_branch'] : null;
  return { defaultBranch, deleteBranchOnMerge: typeof raw['delete_branch_on_merge'] === 'boolean' ? raw['delete_branch_on_merge'] : null };
}

export interface CleanupOptions {
  /** One `gh` call, shown and recorded by the caller like every other call of the command. */
  run: (args: string[]) => Promise<GhCall>;
  /** The branch the pull requests landed on: never deleted. */
  target: string | null;
  /** Why every branch is kept (`--keep-branches`, an interrupted batch): nothing is deleted, nothing is called. Null otherwise. */
  keep: string | null;
}

type BranchRead = { state: 'absent' } | { state: 'present'; sha: string; protected: boolean | null } | { state: 'error'; error: string };

/** Deletes the head branch of each merged pull request, in order, under the rules above; one outcome per branch. */
export async function cleanMergedBranches(merged: MergedHead[], options: CleanupOptions): Promise<BranchCleanup> {
  const cleanup: BranchCleanup = { branches: [], repositories: [] };
  const settings = new Map<string, RepositorySettings>();
  const repository = async (where: Where): Promise<RepositorySettings> => {
    const key = `${where.host}/${where.repo}`;
    const known = settings.get(key);
    if (known) return known;
    const call = await options.run(repositoryArgs(where));
    const read: RepositorySettings = { host: where.host, repo: where.repo.replace(/^repos\//, ''), defaultBranch: null, deleteBranchOnMerge: null, error: null };
    if (failed(call)) read.error = `gh api ${where.repo} : ${outcome(call)}`;
    else {
      try { Object.assign(read, parseRepositorySettings(call.stdout)); }
      catch (error) { read.error = `réponse illisible de gh api ${where.repo} : ${errorMessage(error)}`; }
      if (!read.error && !read.defaultBranch) read.error = 'branche par défaut absente de la réponse';
    }
    settings.set(key, read);
    cleanup.repositories.push(read);
    return read;
  };
  const branchState = async (where: Where, branch: string): Promise<BranchRead> => {
    const call = await options.run(branchArgs(where, branch));
    if (notFound(call)) return { state: 'absent' };
    if (failed(call)) return { state: 'error', error: `gh api ${where.repo}/branches : ${outcome(call)}` };
    try {
      const raw = JSON.parse(call.stdout) as Record<string, unknown>;
      if (typeof raw?.['sha'] !== 'string' || !raw['sha']) return { state: 'error', error: 'réponse sans tête de branche' };
      return { state: 'present', sha: raw['sha'], protected: typeof raw['protected'] === 'boolean' ? raw['protected'] : null };
    } catch (error) { return { state: 'error', error: `réponse illisible : ${errorMessage(error)}` }; }
  };
  /** Numbers of the open pull requests whose `field` is `value`; a string when the list could not be read. */
  const openPulls = async (where: Where, field: 'base' | 'head', value: string): Promise<number[] | string> => {
    const call = await options.run(openPullsArgs(where, field, value));
    if (failed(call)) return `gh api ${where.repo}/pulls : ${outcome(call)}`;
    try {
      const list = JSON.parse(call.stdout) as unknown;
      return Array.isArray(list) && list.every(n => typeof n === 'number') ? list as number[] : 'réponse illisible';
    } catch (error) { return `réponse illisible : ${errorMessage(error)}`; }
  };

  for (const m of merged) {
    const done = (status: BranchStatus, reason: string): void => { cleanup.branches.push({ pr: m.pr, branch: m.branch, head: m.head, status, reason }); };
    if (options.keep !== null) { done('kept', options.keep); continue; }
    if (!m.branch) { done('kept', 'branche de tête inconnue'); continue; }
    if (m.crossRepository === true) { done('kept', 'PR venue d\'un fork : la branche appartient à un autre dépôt'); continue; }
    if (m.crossRepository === null) { done('kept', 'origine de la branche inconnue (isCrossRepository non lu) : peut-être un fork'); continue; }
    if (options.target !== null && m.branch === options.target) { done('kept', 'branche cible'); continue; }
    const where = pullRequestPath({ number: m.pr, url: m.url });
    if (!where) { done('kept', `adresse de la PR illisible (${m.url || 'absente'})`); continue; }
    const repo = await repository(where);
    if (repo.error) { done('failed', `réglages du dépôt illisibles (${repo.error}) : branche par défaut inconnue`); continue; }
    if (m.branch === repo.defaultBranch) { done('kept', 'branche par défaut du dépôt'); continue; }
    const before = await branchState(where, m.branch);
    if (before.state === 'absent') { done('absent', repo.deleteBranchOnMerge ? 'déjà supprimée (par GitHub, delete_branch_on_merge)' : 'déjà supprimée'); continue; }
    if (before.state === 'error') { done('failed', `lecture de la branche impossible (${before.error})`); continue; }
    // The head the merge carried, never another: a branch that received commits since keeps them.
    if (before.sha !== m.head) { done('kept', `tête déplacée depuis la fusion (${short(before.sha)} au lieu de ${short(m.head)})`); continue; }
    if (before.protected !== false) { done('kept', before.protected ? 'branche protégée' : 'protection de la branche inconnue'); continue; }
    // Deleting the base or the head of an open pull request would close it.
    const owner = repo.repo.split('/')[0]!;
    let blocked: { status: BranchStatus; reason: string } | null = null;
    for (const [field, value, role] of [['base', m.branch, 'base'], ['head', `${owner}:${m.branch}`, 'tête']] as const) {
      const open = await openPulls(where, field, value);
      if (typeof open === 'string') { blocked = { status: 'failed', reason: `PR ouvertes illisibles (${open})` }; break; }
      if (open.length) { blocked = { status: 'kept', reason: `${role} de ${open.map(n => `la PR #${n}`).join(', ')}, encore ouverte${open.length > 1 ? 's' : ''}` }; break; }
    }
    if (blocked) { done(blocked.status, blocked.reason); continue; }
    const deletion = await options.run(deleteBranchArgs(where, m.branch));
    // The result is read again whatever the exit code: the absence of the branch is the only proof (incident 30).
    const after = await branchState(where, m.branch);
    if (after.state === 'absent') done(failed(deletion) ? 'absent' : 'deleted', failed(deletion) ? 'déjà supprimée (pendant la suppression)' : 'supprimée');
    else if (after.state === 'present') done('failed', `suppression non constatée : la branche existe encore (gh api -X DELETE : ${outcome(deletion)})`);
    else done('failed', `suppression non vérifiée (gh api -X DELETE : ${outcome(deletion)} ; relecture : ${after.error})`);
  }
  return cleanup;
}

/** One line per branch, then the advice for a repository that does not delete merged branches itself. */
export function cleanupLines(cleanup: BranchCleanup): string[] {
  const lines = cleanup.branches.map(b => {
    const name = `${b.branch || '?'} (PR #${b.pr})`;
    switch (b.status) {
      case 'deleted': return `Branche ${name} : supprimée, tête ${short(b.head)} (à recréer au besoin : git push origin ${b.head}:refs/heads/${b.branch}).`;
      case 'absent': return `Branche ${name} : ${b.reason}.`;
      case 'kept': return `Branche ${name} : gardée, ${b.reason}.`;
      default: return `AVERTISSEMENT : branche ${name} non supprimée : ${b.reason} ; la fusion reste acquise.`;
    }
  });
  for (const r of cleanup.repositories) {
    if (r.deleteBranchOnMerge === false) {
      lines.push(`Réglage du dépôt ${r.repo} : delete_branch_on_merge est faux. Pour que GitHub supprime lui-même chaque branche fusionnée : ` +
        `${deleteOnMergeCommand({ host: r.host, repo: `repos/${r.repo}` })} (commande non lancée).`);
    }
  }
  return lines;
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The GitHub repository of a remote address: `https://<host>/<owner>/<name>(.git)`, `ssh://[user@]<host>[:port]/<owner>/<name>(.git)`
 * or `[user@]<host>:<owner>/<name>(.git)`. Null for anything else (a local path, another form).
 */
export function remoteRepository(url: string): Where | null {
  const m = /^https?:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]{1,253}(?::\d{1,5})?)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
    ?? /^ssh:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]{1,253})(?::\d{1,5})?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
    ?? /^(?:[^@/:]+@)?([A-Za-z0-9.-]{1,253}):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m || [m[2]!, m[3]!].some(name => !NAME.test(name) || name === '.' || name === '..')) return null;
  return { host: m[1]!.toLowerCase(), repo: `repos/${m[2]}/${m[3]}` };
}

/** What `apv init` says about the setting « delete head branches after merge » of the GitHub repository of `origin`. */
export interface DeleteOnMergeCheck {
  /** `<owner>/<name>`, or null when `origin` is not a GitHub address. */
  repo: string | null;
  host: string | null;
  deleteBranchOnMerge: boolean | null;
  /** The command that sets it, when it is false. Never run by the tool. */
  command: string | null;
  /** Why the setting was not read. */
  note: string | null;
}

/** Reads `delete_branch_on_merge` of the repository of the `origin` address (`gh api repos/<owner>/<repo>`). Never changes it. */
export async function checkDeleteOnMerge(origin: string | null, gh: GhRunner): Promise<DeleteOnMergeCheck> {
  const none = { repo: null, host: null, deleteBranchOnMerge: null, command: null };
  if (!origin) return { ...none, note: 'pas de dépôt distant origin' };
  const where = remoteRepository(origin);
  if (!where) return { ...none, note: `adresse de origin non reconnue comme un dépôt GitHub (${origin})` };
  const base = { repo: where.repo.replace(/^repos\//, ''), host: where.host, deleteBranchOnMerge: null, command: null };
  let call: GhCall;
  try { call = await gh(repositoryArgs(where)); } catch (error) { return { ...base, note: `gh : ${errorMessage(error)}` }; }
  if (failed(call)) return { ...base, note: `gh api ${where.repo} : ${outcome(call)}${call.stderr.trim() ? ` (${call.stderr.trim().split('\n').at(-1)})` : ''}` };
  let read: ReturnType<typeof parseRepositorySettings>;
  try { read = parseRepositorySettings(call.stdout); } catch (error) { return { ...base, note: `réponse illisible : ${errorMessage(error)}` }; }
  if (read.deleteBranchOnMerge === null) return { ...base, note: 'delete_branch_on_merge absent de la réponse (droits insuffisants pour lire les réglages de fusion)' };
  return { ...base, deleteBranchOnMerge: read.deleteBranchOnMerge, command: read.deleteBranchOnMerge ? null : deleteOnMergeCommand(where), note: null };
}
