import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sha256 } from '../domain/hash.js';
import { environment } from '../execution/process.js';
const execFileAsync = promisify(execFile);
/**
 * Reuse of a successful check from one commit to another (docs/ACCELERATION-LOTS.md, part A): what a receipt `cached`
 * is checked against. Everything here is recomputed from Git, never read from the receipt.
 */
/** Oldest an origin receipt may be when its reuse is verified (`reuse.maxAgeMs`, 24 h when the check declares nothing). */
export const DEFAULT_REUSE_MAX_AGE_MS = 86_400_000;
/**
 * `apv gates run` reuses an origin only when it is younger than the maximum age minus this margin (4 h): the receipt
 * `cached` must still check out when `apv gates verify` reads it at the end of the suite, of the batch and of its merge.
 */
export const REUSE_AGE_MARGIN_MS = 4 * 3_600_000;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GIT_ENV = () => ({ ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG']), GIT_TERMINAL_PROMPT: '0' });
/**
 * The tree of each commit of `commits` that the repository has (`git log --no-walk --ignore-missing`, one call): a commit
 * the repository does not have, or an object that is not a commit, is absent from the map. Only full hexadecimal SHAs are
 * asked (anything else is left out, never passed to Git).
 */
export async function treesOf(git, repo, commits) {
    const asked = [...new Set([...commits].filter(c => SHA.test(c)))];
    const trees = new Map();
    if (!asked.length)
        return trees;
    const wanted = new Set(asked);
    const parse = (out) => {
        for (const line of out.split('\n')) {
            const [commit, tree] = line.trim().split(' ');
            if (commit && tree && SHA.test(commit) && SHA.test(tree) && wanted.has(commit))
                trees.set(commit, tree);
        }
    };
    const log = (list) => git.exec(repo, ['log', '--no-walk=unsorted', '--ignore-missing', '--format=%H %T', ...list]);
    try {
        parse(await log(asked));
    }
    catch {
        // One object that is not a commit fails the whole call: each commit alone, the unreadable ones left out.
        for (const commit of asked) {
            try {
                parse(await log([commit]));
            }
            catch { /* Not a commit of this repository. */ }
        }
    }
    return trees;
}
/**
 * What Git ignores in a copy and a check still runs with (relecture sécurité de A1, M2, and of its delta, F-D1): the installed
 * dependencies, seen through the folder `node_modules` and the record each package manager writes there at every install
 * (npm, pnpm and its lock of the virtual store, Yarn Berry, Yarn 1), and every `.env*` file of the copy, at any depth (outside
 * `node_modules`, the `.git` of the copy and the worktrees Git has registered, such as those of `.worktrees/`). Two copies of the same tree
 * with other dependencies installed, or another `apps/web/.env.local`, are not the same environment. A `node_modules` with
 * none of these records (installed by another tool, or by hand) cannot be compared: never the same state as any other.
 */
export const LOCAL_STATE_FILES = ['node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml', 'node_modules/.yarn-state.yml', 'node_modules/.yarn-integrity'];
/** Largest file of the local state read for its digest (64 MiB): beyond, its size and date stand for its content. */
const LOCAL_STATE_MAX_BYTES = 64 * 1024 * 1024;
/** Most entries of a copy walked to find its `.env*` files, or its ignored files read: beyond, the state is not comparable. */
const MAX_WALKED = 200_000;
/** Most bytes of ignored files hashed in one copy (1 GiB): beyond, each further file counts by its size and date. */
const MAX_HASHED_BYTES = 1024 * 1024 * 1024;
/** What a path of the local state is: absent, a folder, unreadable, or the sha256 of its content (never the content). */
function stateOf(path) {
    let info;
    try {
        info = statSync(path);
    }
    catch (error) {
        return error.code === 'ENOENT' ? 'absent' : 'illisible';
    }
    if (info.isDirectory())
        return 'dossier';
    if (!info.isFile())
        return 'autre';
    if (info.size > LOCAL_STATE_MAX_BYTES)
        return `taille:${info.size}:${Math.round(info.mtimeMs)}`;
    try {
        return sha256(readFileSync(path));
    }
    catch {
        return 'illisible';
    }
}
/** A value no other measure ever equals: a state that cannot be compared is never the state of an origin. */
const unique = (why) => `${why}:${randomUUID()}`;
/** A path as the file system resolves it (symbolic links followed), or the path itself when it cannot be resolved. */
const realOf = (path) => { try {
    return realpathSync(path);
}
catch {
    return resolve(path);
} };
/**
 * The worktrees Git has registered for the repository of `dir` (`git worktree list --porcelain -z`), real paths, `dir` itself
 * left out: the only folders of a copy that are another copy (relecture sécurité de A2, F1). Their `.env*` files are not
 * those of this copy (envFiles); the state of the copy measures them by their HEAD, their status and their files
 * (copyStateDigest, F1-bis). A folder that merely holds an entry named `.git` (a file or a folder written by a check, a
 * generator, a stray clone) is no worktree. None when Git cannot list them.
 */
export function registeredWorktrees(dir) {
    let out;
    try {
        out = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000, env: GIT_ENV(), stdio: ['ignore', 'pipe', 'ignore'] });
    }
    catch {
        return new Set();
    }
    const self = realOf(dir);
    return new Set(out.split('\0').filter(line => line.startsWith('worktree ')).map(line => realOf(line.slice('worktree '.length))).filter(path => path !== self));
}
/**
 * The `.env*` files of a copy at any depth, relative paths sorted, outside `node_modules`, the `.git` of the copy and the
 * worktrees Git has registered (registeredWorktrees); symbolic links to folders are not followed. Null beyond MAX_WALKED.
 */
function envFiles(dir) {
    const worktrees = registeredWorktrees(dir);
    const found = [];
    const stack = [''];
    let walked = 0;
    while (stack.length) {
        const rel = stack.pop();
        let entries;
        try {
            entries = readdirSync(join(dir, rel), { withFileTypes: true });
        }
        catch {
            found.push(`${rel}(dossier illisible)`);
            continue;
        }
        if (rel && worktrees.size && entries.some(e => e.name === '.git') && worktrees.has(realOf(join(dir, rel))))
            continue;
        for (const entry of entries) {
            if ((walked += 1) > MAX_WALKED)
                return null;
            const path = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.name.startsWith('.env'))
                found.push(path);
            if (entry.isDirectory() && entry.name !== 'node_modules' && path !== '.git')
                stack.push(path);
        }
    }
    return found.sort();
}
/**
 * Digest of the local state of a copy (LOCAL_STATE_FILES, `node_modules` present or not, each `.env*` at any depth), part
 * of the identity of the environment of every receipt: a check is reused only from an origin that ran with the same local
 * state. Contents are hashed, one digest for all: no value of a `.env*` file is ever written, in a receipt or an output.
 */
export function localStateDigest(dir) {
    const modules = stateOf(join(dir, 'node_modules'));
    const entries = [['node_modules', modules]];
    const records = LOCAL_STATE_FILES.map(file => [file, stateOf(join(dir, file))]);
    entries.push(...records);
    if (modules === 'dossier' && records.every(([, state]) => state === 'absent'))
        entries.push(['node_modules sans enregistrement', unique('non comparable')]);
    const names = envFiles(dir);
    if (names === null)
        entries.push(['.env*', unique(`plus de ${MAX_WALKED} entrées`)]);
    else
        for (const name of names)
            entries.push([name, stateOf(join(dir, name))]);
    return sha256(JSON.stringify({ version: 2, entries }));
}
/** The files Git ignores in a copy, folders collapsed (`git ls-files --others --ignored --exclude-standard --directory`). */
async function ignoredEntries(dir) {
    const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { cwd: dir, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 120_000, env: GIT_ENV() });
    return stdout.toString('utf8').split('\0').filter(Boolean).sort();
}
/** Ignored paths left out of the state of a copy: the receipts of APV (written by the run itself), and `node_modules` (LOCAL_STATE_FILES). */
const outOfCopyState = (path) => path === '.apv/receipts/' || path.startsWith('.apv/receipts/') || path.split('/').includes('node_modules') || path === '.git' || path.startsWith('.git/');
/**
 * Digest of what Git ignores in a copy when a run starts there (att8 of the relecture of A1: a generated folder such as
 * `.svelte-kit`, a build left by an earlier run): every ignored file outside `node_modules` (LOCAL_STATE_FILES), `.git` and
 * `.apv/receipts/`, by its path and the sha256 of its content (a symbolic link by its target; beyond 64 MiB, or 1 GiB hashed
 * in all, by its size and date); each worktree Git has registered inside the copy, by its HEAD and its status too, its files
 * walked like the others (F1-bis); each submodule by its HEAD and its status (D2). Measured once per copy, before the first
 * check runs there: an origin is reused only by a copy that starts from the same ignored state (a fresh copy of a batch,
 * prepared by the same batch.setup, does). Not comparable (never equal) when Git cannot list it or the copy holds more than
 * MAX_WALKED entries.
 */
export async function copyStateDigest(dir) {
    let listed;
    try {
        listed = await ignoredEntries(dir);
    }
    catch (error) {
        return sha256(unique(`git ls-files : ${error.message}`));
    }
    const worktrees = registeredWorktrees(dir);
    const entries = [];
    let walked = 0;
    let hashed = 0;
    const fileState = (path) => {
        let info;
        try {
            info = lstatSync(path);
        }
        catch {
            return 'illisible';
        }
        if (info.isSymbolicLink()) {
            try {
                return `lien:${readlinkSync(path)}`;
            }
            catch {
                return 'lien illisible';
            }
        }
        if (!info.isFile())
            return info.isDirectory() ? 'dossier' : 'autre';
        if (info.size > LOCAL_STATE_MAX_BYTES || hashed + info.size > MAX_HASHED_BYTES)
            return `taille:${info.size}:${Math.round(info.mtimeMs)}`;
        hashed += info.size;
        try {
            return sha256(readFileSync(path));
        }
        catch {
            return 'illisible';
        }
    };
    // Files only (a folder counts through the files it holds), each once: Git may list a folder and some of its files.
    const seen = new Set();
    const stack = listed.filter(path => !outOfCopyState(path)).reverse();
    while (stack.length) {
        if ((walked += 1) > MAX_WALKED)
            return sha256(unique(`plus de ${MAX_WALKED} entrées ignorées`));
        const rel = stack.pop();
        if (seen.has(rel))
            continue;
        seen.add(rel);
        if (!rel.endsWith('/')) {
            entries.push([rel, fileState(join(dir, rel))]);
            continue;
        }
        let children;
        try {
            children = readdirSync(join(dir, rel), { withFileTypes: true });
        }
        catch {
            entries.push([rel, 'dossier illisible']);
            continue;
        }
        // A worktree Git has registered inside the copy (`.worktrees/x`, or `.svelte-kit` made one by `git worktree add`): its HEAD
        // and its status count too (relecture sécurité du delta de A2, F1-bis), and its files are walked like those of any other
        // folder, its `.git` entry included (F1): it is never left out without being measured.
        if (worktrees.size && children.some(e => e.name === '.git') && worktrees.has(realOf(join(dir, rel))))
            entries.push([`${rel}(worktree)`, checkoutState(join(dir, rel))]);
        for (const child of children.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))) {
            const path = `${rel}${child.name}${child.isDirectory() ? '/' : ''}`;
            if (!outOfCopyState(path))
                stack.push(path);
        }
    }
    // Each submodule of the copy (D2 of the delta review of A2): its HEAD and its status, whatever `.gitmodules` says (`ignore = all`).
    for (const path of submodulePaths(dir))
        entries.push([`${path}(sous-module)`, existsSync(join(dir, path, '.git')) ? checkoutState(join(dir, path)) : 'non extrait']);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return sha256(JSON.stringify({ version: 2, entries }));
}
/** Runs git in `dir` (hooks and the file system monitor off), its output as bytes; throws when it fails. */
const gitIn = (dir, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: dir, maxBuffer: 256 * 1024 * 1024, timeout: 120_000, env: GIT_ENV(), stdio: ['ignore', 'pipe', 'ignore'] });
/**
 * The state of a checkout inside a copy, a worktree Git has registered or a submodule: its HEAD and the sha256 of its
 * `git status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none` (never the content of a file: the walk of the
 * copy reads those). Not comparable (never equal) when Git cannot read it.
 */
export function checkoutState(dir) {
    try {
        const head = gitIn(dir, ['rev-parse', '--verify', '-q', 'HEAD']).toString('utf8').trim();
        const status = gitIn(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
        return `${head}:${sha256(status)}`;
    }
    catch {
        return unique('extraction illisible');
    }
}
/** The paths of the submodules of a copy (`git ls-files --stage`, mode 160000), sorted; none when Git cannot list them. */
function submodulePaths(dir) {
    let out;
    try {
        out = gitIn(dir, ['ls-files', '--stage', '-z']).toString('utf8');
    }
    catch {
        return [];
    }
    return [...new Set(out.split('\0').filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1)))].sort();
}
/** Digest of a list of ignore globs (`reuse.ignoreDigest`): sorted and deduplicated, so their order never matters. */
export function ignoreDigest(globs) {
    return sha256(JSON.stringify([...new Set(globs)].sort()));
}
export const inputsCache = () => ({ entries: new Map() });
/** `git ls-tree` output as raw bytes: a path that is not valid UTF-8 is never decoded with loss. */
async function lsTreeBytes(repo, commit) {
    const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'ls-tree', '-r', '-z', '--full-tree', '--end-of-options', `${commit}^{tree}`], { cwd: repo, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 120_000, env: GIT_ENV() });
    return stdout;
}
/** Every file of the tree of `commit` (submodules included), sorted by the bytes of its path. Fails when the commit is not in the repository. */
async function readTreeEntries(repo, commit) {
    const out = await lsTreeBytes(repo, commit);
    const entries = [];
    let start = 0;
    while (start < out.length) {
        let end = out.indexOf(0, start);
        if (end < 0)
            end = out.length;
        const entry = out.subarray(start, end);
        start = end + 1;
        if (!entry.length)
            continue;
        const tab = entry.indexOf(0x09);
        const [mode, , blob] = entry.subarray(0, tab).toString('latin1').split(' ');
        entries.push({ path: entry.subarray(tab + 1), mode: mode, blob: blob });
    }
    return entries.sort((a, b) => Buffer.compare(a.path, b.path));
}
/** The files of the tree of `commit`, read once per cache (a failure is kept too: the commit stays unreadable). */
function treeEntries(repo, commit, cache) {
    if (!cache)
        return readTreeEntries(repo, commit);
    if (!cache.entries.has(commit))
        cache.entries.set(commit, readTreeEntries(repo, commit));
    return cache.entries.get(commit);
}
/** The digest of a list of entries: sha256 of the JSON of `[hex of the path, mode, object]`. */
const digestOf = (entries) => sha256(JSON.stringify(entries.map(e => [e.path.toString('hex'), e.mode, e.blob])));
/**
 * Digest of the inputs of a check at `commit` (`reuse.inputsDigest`): sha256 of the JSON of the list of `[path, mode, blob]`
 * of the tracked files of its tree (submodules included), sorted by the bytes of the path. The path enters the digest as the
 * hexadecimal of its raw bytes, read from Git without any decoding: two different paths (a line feed or a tab in a name, or
 * bytes that are not UTF-8, such as `f` followed by 0xff or by 0xfe) never share an encoding. Two commits have the same digest
 * exactly when they have the same tree content. Fails when the commit is not in the repository. Nothing is ignored: the reuse
 * by inputs (`reuse.ignore`) is disabled until its declaration is proven (INPUTS_REUSE_DISABLED, src/gates/reuse-proof.ts).
 */
export async function inputsDigest(_git, repo, commit, cache) {
    const inputs = await treeEntries(repo, commit, cache);
    return { digest: digestOf(inputs), files: inputs.length };
}
//# sourceMappingURL=reuse.js.map