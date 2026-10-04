import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { manifestCommit, readSharedRun, runTime, sharedRunIds, SHARED_RECEIPTS_DIR } from '../gates/store.js';
import { readMergeTraces } from '../rules/merges.js';
import { latestReviews, reviewsDir } from '../rules/reviews.js';
import { MAX_RUN_STATE_BYTES, readBounded } from '../run/bounded-read.js';
import { gitRead, resolveCommit } from '../run/git-probe.js';
import { listRunFiles, parseRunStateText, RUN_ID, RUN_STATE_DIR } from '../run/state.js';
import { parsePrData, parseStackLog } from './pr.js';
import { deliveredPullRequest, measureRun } from './run.js';
/**
 * Sources of `apv metrics`, read only: nothing is written, fetched or locked. The state of an execution lives in the
 * worktree of its project lead (often `.claude/worktrees/run-<id>`) until the delivery commits it: every worktree of the
 * repository is read, then the history of every branch, and the most recent copy wins.
 */
/** Roots of the worktrees of the repository (`git worktree list`), the repository first; those that exist only. */
export function worktreeRoots(repo) {
    const out = gitRead(repo, ['worktree', 'list', '--porcelain']);
    const roots = (out ?? '').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9)).filter(p => existsSync(p));
    return [repo, ...roots.filter(r => r !== repo)];
}
/** Most recent of two copies of a state: the later `updatedAt`, then the longer journal. */
const newer = (a, b) => {
    const d = Date.parse(b.state.updatedAt) - Date.parse(a.state.updatedAt);
    return d > 0 || (d === 0 && b.state.events.length > a.state.events.length) ? b : a;
};
/** Most commits read from the history for one state file: its last versions are enough. */
const HISTORY_VERSIONS = 3;
/**
 * Every execution state the repository holds, one per spec id, the most recent copy of each: the `.apv/state/run-*.json`
 * of each worktree, then the versions committed on any branch. An unreadable copy is skipped and named in `skipped`.
 */
export function findRunStates(repo, only) {
    const states = new Map();
    const skipped = [];
    const keep = (found) => {
        const current = states.get(found.state.specId);
        states.set(found.state.specId, current ? newer(current, found) : found);
    };
    for (const root of worktreeRoots(repo)) {
        for (const { specId, file } of listRunFiles(root)) {
            if (only && specId !== only)
                continue;
            const shown = relative(repo, file) || file;
            try {
                keep({ state: parseRunStateText(readBounded(file, shown, MAX_RUN_STATE_BYTES).toString('utf8'), shown, specId), source: shown });
            }
            catch (error) {
                skipped.push(`${shown} : ${errorMessage(error).split('\n')[0]}`);
            }
        }
    }
    const pattern = only ? `${RUN_STATE_DIR}/run-${only}.json` : `${RUN_STATE_DIR}/run-*.json`;
    const log = gitRead(repo, ['log', '--all', '--format=%x1e%H', '--name-only', '--diff-filter=AM', '--', pattern]) ?? '';
    const versions = new Map();
    for (const block of log.split('\x1e').slice(1)) {
        const [sha, ...names] = block.trim().split('\n');
        for (const name of names.map(n => n.trim()).filter(Boolean)) {
            const id = /^\.apv\/state\/run-(.+)\.json$/.exec(name)?.[1];
            if (!id || !RUN_ID.test(id))
                continue;
            const list = versions.get(id) ?? [];
            if (list.length < HISTORY_VERSIONS)
                versions.set(id, [...list, sha]);
        }
    }
    for (const [id, shas] of versions) {
        for (const sha of shas) {
            const path = `${RUN_STATE_DIR}/run-${id}.json`;
            const text = gitRead(repo, ['show', `${sha}:${path}`]);
            if (text === null || text.length > MAX_RUN_STATE_BYTES)
                continue;
            const shown = `${sha.slice(0, 12)}:${path}`;
            try {
                keep({ state: parseRunStateText(text, shown, id), source: shown });
            }
            catch (error) {
                skipped.push(`${shown} : ${errorMessage(error).split('\n')[0]}`);
            }
        }
    }
    return { states, skipped };
}
/** The Git common directory of `repo`, absolute; null outside a repository. */
export function commonDirOf(repo) {
    return gitRead(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']) || null;
}
/** Most commits gathered for one execution or one pull request: beyond, the counts stop and say so. */
const MAX_COMMITS = 5000;
/**
 * Commits of an execution: those reachable from its branch, its tasks and the commits of its journal, and not from its
 * base. The receipts and reviews of these commits are the ones of the execution.
 */
export function runCommits(repo, state) {
    const tips = new Set();
    const add = (ref) => { const sha = ref ? resolveCommit(repo, ref) : null; if (sha)
        tips.add(sha); };
    add(state.branch);
    for (const t of Object.values(state.tasks)) {
        add(t.commit);
        add(t.branch);
    }
    for (const s of Object.values(state.steps))
        add(s.commit);
    for (const e of state.events)
        add(e.commit);
    if (!tips.size)
        return new Set();
    const out = gitRead(repo, ['rev-list', `--max-count=${MAX_COMMITS}`, ...tips, '--not', state.baseSha]) ?? '';
    return new Set(out.split('\n').filter(l => /^[a-f0-9]{40,64}$/.test(l)));
}
/** Runs of the shared receipt store (`<git common dir>/apv/receipts`) by commit, read once: only their manifest. */
export function storedRuns(common) {
    if (!common)
        return [];
    const store = join(common, SHARED_RECEIPTS_DIR);
    return sharedRunIds(store).flatMap(runId => {
        const dir = join(store, runId);
        const sha = manifestCommit(dir);
        return sha ? [{ runId, dir, sha }] : [];
    });
}
/**
 * Runs of `apv gates run` on `commits`: only runs whose copy is intact (manifest digests) count. Start: the time in the
 * run identifier; end: when the run was copied into the shared store, at its end.
 */
export function suitesOn(runs, commits) {
    const out = [];
    for (const { runId, dir, sha } of runs) {
        if (!commits.has(sha))
            continue;
        const run = readSharedRun(dir);
        if (!run.intact)
            continue;
        let summary = {};
        try {
            summary = JSON.parse(run.files.get('summary.json')?.toString('utf8') ?? '{}');
        }
        catch {
            summary = {};
        }
        const started = runTime(runId);
        if (started === null)
            continue;
        const stage = typeof summary['stage'] === 'string' ? summary['stage'] : null;
        out.push({ runId, candidateSha: sha, stage, full: summary['suite'] === true || stage === 'full', ok: typeof summary['ok'] === 'boolean' ? summary['ok'] : null,
            startedAt: new Date(started).toISOString(), endedAt: Number.isNaN(Date.parse(run.manifest.copiedAt)) ? null : run.manifest.copiedAt });
    }
    return out;
}
export function suiteCount(suites) {
    const full = suites.filter(s => s.full);
    return { full: full.length, fullMs: full.reduce((t, s) => t + (s.endedAt ? Math.max(0, Date.parse(s.endedAt) - Date.parse(s.startedAt)) : 0), 0),
        fullFailed: full.filter(s => s.ok === false).length, task: suites.length - full.length, impact: null };
}
/** Lines of `.apv/state/stack.log` of every worktree, each once, in time order. */
export function stackEvents(repo) {
    const seen = new Set();
    const out = [];
    for (const root of worktreeRoots(repo)) {
        const file = join(root, RUN_STATE_DIR, 'stack.log');
        let text;
        try {
            text = readBounded(file, file, MAX_RUN_STATE_BYTES).toString('utf8');
        }
        catch {
            continue;
        }
        for (const line of text.split('\n')) {
            if (!line.trim() || seen.has(line))
                continue;
            seen.add(line);
            out.push(...parseStackLog(line));
        }
    }
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
/** Time of the signed merge trace of a pull request (`apv stack merge`, `apv stack batch --merge`), or null. */
export function tracedMerge(common, pr) {
    if (!common)
        return null;
    return readMergeTraces(common).filter(t => t.pr === pr).map(t => t.at).sort().at(-1) ?? null;
}
/** Latest review record of each domain at each of `commits` (src/rules/reviews.ts), sealed or not. */
export function reviewsOn(common, commits) {
    const out = [];
    for (const commit of commits) {
        if (!existsSync(reviewsDir(common, commit)))
            continue;
        for (const [domain, read] of latestReviews(common, commit)) {
            if (read.record)
                out.push({ commit, domain, at: read.record.at, sealed: read.problem === null });
        }
    }
    return out;
}
export const PR_FIELDS = 'number,title,url,state,headRefName,baseRefName,createdAt,mergedAt,additions,deletions,changedFiles,commits';
/** One pull request by `gh pr view`; the reason when `gh` failed or answered something else. */
export async function viewPr(gh, n) {
    const call = await gh(['pr', 'view', String(n), '--json', PR_FIELDS]);
    if (call.status !== 0)
        return { pr: null, error: `gh pr view ${n} : ${(call.error ?? call.stderr.trim()) || `sortie ${call.status}`}`.split('\n')[0] };
    const pr = parsePrData(call.stdout);
    return pr ? { pr, error: null } : { pr: null, error: `gh pr view ${n} : réponse illisible` };
}
/** Numbers of the pull requests merged since `since` (`gh pr list --state merged`), most recent first. */
export async function mergedPrs(gh, since, limit) {
    const call = await gh(['pr', 'list', '--state', 'merged', '--search', `merged:>=${since.slice(0, 10)}`, '--limit', String(limit), '--json', 'number,mergedAt']);
    if (call.status !== 0)
        return { numbers: [], error: `gh pr list : ${(call.error ?? call.stderr.trim()) || `sortie ${call.status}`}`.split('\n')[0] };
    try {
        const list = JSON.parse(call.stdout);
        return { numbers: list.filter(p => typeof p.number === 'number' && typeof p.mergedAt === 'string' && p.mergedAt >= since)
                .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt))).map(p => p.number), error: null };
    }
    catch {
        return { numbers: [], error: 'gh pr list : réponse illisible' };
    }
}
/** The pull request of a branch (`gh pr list --head`): the merged one first, else the most recent. */
export async function prOfBranch(gh, branch) {
    const call = await gh(['pr', 'list', '--head', branch, '--state', 'all', '--limit', '5', '--json', 'number,mergedAt,createdAt']);
    if (call.status !== 0)
        return null;
    try {
        const list = JSON.parse(call.stdout).filter(p => typeof p.number === 'number');
        const merged = list.filter(p => typeof p.mergedAt === 'string' && p.mergedAt);
        return (merged[0] ?? list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0])?.number ?? null;
    }
    catch {
        return null;
    }
}
/**
 * The end of an execution: its pull request (named by the delivery, else found by its branch) and its merge (GitHub,
 * else the signed trace of the tool, else stack.log). `gh` null: offline, the trace and stack.log only.
 */
export async function pullRequestEnd(input) {
    const { gh } = input;
    let number = input.named;
    let source = number !== null ? 'note de livraison' : '';
    if (number === null && gh) {
        number = await prOfBranch(gh, input.state.branch);
        source = 'branche de la spec';
    }
    if (number === null)
        return null;
    const n = number;
    let pr = null;
    if (gh)
        pr = (await viewPr(gh, n)).pr;
    const merged = pr?.mergedAt ?? tracedMerge(input.common, n)
        ?? input.stack.filter(e => e.pr === n && (e.event === 'batch-merge' || e.event === 'merge')).map(e => e.at).at(-1) ?? null;
    return { number: n, url: pr?.url ?? null, createdAt: pr?.createdAt ?? null, mergedAt: merged,
        source: `${source}${pr ? ', gh pr view' : merged ? ', trace de fusion' : ''}` };
}
/**
 * The end of an execution without `gh` (`apv status`): the pull request its delivery names, merged at the time of its
 * signed merge trace, else of its `batch-merge` line in stack.log.
 */
export function offlineEnd(common, named, stack) {
    if (named === null)
        return null;
    const merged = tracedMerge(common, named) ?? stack.filter(e => e.pr === named && e.event === 'batch-merge').map(e => e.at).at(-1) ?? null;
    return { number: named, url: null, createdAt: null, mergedAt: merged, source: merged ? 'note de livraison, trace de fusion' : 'note de livraison' };
}
/** Number of executions `apv status` shows the measure of (section 11: « les trois derniers chiffres »). */
export const STATUS_RUNS = 3;
/** The measure of the last STATUS_RUNS executions created, offline and without the receipt store (`apv status`). */
export function recentMeasures(repo, count = STATUS_RUNS) {
    const common = commonDirOf(repo);
    const stack = stackEvents(repo);
    return [...findRunStates(repo).states.values()]
        .sort((a, b) => Date.parse(b.state.createdAt) - Date.parse(a.state.createdAt)).slice(0, count)
        .map(f => measureRun({ state: f.state, source: f.source, pr: offlineEnd(common, deliveredPullRequest(f.state), stack) }));
}
//# sourceMappingURL=sources.js.map