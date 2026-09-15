import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { invariant } from '../domain/errors.js';
export function environment(names, source = process.env) {
    return Object.fromEntries([...new Set(names)].filter(k => source[k] !== undefined).map(k => [k, source[k]]));
}
export function redact(text, env) {
    let out = text;
    for (const [key, value] of Object.entries(env)) {
        if (value && value.length >= 4 && /TOKEN|KEY|PASSWORD|SECRET|CREDENTIAL/i.test(key))
            out = out.split(value).join('[REDACTED]');
    }
    return out;
}
/** No shell expansion. POSIX process groups are terminated on cancellation AND
 * normal leader exit, so ordinary background children cannot outlive the task.
 * This is lifecycle management, not a sandbox against a hostile setsid() child. */
/** Delay after the direct child exits before stdio pipes still held by escaped descendants are closed. */
export const PIPE_GRACE_MS = 1000;
export function runProcess(options) {
    invariant(process.platform !== 'win32', 'PLATFORM', 'Native Windows process-tree control is not implemented; use WSL2');
    invariant(options.command.length > 0 && options.command[0], 'COMMAND', 'Empty argv');
    invariant(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0, 'COMMAND', 'Invalid timeout');
    const started = performance.now();
    const max = options.maxOutputBytes ?? 131072;
    const hashes = [createHash('sha256'), createHash('sha256')];
    const buffers = [Buffer.alloc(0), Buffer.alloc(0)];
    let truncated = false;
    let status = null;
    let spawnError = '';
    if (options.signal?.aborted)
        return Promise.resolve({
            status: 'cancelled', exitCode: null, signal: null, durationMs: 0,
            stdout: '', stderr: '', stdoutHash: hashes[0].digest('hex'), stderrHash: hashes[1].digest('hex'), truncated: false,
        });
    return new Promise((resolve, reject) => {
        const child = spawn(options.command[0], options.command.slice(1), {
            cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let hardKill;
        let hookFailure;
        function kill(signal) {
            if (!child.pid)
                return;
            try {
                process.kill(-child.pid, signal);
            }
            catch (error) {
                if (error.code !== 'ESRCH') {
                    try {
                        child.kill(signal);
                    }
                    catch { /* already exited */ }
                }
            }
        }
        function stop(reason) {
            if (status)
                return;
            status = reason;
            kill('SIGTERM');
            hardKill = setTimeout(() => kill('SIGKILL'), 200);
        }
        const abort = () => stop('cancelled');
        options.signal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(() => stop('timed_out'), options.timeoutMs);
        const collect = (i, chunk) => {
            hashes[i].update(chunk);
            const combined = Buffer.concat([buffers[i], chunk]);
            if (combined.length > max) {
                truncated = true;
                buffers[i] = combined.subarray(combined.length - max);
            }
            else
                buffers[i] = combined;
        };
        child.stdout.on('data', (chunk) => collect(0, chunk));
        child.stderr.on('data', (chunk) => collect(1, chunk));
        child.stdin.on('error', () => { });
        child.once('spawn', () => {
            try {
                options.onStart?.(child.pid);
            }
            catch (error) {
                hookFailure = error;
                kill('SIGKILL');
            }
            if (options.signal?.aborted)
                stop('cancelled');
        });
        child.once('error', error => { status = 'spawn_error'; spawnError = error.message; });
        // 'close' waits for every stdio pipe. A descendant that left the process group (a detached daemon)
        // can keep them open forever, so after the child exits the controller closes them itself.
        let pipeGrace;
        child.once('exit', () => {
            kill('SIGKILL');
            pipeGrace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, PIPE_GRACE_MS);
        });
        child.once('close', (code, signal) => {
            clearTimeout(timeout);
            if (hardKill)
                clearTimeout(hardKill);
            if (pipeGrace)
                clearTimeout(pipeGrace);
            kill('SIGKILL');
            options.signal?.removeEventListener('abort', abort);
            try {
                if (child.pid)
                    options.onFinish?.(child.pid);
            }
            catch (error) {
                hookFailure = error;
            }
            if (hookFailure) {
                reject(hookFailure);
                return;
            }
            resolve({ status: status ?? (code === 0 ? 'passed' : 'failed'), exitCode: code, signal,
                durationMs: Math.round((performance.now() - started) * 1000) / 1000,
                stdout: buffers[0].toString('utf8'), stderr: spawnError || buffers[1].toString('utf8'),
                stdoutHash: hashes[0].digest('hex'), stderrHash: hashes[1].digest('hex'), truncated });
        });
        child.stdin.end(options.input ?? '');
    });
}
/** Only whole-argument substitutions are supported; never shell interpolation. */
export function expandCommand(command, context) {
    return command.map(arg => {
        if (!arg.includes('{{'))
            return arg;
        const key = /^\{\{([A-Za-z]+)\}\}$/.exec(arg)?.[1];
        invariant(key && Object.hasOwn(context, key), 'COMMAND', `Unknown or partial placeholder: ${arg}`);
        return context[key];
    });
}
//# sourceMappingURL=process.js.map