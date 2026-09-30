import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Git } from '../execution/git.js';
import { PipelineError } from '../domain/errors.js';
import { worktreeFiles } from '../knowledge/inventory.js';
import { resolveCommit, resolveFullRef } from '../run/git-probe.js';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Content of a working tree file, or null when it is unreadable, binary-looking or larger than 2 MB. */
export function readWorktree(repo, path) {
    try {
        const full = join(repo, path);
        if (statSync(full).size > MAX_FILE_BYTES)
            return null;
        const text = readFileSync(full, 'utf8');
        return text.includes('\0') ? null : text;
    }
    catch {
        return null;
    }
}
/** The line is added or modified by the change (always true without base, and in a created file). */
export function isAdded(changes, path, line) {
    if (changes.all || changes.created.has(path))
        return true;
    return changes.added.get(path)?.has(line) ?? false;
}
/** Resolves the base of the comparison: `--base` (any commit-ish), else the configured reference (full ref), else none. */
export function resolveBase(repo, option, reference) {
    if (option !== undefined) {
        const sha = resolveCommit(repo, option);
        if (!sha)
            throw new PipelineError('REUSE_BASE', `--base ${option} : commit introuvable dans ce dépôt.`);
        return { source: 'option', ref: option, sha };
    }
    if (reference !== null) {
        const { sha, reason } = resolveFullRef(repo, reference);
        if (!sha)
            throw new PipelineError('REUSE_BASE', `reuse.reference « ${reference} » ${reason} : récupérez-la (git fetch) ou corrigez .apv/config.json. Sans elle, le contrôle ne sait pas ce que le changement ajoute.`);
        return { source: 'reference', ref: reference, sha };
    }
    return { source: 'none', ref: null, sha: null };
}
/** Unquotes a path as `git diff` prints it (C-style quotes when it has unusual characters). */
function unquote(path) {
    if (!path.startsWith('"'))
        return path;
    try {
        return JSON.parse(path);
    }
    catch {
        return path.slice(1, -1);
    }
}
/** Added lines per file from a `git diff -U0` output. */
export function parseAddedLines(diff) {
    const added = new Map();
    let current = null;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ ')) {
            const target = line.slice(4);
            if (target === '/dev/null') {
                current = null;
                continue;
            }
            const path = unquote(target).replace(/^b\//, '');
            current = added.get(path) ?? new Set();
            added.set(path, current);
            continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && current) {
            const start = Number(hunk[1]);
            const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
            for (let i = 0; i < count; i++)
                current.add(start + i);
        }
    }
    return added;
}
/** Changes of the working tree since the merge base of `baseSha` and HEAD. */
export async function collectChanges(repo, base, git = new Git()) {
    const files = await worktreeFiles(repo);
    if (!base.sha)
        return { base: { source: 'none', ref: null, mergeBase: null }, files, all: true, added: new Map(), created: new Set(), renamed: new Map() };
    const head = await git.sha(repo);
    let mergeBase;
    try {
        mergeBase = (await git.exec(repo, ['merge-base', base.sha, head])).trim();
    }
    catch {
        mergeBase = '';
    }
    if (!/^[0-9a-f]{40,64}$/.test(mergeBase)) {
        throw new PipelineError('REUSE_BASE', `aucune base commune entre ${base.ref} et HEAD : clone superficiel (git fetch --unshallow, ou un clone avec l'historique) ou historiques sans lien. Sans elle, le contrôle ne sait pas ce que le changement ajoute.`);
    }
    const diff = await git.exec(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '-M', '--src-prefix=a/', '--dst-prefix=b/', mergeBase, '--']);
    const status = (await git.exec(repo, ['diff', '--name-status', '-z', '-M', mergeBase, '--'])).split('\0');
    const created = new Set();
    const renamed = new Map();
    for (let i = 0; i < status.length;) {
        const code = status[i] ?? '';
        if (!code) {
            i++;
            continue;
        }
        if (code.startsWith('R') || code.startsWith('C')) {
            const from = status[i + 1];
            const to = status[i + 2];
            if (from && to) {
                if (code.startsWith('R'))
                    renamed.set(to, from);
                else
                    created.add(to);
            }
            i += 3;
        }
        else {
            const path = status[i + 1];
            if (path && code === 'A')
                created.add(path);
            i += 2;
        }
    }
    const untracked = (await git.exec(repo, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
    for (const path of untracked)
        created.add(path);
    return { base: { source: base.source, ref: base.ref, mergeBase }, files, all: false, added: parseAddedLines(diff), created, renamed };
}
/** Content of a file at the merge base (following a rename), or null when it did not exist there. */
export function readAtBase(repo, changes, path, read) {
    if (!changes.base.mergeBase || changes.created.has(path))
        return null;
    const old = changes.renamed.get(path) ?? path;
    return read(repo, `${changes.base.mergeBase}:${old}`);
}
//# sourceMappingURL=changes.js.map