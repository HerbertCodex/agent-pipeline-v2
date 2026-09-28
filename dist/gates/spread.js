import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { environment, runProcess } from '../execution/process.js';
import { readEnvFile } from '../stacks/config.js';
import { resolveStacks } from '../stacks/idle.js';
import { commonPath } from './suite.js';
/** Whether the lock of `gate`, as configured (its file relative to the Git common directory, or its lease), is the lock of a declared stack. */
async function usesStack(git, repo, gate, stacks) {
    if (!gate.lock)
        return false;
    if ('resource' in gate.lock) {
        const resource = gate.lock.resource;
        return stacks.some(s => s.resource === resource);
    }
    const file = await commonPath(git, repo, gate.lock.file);
    return stacks.some(s => s.lockFile === file);
}
export async function planSpread(options) {
    const declared = resolveStacks(options.config, options.common);
    const unknown = options.ids.filter(id => !declared.some(s => s.id === id));
    if (unknown.length)
        throw new PipelineError('STACK_UNKNOWN', `--stacks : pile inconnue ${unknown.join(', ')} (déclarées : ${declared.map(s => s.id).join(', ') || 'aucune'}, section stacks de .apv/config.json)`);
    const selected = options.ids.map(id => declared.find(s => s.id === id));
    const stackGates = [];
    for (const gate of options.gates)
        if (await usesStack(options.git, options.repo, gate, declared))
            stackGates.push(gate);
    const dependents = new Set(options.gates.flatMap(g => g.dependsOn));
    const assignments = new Map();
    const copies = new Map();
    let turn = 0;
    for (const gate of stackGates) {
        const movable = gate.dependsOn.length === 0 && !dependents.has(gate.id);
        const stack = movable ? selected[turn++ % selected.length] : selected[0];
        let workspace = options.repo;
        if (stack !== selected[0]) {
            const copy = copies.get(stack.id) ?? { stack, dir: join(options.common, 'apv', 'copies', `${options.runId}-${stack.id.replace(/[^A-Za-z0-9._-]/g, '_')}`), gates: [], error: null };
            copy.gates.push(gate.id);
            copies.set(stack.id, copy);
            workspace = copy.dir;
        }
        assignments.set(gate.id, { gateId: gate.id, stack, workspace });
    }
    return { assignments, copies: [...copies.values()] };
}
/**
 * Makes each copy: a detached worktree of `sha`, `batch.setup` run at its root (HOME passed), then a clean tree
 * required. A copy that cannot be made keeps the reason: its checks are not run and their receipts say why.
 */
export async function prepareCopies(plan, options) {
    for (const copy of plan.copies) {
        try {
            if (existsSync(copy.dir))
                throw new Error(`la copie ${copy.dir} existe déjà`);
            await options.git.exec(options.repo, ['worktree', 'add', '--detach', copy.dir, options.sha]);
            const setup = options.config.batch?.setup;
            if (setup) {
                options.log(`Pile ${copy.stack.id} : préparation de la copie ${copy.dir} (${setup.join(' ')}).`);
                const env = environment([...options.config.environment.passEnv, 'HOME', ...(options.config.batch?.passEnv ?? [])], options.env);
                const r = await runProcess({ command: setup, cwd: copy.dir, env, timeoutMs: options.config.batch.setupTimeoutMs, maxOutputBytes: 256 * 1024,
                    ...(options.signal ? { signal: options.signal } : {}) });
                if (r.status !== 'passed')
                    throw new Error(`batch.setup en échec (${r.status}, code ${r.exitCode ?? '-'}) : ${`${r.stdout}\n${r.stderr}`.trim().slice(-800)}`);
            }
            const status = await options.git.exec(copy.dir, ['status', '--porcelain=v1', '--untracked-files=all']);
            if (status.trim() !== '')
                throw new Error(`copie modifiée après sa préparation (fichiers non ignorés) : ${status.trim().split('\n').slice(0, 5).join(', ')}`);
        }
        catch (error) {
            copy.error = errorMessage(error);
            options.log(`Pile ${copy.stack.id} : copie non préparée (${copy.error}) ; ses contrôles (${copy.gates.join(', ')}) ne tournent pas.`);
        }
    }
}
export async function removeCopies(plan, git, repo, log) {
    for (const copy of plan.copies) {
        if (!existsSync(copy.dir))
            continue;
        try {
            await git.exec(repo, ['worktree', 'remove', '--force', copy.dir]);
        }
        catch (error) {
            log(`Copie ${copy.dir} non retirée (${errorMessage(error)}) : git worktree remove --force ${copy.dir}`);
        }
    }
}
/**
 * The variables of a stack for a check: its env file, then its `env`, then the `fileEnv` variable of the lock of the
 * check pointed at the lock file of the stack; only the names the check receives (`passEnv`), like every variable.
 */
export function stackVariables(stack, gate, passEnv) {
    const all = { ...(stack.envFile ? readEnvFile(stack.envFile) : {}), ...(stack.config.env ?? {}) };
    if (gate.lock && 'file' in gate.lock && gate.lock.fileEnv && stack.lockFile)
        all[gate.lock.fileEnv] = stack.lockFile;
    const names = new Set([...passEnv, ...gate.passEnv]);
    return Object.fromEntries(Object.entries(all).filter(([k]) => names.has(k)));
}
/** The lock of a check run on `stack`: the lock of the stack, with the wait the check declares. */
export function stackLock(stack, gate, leaseDir) {
    const waitMs = gate.lock?.waitMs ?? 1_800_000;
    return stack.lockFile ? { kind: 'flock', file: stack.lockFile, waitMs } : { kind: 'lease', resource: stack.resource, dir: leaseDir, waitMs };
}
//# sourceMappingURL=spread.js.map