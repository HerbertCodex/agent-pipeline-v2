import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { IDENTITY_HINT } from '../run/commit-state.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage } from '../domain/errors.js';
import { anomalies, parsePullRequest, VIEW_FIELDS } from './github.js';
export function processGit(env) {
    return {
        run: (cwd, args) => new Promise(done => {
            const out = [];
            const err = [];
            const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout.on('data', (c) => out.push(c));
            child.stderr.on('data', (c) => err.push(c));
            child.once('error', error => done({ ok: false, stdout: '', stderr: error.message }));
            child.once('close', code => done({ ok: code === 0, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
        }),
    };
}
const short = (sha) => sha.slice(0, 12);
async function must(git, cwd, args) {
    const r = await git.run(cwd, args);
    if (!r.ok)
        throw new Error(`git ${args.join(' ')} : ${r.stderr.trim().slice(-1500) || 'échec'}`);
    return r.stdout.trim();
}
async function view(options, n) {
    const result = await options.gh(['pr', 'view', String(n), '--json', VIEW_FIELDS]);
    options.onCall(result);
    if (result.status !== 0 || result.error)
        return { pr: null, error: `gh pr view ${n} a échoué (${result.error ?? `code ${result.status}`})` };
    try {
        return { pr: parsePullRequest(result.stdout), error: null };
    }
    catch (error) {
        return { pr: null, error: `réponse illisible de gh pr view ${n} : ${errorMessage(error)}` };
    }
}
async function settled(options, n) {
    let result = await view(options, n);
    for (let i = 0; i < options.pollAttempts && result.pr && (result.pr.mergeable === 'UNKNOWN' || result.pr.mergeStateStatus === 'UNKNOWN'); i += 1) {
        await sleep(options.pollMs);
        result = await view(options, n);
    }
    return result;
}
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '');
/** The head of a pull request fetched from the remote (`refs/pull/<n>/head`, else its sha), checked to be `headRefOid`. */
async function fetchHead(options, pr) {
    const { git, repo, remote } = options;
    const byRef = await git.run(repo, ['fetch', '--no-tags', remote, `refs/pull/${pr.number}/head`]);
    if (byRef.ok && (await git.run(repo, ['rev-parse', 'FETCH_HEAD'])).stdout.trim() === pr.headRefOid)
        return pr.headRefOid;
    await git.run(repo, ['fetch', '--no-tags', remote, pr.headRefOid]);
    return (await git.run(repo, ['cat-file', '-e', `${pr.headRefOid}^{commit}`])).ok ? pr.headRefOid : null;
}
/** Fetches the target and returns its head and tree. */
async function targetHead(options, target) {
    await must(options.git, options.repo, ['fetch', '--no-tags', options.remote, `+refs/heads/${target}:refs/remotes/${options.remote}/${target}`]);
    const sha = await must(options.git, options.repo, ['rev-parse', `refs/remotes/${options.remote}/${target}^{commit}`]);
    return { sha, tree: await must(options.git, options.repo, ['rev-parse', `${sha}^{tree}`]) };
}
/**
 * Builds a batch: a branch `name` from `base` in the worktree `dir`, each head merged in order (`--no-ff`, never a
 * rebase). A pull request in conflict with the previous ones is left out of the batch, with the reason.
 */
async function buildLot(options, name, dir, base, members) {
    const { git } = options;
    await must(git, options.repo, ['worktree', 'add', '-b', name, dir, base]);
    const lot = { name, dir, base, baseTree: await must(git, dir, ['rev-parse', `${base}^{tree}`]), members: [], excluded: [], head: null, tree: null, proof: null, removed: false };
    for (const m of members) {
        const merged = await git.run(dir, ['-c', 'user.useConfigOnly=true', 'merge', '--no-ff', '--no-edit', '-m', `lot : fusion de la PR #${m.number} (${m.headRefName})`, '-m', 'Generated-by: apv stack batch', m.head]);
        if (!merged.ok) {
            await git.run(dir, ['merge', '--abort']);
            lot.excluded.push({ pr: m.number, reason: `conflit avec les PR précédentes du lot : ${merged.stdout.trim().split('\n').filter(l => /CONFLICT|conflit/i.test(l)).slice(0, 5).join(' ; ') || merged.stderr.trim().slice(-300)}` });
            options.log(`Lot ${name} : PR #${m.number} en conflit avec les précédentes, laissée hors du lot.`);
            continue;
        }
        const mergeCommit = await must(git, dir, ['rev-parse', 'HEAD']);
        lot.members.push({ ...m, mergeCommit, tree: await must(git, dir, ['rev-parse', 'HEAD^{tree}']) });
    }
    lot.head = await must(git, dir, ['rev-parse', 'HEAD']);
    lot.tree = await must(git, dir, ['rev-parse', 'HEAD^{tree}']);
    return lot;
}
async function removeLot(options, lot) {
    if (lot.removed || options.keep)
        return;
    const r = await options.git.run(options.repo, ['worktree', 'remove', '--force', lot.dir]);
    lot.removed = r.ok;
    if (!r.ok)
        options.log(`Lot ${lot.name} : worktree ${lot.dir} non retiré (${r.stderr.trim().slice(-300)}).`);
}
/**
 * `apv stack batch`: reads the pull requests, builds the batch, proves it once, bisects on failure when asked, and,
 * proven and asked, merges its pull requests in order, each checked by content before and after its merge.
 */
export async function batchMerge(options) {
    const report = { target: null, base: null, prs: [], lots: [], culprits: [], interaction: false, proven: null, merged: [], stopped: null, finalTree: null };
    try {
        return await batchSteps(options, report);
    }
    catch (error) {
        // A Git or GitHub failure the steps did not foresee: the report says where it stopped, never a crash.
        for (const lot of report.lots)
            await removeLot(options, lot).catch(() => undefined);
        report.stopped = { pr: null, reasons: [`erreur inattendue : ${errorMessage(error)}`] };
        options.journal({ event: 'batch-stop', prs: options.prs, target: report.target, pr: null, reasons: report.stopped.reasons });
        return report;
    }
}
async function batchSteps(options, report) {
    const stop = (pr, reasons) => {
        report.stopped = { pr, reasons };
        const failed = options.journal({ event: 'batch-stop', prs: options.prs, target: report.target, pr, reasons });
        if (failed)
            report.stopped.reasons.push(`(journal non écrit : ${failed})`);
        return report;
    };
    for (const n of options.prs) {
        const { pr, error } = await settled(options, n);
        report.prs.push({ number: n, pr, anomalies: error ? [error] : [] });
    }
    const target = options.target ?? report.prs[0]?.pr?.baseRefName ?? null;
    report.target = target;
    if (!target)
        return stop(null, ['cible inconnue : la première PR n\'a pas été lue (--target <branche>)']);
    for (const item of report.prs) {
        if (!item.pr)
            continue;
        // A draft is built into the batch; its status matters only at the merge (--ready).
        item.anomalies.push(...anomalies(item.pr, target, true));
        if (item.pr.headRefName === target)
            item.anomalies.push(`PR #${item.number} part de la branche cible ${target}`);
    }
    if (report.prs.some(p => p.anomalies.length))
        return stop(report.prs.find(p => p.anomalies.length).number, ['lot incohérent avant toute construction', ...report.prs.flatMap(p => p.anomalies)]);
    let base;
    try {
        base = await targetHead(options, target);
    }
    catch (error) {
        return stop(null, [`cible ${target} illisible : ${errorMessage(error)}`]);
    }
    report.base = base.sha;
    const members = [];
    for (const item of report.prs) {
        const head = await fetchHead(options, item.pr);
        if (!head)
            return stop(item.number, [`tête ${item.pr.headRefOid} de la PR #${item.number} introuvable sur ${options.remote} (refs/pull/${item.number}/head)`]);
        members.push({ number: item.number, headRefName: item.pr.headRefName, head });
    }
    // A batch commits its merges: without an identity, a clear refusal before anything is built.
    const ident = await options.git.run(options.repo, ['-c', 'user.useConfigOnly=true', 'var', 'GIT_COMMITTER_IDENT']);
    const author = await options.git.run(options.repo, ['-c', 'user.useConfigOnly=true', 'var', 'GIT_AUTHOR_IDENT']);
    if (!ident.ok || !author.ok)
        return stop(null, [`lot impossible à construire : ${IDENTITY_HINT}`]);
    // Unique name: two batches started in the same second (a batch, then its bisection) never share a branch.
    const base0 = `apv/lot-${stamp((options.now ?? (() => new Date()))())}`;
    let name = base0;
    for (let k = 2; (await options.git.run(options.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok ||
        (options.dir === undefined && existsSync(join(options.common, 'apv', 'lots', name.replace(/\//g, '-')))); k += 1)
        name = `${base0}-${k}`;
    const dir = options.dir ?? join(options.common, 'apv', 'lots', name.replace(/\//g, '-'));
    let counter = 0;
    const prove = async (list, suffix) => {
        const lotName = suffix ? `${name}-${suffix}` : name;
        const lot = await buildLot(options, lotName, suffix ? `${dir}-${suffix}` : dir, base.sha, list);
        report.lots.push(lot);
        if (!lot.members.length) {
            lot.proof = { ok: false, runId: null, summary: 'aucune PR fusionnée dans le lot' };
            return lot;
        }
        options.log(`Lot ${lotName} : ${lot.members.map(m => `#${m.number}`).join(', ')} fusionnées sur ${target} (${short(base.sha)}), tête ${short(lot.head)} ; suite complète.`);
        try {
            lot.proof = await options.prove(lot.dir, lot.head);
        }
        catch (error) {
            lot.proof = { ok: false, runId: null, summary: `preuve impossible : ${errorMessage(error)}` };
        }
        options.log(`Lot ${lotName} : ${lot.proof.ok ? 'prouvé' : 'NON prouvé'} (${lot.proof.summary}).`);
        return lot;
    };
    /** The pull requests of `list` (whose batch failed) that fail the suite, by halves. */
    const culprits = async (list) => {
        if (list.length === 1)
            return [list[0].number];
        const half = Math.ceil(list.length / 2);
        const found = [];
        let failedHalves = 0;
        for (const part of [list.slice(0, half), list.slice(half)]) {
            counter += 1;
            const lot = await prove(part, `b${counter}`);
            if (!lot.proof?.ok) {
                failedHalves += 1;
                found.push(...(lot.members.length ? await culprits(part.filter(m => lot.members.some(x => x.number === m.number))) : []));
            }
            await removeLot(options, lot);
        }
        if (!failedHalves) {
            report.interaction = true;
            return list.map(m => m.number);
        }
        return found;
    };
    const whole = await prove(members, '');
    let proven = whole.proof?.ok ? whole : null;
    if (!proven && options.bisect && whole.members.length > 1) {
        await removeLot(options, whole);
        const inLot = members.filter(m => whole.members.some(x => x.number === m.number));
        report.culprits = await culprits(inLot);
        const rest = inLot.filter(m => !report.culprits.includes(m.number));
        if (!report.interaction && rest.length) {
            const final = await prove(rest, 'final');
            if (final.proof?.ok)
                proven = final;
            else
                await removeLot(options, final);
        }
    }
    report.proven = proven;
    if (!proven) {
        await removeLot(options, whole);
        return stop(null, [report.interaction ? 'la suite échoue sur le lot entier mais passe sur chaque moitié : échec d\'interaction, aucune PR isolée, rien n\'est fusionné'
                : `lot non prouvé${report.culprits.length ? ` ; PR fautive(s) : ${report.culprits.map(n => `#${n}`).join(', ')}` : ''}${options.bisect ? '' : ' (--bisect isole les PR fautives)'}`]);
    }
    if (!options.merge) {
        await removeLot(options, proven);
        return report;
    }
    // Merge, in the order of the proven batch, each one checked by content before and after.
    for (const [k, member] of proven.members.entries()) {
        const expectedBefore = k === 0 ? proven.baseTree : proven.members[k - 1].tree;
        let { pr, error } = await settled(options, member.number);
        if (!pr)
            return stop(member.number, [error]);
        if (pr.headRefOid !== member.head)
            return stop(member.number, [`la tête de la PR #${member.number} a changé depuis le lot (${short(member.head)} prouvée, ${short(pr.headRefOid)} maintenant) : relancer le lot`]);
        if (pr.isDraft) {
            if (!options.ready)
                return stop(member.number, [`PR #${member.number} est un brouillon (--ready retire ce statut avant la fusion, sur ordre de l'opérateur)`]);
            const ready = await options.gh(['pr', 'ready', String(member.number)]);
            options.onCall(ready);
            ({ pr, error } = await settled(options, member.number));
            if (!pr)
                return stop(member.number, [error]);
            if (pr.isDraft)
                return stop(member.number, [`la PR #${member.number} est encore un brouillon après gh pr ready`]);
        }
        const problems = anomalies(pr, target, false);
        if (problems.length)
            return stop(member.number, problems);
        let now;
        try {
            now = await targetHead(options, target);
        }
        catch (error) {
            return stop(member.number, [`cible ${target} illisible : ${errorMessage(error)}`]);
        }
        if (now.tree !== expectedBefore) {
            return stop(member.number, [`la cible ${target} (${short(now.sha)}) n'a plus le contenu du lot avant la PR #${member.number} : elle a changé hors du lot ; relancer le lot sur la nouvelle cible`]);
        }
        const merge = await options.gh(['pr', 'merge', String(member.number), '--merge', '--match-head-commit', member.head]);
        options.onCall(merge);
        let after = await view(options, member.number);
        for (let i = 0; i < options.pollAttempts && after.pr && after.pr.state === 'OPEN' && merge.status === 0; i += 1) {
            await sleep(options.pollMs);
            after = await view(options, member.number);
        }
        if (!after.pr)
            return stop(member.number, [after.error]);
        if (after.pr.state !== 'MERGED')
            return stop(member.number, [`fusion de la PR #${member.number} non constatée : état ${after.pr.state || 'inconnu'} (gh pr merge : ${merge.error ?? `code ${merge.status}`})`]);
        report.merged.push(member.number);
        let landed;
        try {
            landed = await targetHead(options, target);
        }
        catch (error) {
            return stop(member.number, [`cible ${target} illisible après la fusion : ${errorMessage(error)}`]);
        }
        const same = landed.tree === member.tree;
        const failed = options.journal({ event: 'batch-merge', lot: proven.name, pr: member.number, head: member.head, target, targetAfter: landed.sha, lotCommit: member.mergeCommit, sameContent: same });
        if (failed)
            return stop(member.number, [`fusion de la PR #${member.number} faite mais non journalisée (${failed}) : arrêt`]);
        if (!same) {
            return stop(member.number, [`après la fusion de la PR #${member.number}, le contenu de ${target} (${short(landed.sha)}) diffère de celui du lot prouvé (${short(member.mergeCommit)}) : arrêt, rien d'autre n'est fusionné ; comparer par git diff ${short(member.mergeCommit)} ${short(landed.sha)}`]);
        }
    }
    const final = await targetHead(options, target);
    report.finalTree = { target: final.sha, lot: proven.head, identical: final.tree === proven.tree };
    if (!report.finalTree.identical)
        return stop(null, [`arbre final de ${target} (${short(final.sha)}) différent de la tête prouvée du lot (${short(proven.head)})`]);
    await removeLot(options, proven);
    return report;
}
//# sourceMappingURL=batch.js.map