import { spawnSync } from 'node:child_process';
import { gitRead } from '../run/git-probe.js';
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
function isAncestor(repo, ancestor, of) {
    return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'merge-base', '--is-ancestor', ancestor, of], { cwd: repo, stdio: 'ignore', timeout: 30_000 }).status === 0;
}
/** The diff between two commits as git writes it, byte for byte, with full blob ids; null when unreadable. */
function diffBytes(repo, from, to) {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', 'diff', '--full-index', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', from, to], { cwd: repo, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 && !r.error ? r.stdout : null;
}
/** The files of a diff between two commits; null when unreadable. */
function diffFiles(repo, from, to) {
    const raw = gitRead(repo, ['diff', '--name-only', '-z', '--no-renames', from, to]);
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
        const moved = gitRead(repo, ['diff', '--name-only', '-z', '--no-renames', b1, b2, '--', ...files.map(f => `:(literal)${f}`)]);
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
//# sourceMappingURL=carry.js.map