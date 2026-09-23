import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage } from '../domain/errors.js';
/**
 * Message of a merge refused for lack of authorisation. Same text as `REASONS.merge` of the Bash hook
 * (hooks/scripts/bash-guard.mjs); a test keeps both equal.
 */
export const MERGE_REFUSED = "APV : fusion de PR bloquée hors de la commande dédiée. Une fusion se fait seulement sur ordre explicite " +
    "de l'opérateur, par /apv:stack (outil : APV_ALLOW_MERGE=1 apv stack merge <pr...>), qui re-cible, vérifie la base de chaque PR " +
    "juste avant de fusionner et s'arrête à la première anomalie. APV_ALLOW_MERGE=1 se pose devant cette seule commande.";
const GH_TIMEOUT_MS = 120_000;
/** Runs `gh` (or `APV_GH`) without a shell, with the caller's environment. */
export function processGh(bin, env, cwd) {
    return args => new Promise(done => {
        const out = [];
        const err = [];
        let child;
        try {
            child = spawn(bin, args, { cwd, env: { ...env, GH_PROMPT_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (error) {
            done({ args, status: null, stdout: '', stderr: '', error: errorMessage(error) });
            return;
        }
        const timer = setTimeout(() => child.kill('SIGTERM'), GH_TIMEOUT_MS);
        child.stdout?.on('data', (c) => out.push(c));
        child.stderr?.on('data', (c) => err.push(c));
        child.once('error', error => { clearTimeout(timer); done({ args, status: null, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), error: error.message }); });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            done({ args, status: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), error: signal ? `arrêté par ${signal}` : null });
        });
    });
}
export const VIEW_FIELDS = 'number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup';
const str = (v) => typeof v === 'string' ? v : '';
/** Check runs and commit statuses of `statusCheckRollup`, reduced to success, pending or failure. */
export function readChecks(rollup) {
    if (!Array.isArray(rollup))
        return [];
    return rollup.map((raw) => {
        const item = (raw ?? {});
        const name = str(item['name']) || str(item['context']) || str(item['workflowName']) || 'contrôle sans nom';
        if (item['__typename'] === 'StatusContext' || (item['state'] !== undefined && item['conclusion'] === undefined)) {
            const state = str(item['state']).toUpperCase();
            return { name, state: state === 'SUCCESS' ? 'success' : state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'failure' };
        }
        const status = str(item['status']).toUpperCase();
        if (status && status !== 'COMPLETED')
            return { name, state: 'pending' };
        const conclusion = str(item['conclusion']).toUpperCase();
        return { name, state: ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion) ? 'success' : 'failure' };
    });
}
export function parsePullRequest(text) {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || typeof raw['number'] !== 'number')
        throw new Error('réponse sans numéro de PR');
    return {
        number: raw['number'], state: str(raw['state']), isDraft: raw['isDraft'] === true, baseRefName: str(raw['baseRefName']),
        headRefName: str(raw['headRefName']), headRefOid: str(raw['headRefOid']), mergeable: str(raw['mergeable']),
        mergeStateStatus: str(raw['mergeStateStatus']), checks: readChecks(raw['statusCheckRollup']),
    };
}
/** Merge states that allow a merge now; `DRAFT` is handled apart (`--ready`). */
const MERGE_READY = new Set(['CLEAN', 'HAS_HOOKS']);
/**
 * Every reason not to merge this pull request onto `expectedBase` now. Waiting states (`UNKNOWN`) count as
 * anomalies here: the caller polls them first.
 */
export function anomalies(pr, expectedBase, allowDraft) {
    const out = [];
    if (pr.state !== 'OPEN')
        out.push(`PR #${pr.number} n'est pas ouverte (état ${pr.state || 'inconnu'})`);
    if (pr.baseRefName !== expectedBase)
        out.push(`PR #${pr.number} vise ${pr.baseRefName || '?'} au lieu de ${expectedBase}`);
    if (pr.isDraft && !allowDraft)
        out.push(`PR #${pr.number} est un brouillon (--ready retire ce statut avant la fusion, sur ordre de l'opérateur)`);
    if (pr.mergeable !== 'MERGEABLE')
        out.push(`PR #${pr.number} n'est pas fusionnable (mergeable ${pr.mergeable || 'inconnu'})`);
    const draftState = pr.isDraft && pr.mergeStateStatus === 'DRAFT';
    if (!draftState && !MERGE_READY.has(pr.mergeStateStatus))
        out.push(`PR #${pr.number} : état de fusion ${pr.mergeStateStatus || 'inconnu'} (attendu CLEAN)`);
    const failing = pr.checks.filter(c => c.state === 'failure').map(c => c.name);
    const pending = pr.checks.filter(c => c.state === 'pending').map(c => c.name);
    if (failing.length)
        out.push(`PR #${pr.number} : contrôle(s) en échec : ${failing.join(', ')}`);
    if (pending.length)
        out.push(`PR #${pr.number} : contrôle(s) en cours : ${pending.join(', ')}`);
    return out;
}
async function call(options, args) {
    const result = await options.gh(args);
    options.onCall(result);
    return result;
}
async function view(options, n) {
    const result = await call(options, ['pr', 'view', String(n), '--json', VIEW_FIELDS]);
    if (result.status !== 0 || result.error)
        return { pr: null, error: `gh pr view ${n} a échoué (${result.error ?? `code ${result.status}`})` };
    try {
        return { pr: parsePullRequest(result.stdout), error: null };
    }
    catch (error) {
        return { pr: null, error: `réponse illisible de gh pr view ${n} : ${errorMessage(error)}` };
    }
}
/** Re-reads a pull request while GitHub still computes its mergeability. */
async function settled(options, n) {
    let result = await view(options, n);
    for (let i = 0; i < options.pollAttempts && result.pr && (result.pr.mergeable === 'UNKNOWN' || result.pr.mergeStateStatus === 'UNKNOWN'); i += 1) {
        await sleep(options.pollMs);
        result = await view(options, n);
    }
    return result;
}
/**
 * `apv stack plan`: reads every pull request and checks the stack. Each one open, the base of PR n+1 is the
 * head of PR n (the target for the first), mergeable, checks green or absent. All anomalies are listed.
 */
export async function planStack(numbers, options) {
    const prs = [];
    for (const n of numbers) {
        const { pr, error } = await settled(options, n);
        prs.push({ number: n, pr, expectedBase: null, anomalies: error ? [error] : [] });
    }
    const first = prs[0]?.pr;
    const target = options.target ?? first?.baseRefName ?? null;
    prs.forEach((item, i) => {
        if (!item.pr)
            return;
        const previous = i === 0 ? null : prs[i - 1];
        item.expectedBase = i === 0 ? target : previous?.pr?.headRefName ?? null;
        if (item.expectedBase === null)
            item.anomalies.push(`PR #${item.number} : base attendue inconnue (la PR précédente n'a pas été lue)`);
        else
            item.anomalies.push(...anomalies(item.pr, item.expectedBase, options.ready));
        if (target && item.pr.headRefName === target)
            item.anomalies.push(`PR #${item.number} part de la branche cible ${target}`);
    });
    return { target, prs, ok: prs.every(p => p.anomalies.length === 0) };
}
/**
 * `apv stack merge`: merges the stack in order and stops at the first anomaly. Before each merge the pull
 * request is read again and checked; once the previous one is merged, the next one is retargeted onto the
 * target and the new base is verified by a new read, never trusted from an exit code (incident 30). The
 * merge passes `--match-head-commit`, so a head that moved since the check is refused by GitHub itself.
 */
export async function mergeStack(numbers, method, options) {
    const plan = await planStack(numbers, options);
    const report = { target: plan.target, method, merged: [], stopped: null, plan };
    const stop = (pr, reasons) => { report.stopped = { pr, reasons }; return report; };
    if (!plan.ok) {
        const bad = plan.prs.find(p => p.anomalies.length);
        return stop(bad.number, ['pile incohérente avant toute fusion (apv stack plan)', ...plan.prs.flatMap(p => p.anomalies)]);
    }
    const target = plan.target;
    for (const [i, n] of numbers.entries()) {
        let { pr, error } = await view(options, n);
        if (!pr)
            return stop(n, [error]);
        if (i > 0 && pr.baseRefName !== target) {
            const previousHead = plan.prs[i - 1].pr.headRefName;
            if (pr.baseRefName !== previousHead)
                return stop(n, [`PR #${n} vise ${pr.baseRefName}, ni la cible ${target} ni la tête de la PR précédente ${previousHead}`]);
            const edit = await call(options, ['pr', 'edit', String(n), '--base', target]);
            ({ pr, error } = await view(options, n));
            if (!pr)
                return stop(n, [error]);
            if (pr.baseRefName !== target) {
                return stop(n, [`re-ciblage de la PR #${n} non effectif : elle vise ${pr.baseRefName} au lieu de ${target} (gh pr edit : ${edit.error ?? `code ${edit.status}`})`]);
            }
        }
        ({ pr, error } = await settled(options, n));
        if (!pr)
            return stop(n, [error]);
        let problems = anomalies(pr, target, options.ready);
        if (problems.length)
            return stop(n, problems);
        if (pr.isDraft) {
            const ready = await call(options, ['pr', 'ready', String(n)]);
            ({ pr, error } = await settled(options, n));
            if (!pr)
                return stop(n, [error]);
            if (pr.isDraft)
                return stop(n, [`la PR #${n} est encore un brouillon après gh pr ready (${ready.error ?? `code ${ready.status}`})`]);
            problems = anomalies(pr, target, false);
            if (problems.length)
                return stop(n, problems);
        }
        const merge = await call(options, ['pr', 'merge', String(n), `--${method}`, '--match-head-commit', pr.headRefOid]);
        let after = await view(options, n);
        for (let k = 0; k < options.pollAttempts && after.pr && after.pr.state === 'OPEN' && merge.status === 0; k += 1) {
            await sleep(options.pollMs);
            after = await view(options, n);
        }
        if (!after.pr)
            return stop(n, [after.error]);
        if (after.pr.state !== 'MERGED' || after.pr.baseRefName !== target) {
            return stop(n, [`fusion de la PR #${n} non constatée : état ${after.pr.state || 'inconnu'}, base ${after.pr.baseRefName || '?'} (gh pr merge : ${merge.error ?? `code ${merge.status}`})`]);
        }
        report.merged.push(n);
    }
    return report;
}
//# sourceMappingURL=github.js.map