import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { LockStore } from '../lock/store.js';
import { flockFree, resolveStacks } from '../stacks/idle.js';
function git(repo, args) {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 300_000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? errorMessage(r.error) : '') };
}
/** The directory of the fresh copy of `tree` (40 or 64 hexadecimal characters): `<common>/apv/fresh/<16 first>`. */
export const freshCopyDir = (common, tree, slot = '') => join(common, 'apv', 'fresh', `${tree.slice(0, 16)}${slot}`);
/**
 * What a path of `<common>/apv/fresh` is: nothing (`absent`), a worktree registered by Git (`worktree`), a plain directory or file
 * (`plain`), or something never touched (`refuse` with why): a symbolic link (it may point to the work of someone else, a registered
 * and locked worktree of an agent, the main checkout), or a path whose real location is not under `fresh/`.
 */
function copyKind(repo, root, dir) {
    let stat;
    try {
        stat = lstatSync(dir);
    }
    catch {
        return 'absent';
    }
    if (stat.isSymbolicLink())
        return { refuse: 'lien symbolique' };
    let real;
    try {
        real = realpathSync(dir);
    }
    catch {
        return { refuse: 'chemin illisible' };
    }
    let realRoot;
    try {
        realRoot = realpathSync(root);
    }
    catch {
        return { refuse: 'dossier fresh illisible' };
    }
    if (!real.startsWith(`${realRoot}${sep}`))
        return { refuse: `chemin réel hors de ${root}` };
    const listed = git(repo, ['worktree', 'list', '--porcelain']).stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
    const registered = listed.some(w => { try {
        return realpathSync(w) === real;
    }
    catch {
        return false;
    } });
    return registered ? 'worktree' : 'plain';
}
/**
 * Removes a copy of `fresh/`, even one locked (`git worktree lock` by a suite that wanted its copy to stay): unlock first, then
 * remove. Only a real directory under `fresh/` is touched; anything else is left as it is and said. Returns whether it is gone.
 */
function dropCopy(repo, root, dir, log) {
    const kind = copyKind(repo, root, dir);
    if (kind === 'absent')
        return { gone: true };
    if (typeof kind === 'object') {
        log(`Copie ${dir} non touchée : ${kind.refuse} (rien n'est supprimé ; à examiner à la main).`);
        return { gone: false, error: kind.refuse };
    }
    let error;
    if (kind === 'worktree') {
        git(repo, ['worktree', 'unlock', dir]);
        const r = git(repo, ['worktree', 'remove', '--force', '--force', dir]);
        if (r.status !== 0)
            error = r.stderr.trim().slice(0, 200);
    }
    rmSync(dir, { recursive: true, force: true });
    return { gone: !existsSync(dir), ...(error ? { error } : {}) };
}
function lstatSyncOrNull(path) { try {
    lstatSync(path);
    return true;
}
catch {
    return false;
} }
/**
 * Removes the copies left in `<common>/apv/fresh` by an earlier pass (a removal that failed, a pass killed), locked ones included,
 * at the start of `apv release auto`. A copy whose lease is held (another release at work) is left alone. Returns the removed ones.
 */
export async function removeStaleCopies(repo, common, log = () => undefined) {
    const root = join(common, 'apv', 'fresh');
    if (!existsSync(root))
        return [];
    const store = new LockStore(join(common, 'apv', 'locks'));
    const removed = [];
    for (const entry of readdirSync(root)) {
        const name = `fresh-${entry}`;
        const lock = await store.tryAcquire(name, { pid: process.pid, host: store.host, label: `nettoyage de ${entry}` }, 600, 'nettoyage des copies neuves');
        if (!lock.ok)
            continue;
        try {
            const dir = join(root, entry);
            const r = dropCopy(repo, root, dir, log);
            if (r.error && r.gone)
                log(`Copie ${dir} laissée par une passe précédente : retrait forcé après git : ${r.error}`);
            if (r.gone)
                removed.push(dir);
        }
        finally {
            await store.release(name, { token: lock.record.token }).catch(() => undefined);
        }
    }
    if (removed.length)
        git(repo, ['worktree', 'prune']);
    return removed;
}
/**
 * Runs `fn` in the fresh copy of `sha` (made, then removed whatever happens), or returns `busy` when another copy of the
 * same tree is in use. A directory left by an interrupted run is removed first (it is a copy, never a working tree).
 */
export async function withFreshCopy(repo, common, sha, fn, log = () => undefined, slot = '') {
    const tree = git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree))
        throw new PipelineError('GATE_COPY', `arbre du commit ${sha.slice(0, 12)} illisible : copie neuve impossible`);
    const store = new LockStore(join(common, 'apv', 'locks'));
    const name = `fresh-${tree.slice(0, 16)}${slot}`;
    const lock = await store.tryAcquire(name, { pid: process.pid, host: store.host, label: `copie neuve ${sha.slice(0, 12)} (${repo})` }, 12 * 3600, 'copie neuve de la suite complète');
    if (!lock.ok)
        return { busy: `copie neuve de l'arbre ${tree.slice(0, 12)} déjà en cours (verrou ${name} tenu par le pid ${lock.holder?.owner.pid ?? '?'})` };
    const dir = freshCopyDir(common, tree, slot);
    try {
        mkdirSync(join(common, 'apv', 'fresh'), { recursive: true });
        const root = join(common, 'apv', 'fresh');
        if (existsSync(dir) || lstatSyncOrNull(dir)) {
            if (!dropCopy(repo, root, dir, log).gone)
                throw new PipelineError('GATE_COPY', `${dir} existe et n'est pas une copie que l'outil retire (lien, chemin hors de fresh/ ou retrait en échec) : l'examiner puis le retirer à la main`);
            git(repo, ['worktree', 'prune']);
        }
        const added = git(repo, ['worktree', 'add', '--detach', dir, sha]);
        if (added.status !== 0)
            throw new PipelineError('GATE_COPY', `copie neuve ${dir} non créée : ${added.stderr.trim()}`);
        log(`Copie neuve de ${sha.slice(0, 12)} : ${dir} (préparée par batch.setup, retirée à la fin).`);
        try {
            return await fn(dir);
        }
        finally {
            const removed = dropCopy(repo, root, dir, log);
            if (!removed.gone)
                log(`Copie ${dir} non retirée${removed.error ? ` : ${removed.error}` : ''} (git worktree remove --force --force ${dir}).`);
        }
    }
    finally {
        await store.release(name, { token: lock.record.token }).catch(() => undefined);
    }
}
/**
 * The stacks a full suite in a fresh copy is given, as `apv gates run --stacks`: those forced, else the first declared whose
 * lock is free (a lock file held by someone else is busy); none declared: none given (`ids` undefined); all busy: `busy`,
 * with the first declared stack (the release comes back later).
 */
export function pickStacks(config, common, forced) {
    const declared = resolveStacks(config, common);
    if (!declared.length) {
        if (forced)
            throw new PipelineError('STACK_UNKNOWN', '--stacks : aucune pile déclarée (section stacks de .apv/config.json)');
        return { ids: undefined };
    }
    if (forced) {
        const unknown = forced.filter(id => !declared.some(s => s.id === id));
        if (unknown.length)
            throw new PipelineError('STACK_UNKNOWN', `--stacks : pile inconnue ${unknown.join(', ')} (déclarées : ${declared.map(s => s.id).join(', ')})`);
        return { ids: forced };
    }
    const free = declared.find(s => !s.lockFile || flockFree(s.lockFile) !== false);
    return free ? { ids: [free.id] } : { busy: declared.map(s => `${s.id} : verrou ${s.lockFile} tenu`).join(' ; '), first: declared[0].id };
}
//# sourceMappingURL=fresh-copy.js.map