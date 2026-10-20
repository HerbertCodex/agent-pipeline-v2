import { existsSync, lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { invariant, PipelineError } from '../domain/errors.js';
import { runProcess, environment } from './process.js';
export function isInside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel));
}
export class Git {
    signal;
    hooks;
    constructor(signal, hooks = {}) {
        this.signal = signal;
        this.hooks = hooks;
    }
    async exec(cwd, args) {
        const result = await runProcess({
            // No fsmonitor: the controller must not start background daemons in disposable worktrees.
            // No author is forced: a commit goes through `commit()`, which passes the repository's own identity.
            // useConfigOnly makes any other commit fail instead of letting Git guess an identity from the host.
            command: ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-c', 'user.useConfigOnly=true', ...args],
            cwd, env: { ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG']), GIT_TERMINAL_PROMPT: '0' },
            timeoutMs: 120000, ...(this.signal ? { signal: this.signal } : {}), ...this.hooks, maxOutputBytes: 16 * 1024 * 1024,
        });
        if (result.status !== 'passed')
            throw new PipelineError(result.status === 'cancelled' ? 'CANCELLED' : 'GIT', `git ${args[0]}: ${result.status}: ${result.stderr.slice(-3000)}`);
        invariant(!result.truncated, 'GIT_OUTPUT', 'Git output exceeded limit; refusing an incomplete diff');
        return result.stdout;
    }
    /**
     * Reads one Git configuration value. Unlike every mutating Git call, this one passes HOME (and the
     * config overrides Git itself documents), because the operator identity used for an approval usually
     * lives in the global ~/.gitconfig, not in the repository. Without it the identity fallback could never
     * succeed and every approval had to repeat --reviewer.
     */
    async configValue(repo, key) {
        const result = await runProcess({ command: ['git', 'config', '--get', key], cwd: repo,
            env: environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG', 'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']), timeoutMs: 10000,
            ...(this.signal ? { signal: this.signal } : {}), ...this.hooks, maxOutputBytes: 65536 });
        if (result.status === 'passed')
            return result.stdout.trim() || null;
        if (result.exitCode === 1)
            return null;
        throw new PipelineError(result.status === 'cancelled' ? 'CANCELLED' : 'GIT', `git config: ${result.status}: ${result.stderr.slice(-1000)}`);
    }
    /**
     * The identity Git itself would use for a commit in this repository (`user.name` and `user.email`, from
     * the repository, global or system configuration). There is no invented fallback: a commit authored by an
     * address that belongs to nobody is refused by hosts that check authors (a Vercel preview deployment is
     * blocked when the commit author is not a team member).
     */
    async identity(repo) {
        const name = await this.configValue(repo, 'user.name');
        const email = await this.configValue(repo, 'user.email');
        if (name && email)
            return { name, email };
        const missing = [name ? null : 'user.name', email ? null : 'user.email'].filter(Boolean).join(' et ');
        throw new PipelineError('GIT_IDENTITY', `Aucune identité Git configurée (${missing} absent) : l'outil commite sous l'identité du dépôt et n'en invente pas. `
            + `Configurez-la puis relancez : git config user.name "Votre Nom" && git config user.email "vous@exemple.fr" (ajoutez --global pour tous vos dépôts).`);
    }
    /**
     * Commits as `identity` (author and committer), never as an invented author. The tool that made the
     * commit is recorded as a `Generated-by` trailer (last paragraph), so `git log` still tells it apart.
     */
    async commit(repo, identity, message, paths) {
        const trailers = [`Generated-by: ${message.generatedBy}`, ...Object.entries(message.trailers ?? {}).map(([k, v]) => `${k}: ${v}`)].join('\n');
        await this.exec(repo, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '--no-verify', '-m', message.subject,
            ...(message.body ? ['-m', message.body] : []), '-m', trailers, ...(paths ? ['--', ...paths] : [])]);
        return this.sha(repo);
    }
    async root(path) { return realpathSync((await this.exec(resolve(path), ['rev-parse', '--show-toplevel'])).trim()); }
    async sha(repo, ref = 'HEAD') {
        const sha = (await this.exec(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
        invariant(/^[a-f0-9]{40,64}$/.test(sha), 'SHA', 'Invalid commit SHA');
        return sha;
    }
    async clean(repo, expectedSha) {
        const status = await this.exec(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        invariant(status === '', 'DIRTY', `Workspace contains uncommitted files: ${status.slice(0, 1000)}`);
        if (expectedSha)
            invariant(await this.sha(repo) === expectedSha, 'CANDIDATE_MOVED', 'Workspace HEAD no longer matches the candidate');
    }
    /** True when `commit` already contains `ancestor`; false when it does not, or is unknown here. */
    async contains(repo, commit, ancestor) {
        try {
            await this.exec(repo, ['merge-base', '--is-ancestor', ancestor, commit]);
            return true;
        }
        catch {
            return false;
        }
    }
    async compatible(repo, sha) {
        const tree = await this.exec(repo, ['ls-tree', '-r', '-z', sha]);
        for (const entry of tree.split('\0').filter(Boolean)) {
            invariant(!entry.startsWith('160000 '), 'SUBMODULE', 'Submodules require an explicit materializer; unsupported in this alpha');
            invariant(!entry.startsWith('120000 '), 'SYMLINK', 'Tracked symlinks are not accepted by this local alpha');
        }
    }
    async workspace(repo, path, sha) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (existsSync(path)) {
            await this.clean(path, sha);
            return;
        }
        await this.exec(repo, ['worktree', 'add', '--detach', path, sha]);
        await this.clean(path, sha);
    }
    async removeWorkspace(repo, path, ownedRoot) {
        invariant(isInside(ownedRoot, path) && resolve(path) !== resolve(ownedRoot), 'WORKSPACE_PATH', 'Refusing to remove outside owned workspace root');
        if (!existsSync(path))
            return;
        invariant(!lstatSync(path).isSymbolicLink() && isInside(realpathSync(ownedRoot), realpathSync(path)), 'WORKSPACE_PATH', 'Workspace redirects outside owned root');
        const registered = (await this.exec(repo, ['worktree', 'list', '--porcelain'])).split('\n').includes(`worktree ${path}`);
        invariant(registered, 'WORKSPACE_PATH', 'Refusing to remove an unregistered directory');
        await this.exec(repo, ['worktree', 'remove', '--force', path]);
    }
    async changes(repo, base, candidate = 'HEAD') {
        const files = (await this.exec(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, candidate, '--'])).split('\0').filter(Boolean).sort();
        const added = (await this.exec(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-filter=A', '--name-only', '-z', base, candidate, '--'])).split('\0').filter(Boolean).sort();
        const stats = (await this.exec(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', base, candidate, '--'])).split('\0').filter(Boolean);
        let lines = 0;
        let binary = false;
        for (const stat of stats) {
            const [add, del] = stat.split('\t');
            if (add === '-' || del === '-')
                binary = true;
            else {
                invariant(add !== undefined && del !== undefined && /^\d+$/.test(add) && /^\d+$/.test(del), 'DIFF', 'Invalid diff statistic');
                lines += Number(add) + Number(del);
            }
        }
        return { files, added, lines, binary };
    }
    async snapshot(repo, base, runId, title) {
        await this.exec(repo, ['merge-base', '--is-ancestor', base, 'HEAD']);
        await this.exec(repo, ['add', '--all', '--', '.']);
        const staged = await this.exec(repo, ['diff', '--cached', '--name-only', '-z']);
        if (staged)
            await this.commit(repo, await this.identity(repo), { subject: candidateSubject(title, runId), generatedBy: 'apv (candidat)', trailers: { 'Agent-Pipeline-Run': runId } });
        const sha = await this.sha(repo);
        invariant(sha !== base && (await this.changes(repo, base, sha)).files.length > 0, 'NO_CHANGE', 'Agent produced no effective change');
        await this.compatible(repo, sha);
        await this.clean(repo, sha);
        return sha;
    }
    async patch(repo, base, sha) {
        return this.exec(repo, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', base, sha, '--']);
    }
    async assertNoNestedGit(path) {
        const files = (await this.exec(path, ['ls-files', '--stage', '-z'])).split('\0');
        invariant(!files.some(f => f.startsWith('160000 ')), 'SUBMODULE', 'Nested repository refused');
        invariant(existsSync(join(path, '.git')), 'WORKSPACE', 'Missing Git metadata');
    }
}
/** Readable single-line candidate subject derived from the task title; the run id stays in a trailer. */
export function candidateSubject(title, runId) {
    const clean = (title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean)
        return `Agent Pipeline V3 candidate ${runId}`;
    return clean.length > 72 ? `${clean.slice(0, 71).trimEnd()}…` : clean;
}
//# sourceMappingURL=git.js.map