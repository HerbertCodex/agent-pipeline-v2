import { loadConfigAtCommit } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { planRepeat } from '../gates/repeat.js';
import { reuseConfigChanges } from '../reuse/check.js';
async function must(git, cwd, args) {
    const r = await git.run(cwd, args);
    if (!r.ok)
        throw new Error(`git ${args.join(' ')} : ${r.stderr.trim().slice(-600) || 'échec'}`);
    return r.stdout.trim();
}
/** The head of pull request `n` as a local commit: `refs/pull/<n>/head` fetched, else the commit itself. */
async function fetchHead(input, n, head) {
    const { git, repo, remote } = input;
    if ((await git.run(repo, ['cat-file', '-e', `${head}^{commit}`])).ok)
        return;
    await git.run(repo, ['fetch', '--no-tags', remote, `refs/pull/${n}/head`]);
    if ((await git.run(repo, ['cat-file', '-e', `${head}^{commit}`])).ok)
        return;
    await git.run(repo, ['fetch', '--no-tags', remote, head]);
    await must(git, repo, ['cat-file', '-e', `${head}^{commit}`]);
}
export async function stackChecks(input) {
    const empty = { read: false, error: null, gates: [], stages: [], parts: [], alone: [], reuseConfig: [] };
    let target;
    let config;
    try {
        await must(input.git, input.repo, ['fetch', '--no-tags', input.remote, `+refs/heads/${input.target}:refs/remotes/${input.remote}/${input.target}`]);
        target = await must(input.git, input.repo, ['rev-parse', `refs/remotes/${input.remote}/${input.target}^{commit}`]);
        for (const pr of input.prs)
            await fetchHead(input, pr.number, pr.head);
        config = loadConfigAtCommit(input.repo, target).config;
    }
    catch (error) {
        return { ...empty, error: errorMessage(error) };
    }
    const git = new Git(input.signal);
    const repeating = config.gates.filter(g => g.repeatChanged).map(g => ({ id: g.id, settings: g.repeatChanged }));
    const out = { ...empty, read: true, gates: repeating.map(g => ({ id: g.id, max: g.settings.maxFiles })) };
    const count = async (base, head) => {
        const counts = [];
        for (const g of repeating)
            counts.push({ gate: g.id, files: (await planRepeat(git, input.repo, { base }, g.settings, head)).files.length, max: g.settings.maxFiles });
        return counts;
    };
    const overOf = (counts) => counts.filter(c => c.files > c.max);
    try {
        // Each stage from the target: what the suite of the top of the stack, at that height, repeats.
        for (const pr of input.prs) {
            const counts = await count(target, pr.head);
            out.stages.push({ pr: pr.number, head: pr.head, counts, over: overOf(counts).length > 0 });
        }
        // The cut: a part ends before the stage that would put it over a ceiling; the next part starts from the head
        // before it (merged by then into the target).
        let start = 0;
        let part = [];
        for (let j = 0; j < input.prs.length; j += 1) {
            const from = start === 0 ? target : input.prs[start - 1].head;
            let over = overOf(await count(from, input.prs[j].head));
            if (over.length && part.length) {
                out.parts.push(part);
                part = [];
                start = j;
                over = overOf(await count(j === 0 ? target : input.prs[j - 1].head, input.prs[j].head));
            }
            if (over.length) {
                out.alone.push(...over.map(c => ({ pr: input.prs[j].number, gate: c.gate, files: c.files, max: c.max })));
                out.parts.push([input.prs[j].number]);
                part = [];
                start = j + 1;
                continue;
            }
            part.push(input.prs[j].number);
        }
        if (part.length)
            out.parts.push(part);
    }
    catch (error) {
        return { ...out, read: false, error: `comptage des tests modifiés impossible : ${errorMessage(error)}` };
    }
    // The watched configuration, pull request by pull request against its own base (the target for the first one).
    for (const [i, pr] of input.prs.entries()) {
        try {
            const from = i === 0 ? await must(input.git, input.repo, ['merge-base', target, pr.head]) : input.prs[i - 1].head;
            const changes = reuseConfigChanges(loadConfigAtCommit(input.repo, from).config, loadConfigAtCommit(input.repo, pr.head).config);
            if (changes.length)
                out.reuseConfig.push({ pr: pr.number, changes });
        }
        catch (error) {
            out.reuseConfig.push({ pr: pr.number, changes: [`configuration illisible : ${errorMessage(error)}`] });
        }
    }
    return out;
}
/** Lines of the report of `apv stack plan` about the code of the stack. */
export function stackChecksLines(checks, stackSize) {
    if (!checks.read)
        return [`Tests modifiés et configuration : non lus (${checks.error ?? 'raison inconnue'}).`];
    const lines = [];
    if (checks.gates.length) {
        lines.push(`Tests modifiés par étage (depuis la cible ; plafond repeatChanged.maxFiles : ${checks.gates.map(g => `${g.id} ${g.max}`).join(', ')}) :`);
        for (const stage of checks.stages) {
            lines.push(`  PR #${stage.pr} : ${stage.counts.map(c => `${c.gate} ${c.files}`).join(', ')}${stage.over ? ' : AU-DELÀ DU PLAFOND' : ''}`);
        }
        if (checks.stages.some(s => s.over)) {
            lines.push(`ATTENTION : la suite complète du sommet serait refusée (repeatChanged.maxFiles). Coupe proposée, chaque partie prouvée et fusionnée avant la suivante : ` +
                `${checks.parts.map(p => p.map(n => `#${n}`).join(' ')).join(' | ')}.`);
        }
        for (const a of checks.alone)
            lines.push(`ATTENTION : PR #${a.pr} seule au-delà du plafond de ${a.gate} (${a.files} fichiers de test, plafond ${a.max}) : la découper, aucune coupe de la pile ne suffit.`);
    }
    for (const r of checks.reuseConfig) {
        lines.push(stackSize > 1
            ? `ATTENTION : PR #${r.pr} change la configuration surveillée par reuse : à fusionner seule d'abord (apv stack plan ${r.pr}, sa preuve, apv stack merge ${r.pr}), puis le reste de la pile sur la nouvelle cible. ${r.changes.join(' ')}`
            : `Note : PR #${r.pr} change la configuration surveillée par reuse (PR de configuration, seule) : ${r.changes.join(' ')}`);
    }
    return lines;
}
//# sourceMappingURL=plan-checks.js.map