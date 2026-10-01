import { errorMessage } from '../domain/errors.js';
import { hostname, pullRequestPath, refSegment } from './github.js';
export const REPOSITORY_JQ = '{default_branch, delete_branch_on_merge}';
const BRANCH_JQ = '{sha: .commit.sha, protected}';
/** `gh api repos/<owner>/<repo> --jq …`: the default branch and `delete_branch_on_merge`. */
export function repositoryArgs(where) {
    return ['api', ...hostname(where), where.repo, '--jq', REPOSITORY_JQ];
}
/** `gh api repos/<owner>/<repo>/branches/<branch> --jq …`: the head of the branch and whether it is protected. */
export function branchArgs(where, branch) {
    return ['api', ...hostname(where), `${where.repo}/branches/${refSegment(branch)}`, '--jq', BRANCH_JQ];
}
/** `gh api -X GET repos/<owner>/<repo>/pulls -f state=open -f <field>=<value>`: the open pull requests with this base or head. */
export function openPullsArgs(where, field, value) {
    return ['api', ...hostname(where), '-X', 'GET', `${where.repo}/pulls`, '-f', 'state=open', '-f', `${field}=${value}`, '-f', 'per_page=100', '--jq', '[.[].number]'];
}
/** `gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>`. */
export function deleteBranchArgs(where, branch) {
    return ['api', ...hostname(where), '-X', 'DELETE', `${where.repo}/git/refs/heads/${refSegment(branch)}`];
}
/** The command that makes GitHub delete the head branch of each merged pull request itself. Given, never run. */
export function deleteOnMergeCommand(where) {
    return ['gh', 'api', ...hostname(where), '-X', 'PATCH', where.repo, '-F', 'delete_branch_on_merge=true'].join(' ');
}
const failed = (call) => call.status !== 0 || call.error !== null;
const notFound = (call) => failed(call) && /\(HTTP 404\)/.test(`${call.stderr}\n${call.stdout}`);
const outcome = (call) => call.error ?? `code ${call.status}`;
const short = (sha) => sha.slice(0, 12);
/** Reads the answer of `repositoryArgs`. */
export function parseRepositorySettings(text) {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object')
        throw new Error('réponse illisible');
    const defaultBranch = typeof raw['default_branch'] === 'string' && raw['default_branch'] ? raw['default_branch'] : null;
    return { defaultBranch, deleteBranchOnMerge: typeof raw['delete_branch_on_merge'] === 'boolean' ? raw['delete_branch_on_merge'] : null };
}
/** Deletes the head branch of each merged pull request, in order, under the rules above; one outcome per branch. */
export async function cleanMergedBranches(merged, options) {
    const cleanup = { branches: [], repositories: [] };
    const settings = new Map();
    const repository = async (where) => {
        const key = `${where.host}/${where.repo}`;
        const known = settings.get(key);
        if (known)
            return known;
        const call = await options.run(repositoryArgs(where));
        const read = { host: where.host, repo: where.repo.replace(/^repos\//, ''), defaultBranch: null, deleteBranchOnMerge: null, error: null };
        if (failed(call))
            read.error = `gh api ${where.repo} : ${outcome(call)}`;
        else {
            try {
                Object.assign(read, parseRepositorySettings(call.stdout));
            }
            catch (error) {
                read.error = `réponse illisible de gh api ${where.repo} : ${errorMessage(error)}`;
            }
            if (!read.error && !read.defaultBranch)
                read.error = 'branche par défaut absente de la réponse';
        }
        settings.set(key, read);
        cleanup.repositories.push(read);
        return read;
    };
    const branchState = async (where, branch) => {
        const call = await options.run(branchArgs(where, branch));
        if (notFound(call))
            return { state: 'absent' };
        if (failed(call))
            return { state: 'error', error: `gh api ${where.repo}/branches : ${outcome(call)}` };
        try {
            const raw = JSON.parse(call.stdout);
            if (typeof raw?.['sha'] !== 'string' || !raw['sha'])
                return { state: 'error', error: 'réponse sans tête de branche' };
            return { state: 'present', sha: raw['sha'], protected: typeof raw['protected'] === 'boolean' ? raw['protected'] : null };
        }
        catch (error) {
            return { state: 'error', error: `réponse illisible : ${errorMessage(error)}` };
        }
    };
    /** Numbers of the open pull requests whose `field` is `value`; a string when the list could not be read. */
    const openPulls = async (where, field, value) => {
        const call = await options.run(openPullsArgs(where, field, value));
        if (failed(call))
            return `gh api ${where.repo}/pulls : ${outcome(call)}`;
        try {
            const list = JSON.parse(call.stdout);
            return Array.isArray(list) && list.every(n => typeof n === 'number') ? list : 'réponse illisible';
        }
        catch (error) {
            return `réponse illisible : ${errorMessage(error)}`;
        }
    };
    for (const m of merged) {
        const done = (status, reason) => { cleanup.branches.push({ pr: m.pr, branch: m.branch, head: m.head, status, reason }); };
        if (options.keep !== null) {
            done('kept', options.keep);
            continue;
        }
        if (!m.branch) {
            done('kept', 'branche de tête inconnue');
            continue;
        }
        if (m.crossRepository === true) {
            done('kept', 'PR venue d\'un fork : la branche appartient à un autre dépôt');
            continue;
        }
        if (m.crossRepository === null) {
            done('kept', 'origine de la branche inconnue (isCrossRepository non lu) : peut-être un fork');
            continue;
        }
        if (options.target !== null && m.branch === options.target) {
            done('kept', 'branche cible');
            continue;
        }
        const where = pullRequestPath({ number: m.pr, url: m.url });
        if (!where) {
            done('kept', `adresse de la PR illisible (${m.url || 'absente'})`);
            continue;
        }
        const repo = await repository(where);
        if (repo.error) {
            done('failed', `réglages du dépôt illisibles (${repo.error}) : branche par défaut inconnue`);
            continue;
        }
        if (m.branch === repo.defaultBranch) {
            done('kept', 'branche par défaut du dépôt');
            continue;
        }
        const before = await branchState(where, m.branch);
        if (before.state === 'absent') {
            done('absent', repo.deleteBranchOnMerge ? 'déjà supprimée (par GitHub, delete_branch_on_merge)' : 'déjà supprimée');
            continue;
        }
        if (before.state === 'error') {
            done('failed', `lecture de la branche impossible (${before.error})`);
            continue;
        }
        // The head the merge carried, never another: a branch that received commits since keeps them.
        if (before.sha !== m.head) {
            done('kept', `tête déplacée depuis la fusion (${short(before.sha)} au lieu de ${short(m.head)})`);
            continue;
        }
        if (before.protected !== false) {
            done('kept', before.protected ? 'branche protégée' : 'protection de la branche inconnue');
            continue;
        }
        // Deleting the base or the head of an open pull request would close it.
        const owner = repo.repo.split('/')[0];
        let blocked = null;
        for (const [field, value, role] of [['base', m.branch, 'base'], ['head', `${owner}:${m.branch}`, 'tête']]) {
            const open = await openPulls(where, field, value);
            if (typeof open === 'string') {
                blocked = { status: 'failed', reason: `PR ouvertes illisibles (${open})` };
                break;
            }
            if (open.length) {
                blocked = { status: 'kept', reason: `${role} de ${open.map(n => `la PR #${n}`).join(', ')}, encore ouverte${open.length > 1 ? 's' : ''}` };
                break;
            }
        }
        if (blocked) {
            done(blocked.status, blocked.reason);
            continue;
        }
        const deletion = await options.run(deleteBranchArgs(where, m.branch));
        // The result is read again whatever the exit code: the absence of the branch is the only proof (incident 30).
        const after = await branchState(where, m.branch);
        if (after.state === 'absent')
            done(failed(deletion) ? 'absent' : 'deleted', failed(deletion) ? 'déjà supprimée (pendant la suppression)' : 'supprimée');
        else if (after.state === 'present')
            done('failed', `suppression non constatée : la branche existe encore (gh api -X DELETE : ${outcome(deletion)})`);
        else
            done('failed', `suppression non vérifiée (gh api -X DELETE : ${outcome(deletion)} ; relecture : ${after.error})`);
    }
    return cleanup;
}
/** One line per branch, then the advice for a repository that does not delete merged branches itself. */
export function cleanupLines(cleanup) {
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
export function remoteRepository(url) {
    const m = /^https?:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]{1,253}(?::\d{1,5})?)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
        ?? /^ssh:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]{1,253})(?::\d{1,5})?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
        ?? /^(?:[^@/:]+@)?([A-Za-z0-9.-]{1,253}):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
    if (!m || [m[2], m[3]].some(name => !NAME.test(name) || name === '.' || name === '..'))
        return null;
    return { host: m[1].toLowerCase(), repo: `repos/${m[2]}/${m[3]}` };
}
/** Reads `delete_branch_on_merge` of the repository of the `origin` address (`gh api repos/<owner>/<repo>`). Never changes it. */
export async function checkDeleteOnMerge(origin, gh) {
    const none = { repo: null, host: null, deleteBranchOnMerge: null, command: null };
    if (!origin)
        return { ...none, note: 'pas de dépôt distant origin' };
    const where = remoteRepository(origin);
    if (!where)
        return { ...none, note: `adresse de origin non reconnue comme un dépôt GitHub (${origin})` };
    const base = { repo: where.repo.replace(/^repos\//, ''), host: where.host, deleteBranchOnMerge: null, command: null };
    let call;
    try {
        call = await gh(repositoryArgs(where));
    }
    catch (error) {
        return { ...base, note: `gh : ${errorMessage(error)}` };
    }
    if (failed(call))
        return { ...base, note: `gh api ${where.repo} : ${outcome(call)}${call.stderr.trim() ? ` (${call.stderr.trim().split('\n').at(-1)})` : ''}` };
    let read;
    try {
        read = parseRepositorySettings(call.stdout);
    }
    catch (error) {
        return { ...base, note: `réponse illisible : ${errorMessage(error)}` };
    }
    if (read.deleteBranchOnMerge === null)
        return { ...base, note: 'delete_branch_on_merge absent de la réponse (droits insuffisants pour lire les réglages de fusion)' };
    return { ...base, deleteBranchOnMerge: read.deleteBranchOnMerge, command: read.deleteBranchOnMerge ? null : deleteOnMergeCommand(where), note: null };
}
//# sourceMappingURL=branches.js.map