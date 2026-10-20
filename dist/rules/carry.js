import { spawnSync } from 'node:child_process';
import { DELTA_DIFF, DELTA_GIT, gitRead } from '../run/git-probe.js';
/**
 * Reviews carried over a head that only brings its base up to date (pilot project, #230: a pull request updated by
 * `git merge origin/main`, its diff unchanged byte for byte, asked again for its four reviews).
 *
 * A review recorded at the head T1 counts for the head T2 only when all of this holds:
 * - T2 is a merge commit with two parents: T1, and B2, a commit of the target (an ancestor of it, so already merged
 *   under the rules) that descends from B1, the fork point of T1 with the target;
 * - the diff B2..T2 is the diff B1..T1, byte for byte (`git diff --full-index --binary`: the blobs before and after each
 *   file are in it, so a file of the diff the base changed, or a change the merge brings of its own, breaks it);
 * - no file of the diff differs between B1 and B2 (implied by the above, checked on its own).
 *
 * Why it opens no way around the reviews: the tree of T2 is then the tree B2 plus the reviewed change, which is exactly
 * what merging T1 into a target at B2 gives; the tool already lets T1 merge into a target that moved since its reviews
 * (the reviews are tied to the head, not to the target). A base that changes what the code does without touching the
 * files of the diff was merged under the rules itself, and is merged into T1 the same way either way. The proof (full
 * suite at the exact commit) is never carried: it stays required at T2.
 *
 * Followed over a chain of such updates (T0 → T1 → T2), five at most.
 */
const MAX_CHAIN = 5;
/** Whether `ancestor` is an ancestor of `of` (or the same commit). */
export function isAncestor(repo, ancestor, of) {
    return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'merge-base', '--is-ancestor', ancestor, of], { cwd: repo, stdio: 'ignore', timeout: 30_000 }).status === 0;
}
/** The diff between two commits as git writes it, byte for byte, with full blob ids; null when unreadable. */
function diffBytes(repo, from, to) {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', ...DELTA_GIT, 'diff', ...DELTA_DIFF, '--full-index', '--binary', '--no-color', from, to], { cwd: repo, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 && !r.error ? r.stdout : null;
}
const SUBMODULE_MODE = '160000';
/**
 * The files of the delta between two commits, both sides of a rename, every submodule seen. Refused (security review
 * of #141, A1) when Git cannot read it, when a submodule link (mode 160000) changes in it (what the link brings is
 * another repository the tool does not read), or when the two trees differ and no file is listed: a delta that hides
 * what it changes carries no review, no captures and no waiver.
 */
export function deltaFiles(repo, from, to) {
    const refused = (cause) => ({ files: null, problem: `delta illisible : ${cause} ; relecture complète exigée`, cause });
    const span = `${from.slice(0, 12)}..${to.slice(0, 12)}`;
    const raw = gitRead(repo, [...DELTA_GIT, 'diff', ...DELTA_DIFF, '--raw', '-z', '--no-abbrev', from, to, '--']);
    if (raw === null)
        return refused(`git diff ${span} a échoué`);
    // `:<old mode> <new mode> <old blob> <new blob> <status>\0<path>\0`, one entry per file (no rename: one path).
    const parts = raw.split('\0');
    if (parts.at(-1) === '')
        parts.pop();
    if (parts.length % 2 !== 0)
        return refused(`sortie de git diff ${span} illisible`);
    const files = [];
    const links = [];
    for (let k = 0; k < parts.length; k += 2) {
        const head = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*$/.exec(parts[k]);
        if (!head)
            return refused(`sortie de git diff ${span} illisible`);
        const path = parts[k + 1];
        if (head[1] === SUBMODULE_MODE || head[2] === SUBMODULE_MODE)
            links.push(path);
        files.push(path);
    }
    if (links.length)
        return refused(`lien de sous-module changé (${links.slice(0, 3).join(', ')}${links.length > 3 ? ', ...' : ''}), son contenu n'est pas lu`);
    if (!files.length) {
        const trees = [from, to].map(c => gitRead(repo, ['rev-parse', '--verify', '--quiet', `${c}^{tree}`]));
        if (!trees[0] || !trees[1])
            return refused(`arbres de ${span} illisibles`);
        if (trees[0] !== trees[1])
            return refused(`arbres différents entre ${from.slice(0, 12)} et ${to.slice(0, 12)} mais aucun fichier listé`);
    }
    return { files, problem: null, cause: null };
}
/** The files of a diff between two commits, every submodule seen; null when unreadable. */
function diffFiles(repo, from, to) {
    const raw = gitRead(repo, [...DELTA_GIT, 'diff', ...DELTA_DIFF, '--name-only', '-z', from, to, '--']);
    return raw === null ? null : raw.split('\0').filter(Boolean);
}
/** The head T1 whose reviews count for `head` (one update with the base), with the commit of the target merged; or null. */
export function carriedHeadOnce(repo, head, target) {
    const parents = gitRead(repo, ['rev-list', '--parents', '-n', '1', head])?.split(/\s+/).slice(1) ?? [];
    if (parents.length !== 2)
        return null;
    for (const [t1, b2] of [[parents[0], parents[1]], [parents[1], parents[0]]]) {
        if (!isAncestor(repo, b2, target))
            continue;
        const b1 = gitRead(repo, ['merge-base', t1, target]);
        if (!b1 || b1 === b2 || !isAncestor(repo, b1, b2) || isAncestor(repo, t1, b2))
            continue;
        const before = diffBytes(repo, b1, t1);
        const after = diffBytes(repo, b2, head);
        if (!before || !after || before.length === 0 || !before.equals(after))
            continue;
        const files = diffFiles(repo, b1, t1);
        if (!files || !files.length)
            continue;
        const moved = gitRead(repo, [...DELTA_GIT, 'diff', ...DELTA_DIFF, '--name-only', '-z', b1, b2, '--', ...files.map(f => `:(literal)${f}`)]);
        if (moved === null || moved.length)
            continue;
        return { from: t1, base: b2 };
    }
    return null;
}
/** The heads whose reviews count for `head`, nearest first (T1, then T0...): empty when `head` is no such update. */
export function carriedHeads(repo, head, target) {
    if (!target)
        return [];
    const out = [];
    let at = head;
    for (let k = 0; k < MAX_CHAIN; k += 1) {
        const step = carriedHeadOnce(repo, at, target);
        if (!step)
            break;
        out.push(step.from);
        at = step.from;
    }
    return out;
}
/** Commits of the pull request walked back from its head to find an earlier review or waiver (docs/ACCELERATION-LOTS.md, 6.2). */
export const MAX_REPORT_WALK = 10;
/**
 * The commits of the pull request below `head`, nearest first: first parent after first parent, a merge of the target
 * carried by carry.ts followed to the head it carries, MAX_REPORT_WALK steps at most, never a commit of the target (an
 * ancestor of it holds the reviews of another change). Empty without a target. A commit that is not an ancestor of the
 * head (a rebase) is never in it: nothing is carried to a rewritten history.
 */
export function prChain(repo, head, target, max = MAX_REPORT_WALK) {
    if (!target)
        return [];
    const out = [];
    let at = head;
    let links = [];
    for (let k = 0; k < max; k += 1) {
        const step = carriedHeadOnce(repo, at, target);
        if (step) {
            at = step.from;
            out.push({ commit: at, links: [...links] });
            continue;
        }
        const parent = gitRead(repo, ['rev-list', '--parents', '-n', '1', at])?.split(/\s+/)[1];
        if (!parent || isAncestor(repo, parent, target))
            break;
        links = [...links, { from: parent, to: at }];
        out.push({ commit: parent, links });
        at = parent;
    }
    return out;
}
/**
 * The spans of a chain node: each run of links that follow one another (a carried merge cuts the run), as one change from
 * the bottom of the run to its top. Without a carried merge, the one span is C..head.
 */
export function chainSpans(links) {
    const spans = [];
    for (const link of links) {
        const last = spans.at(-1);
        if (last && last.from === link.to)
            last.from = link.from;
        else
            spans.push({ ...link });
    }
    return spans;
}
//# sourceMappingURL=carry.js.map