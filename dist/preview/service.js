import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, CONFIG_FILE } from '../config/load.js';
import { ensureApvGitignore } from '../config/apv-files.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { LockStore, defaultLockDir } from '../lock/store.js';
import { describeHolder, waitReporter } from '../lock/run.js';
import { DEFAULT_BRANCH, STEP_NAMES, previewUrl, probeHost, resolveEnvFile, resolvePreviewDir, } from './config.js';
import { RedactingWriter, Redactor, expandVars, parseEnvFile } from './env.js';
import { argv, describeCommand, healthy, isOurs, portInUse, procStat, runStep, startDetached, stopGroup, waitHealthy } from './process.js';
import { PREVIEW_LOG, PREVIEW_PREVIOUS_LOG, PREVIEW_UPDATE_LOG, readPreviewState, writePreviewState, } from './state.js';
/** Name of the lease lock taken by `update` and `stop` (docs/LOCKS.md). */
export const PREVIEW_LOCK = 'preview';
/** Marker file that lets `update` empty the preview directory: never a directory it did not create. */
export const DIR_MARKER = '.apv-preview';
/** Most commits listed under « what changed ». */
export const MAX_CHANGES = 20;
/**
 * The `preview` section of `.apv/config.json` with its paths resolved and its env file read. `strict`
 * (update) requires the env file; status and logs only use it to mask values and tolerate its absence.
 */
export function loadPreview(repo, env, strict = true) {
    const { config } = loadConfig(repo);
    const preview = config.preview;
    if (!preview)
        throw new PipelineError('PREVIEW_CONFIG', `Aucune section « preview » dans ${CONFIG_FILE} (voir docs/PREVIEW.md).`);
    const dir = resolvePreviewDir(repo, preview, env);
    const envFile = resolveEnvFile(repo, preview, env);
    let vars = {};
    if (envFile) {
        if (existsSync(envFile))
            vars = parseEnvFile(readFileSync(envFile, 'utf8'), envFile);
        else if (strict)
            throw new PipelineError('PREVIEW_ENV', `Fichier d'environnement introuvable : ${envFile}`);
    }
    return { config: preview, dir, envFile, vars, redactor: new Redactor(vars) };
}
function git(repo, args) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
/** Full commit of a branch (or any commit-ish). An option-like name is refused before reaching git. */
export function resolveCommit(repo, ref) {
    if (ref.startsWith('-') || /[\0\s]/.test(ref))
        throw new PipelineError('PREVIEW_BRANCH', `Nom de branche invalide : ${ref}`);
    try {
        return git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    }
    catch {
        throw new PipelineError('PREVIEW_BRANCH', `Branche ou commit introuvable dans ${repo} : ${ref}`);
    }
}
/** `git log --oneline previous..commit`, capped; null when the previous commit is unknown to the repository. */
export function changesSince(repo, previous, commit) {
    try {
        const total = Number(git(repo, ['rev-list', '--count', `${previous}..${commit}`]));
        const log = git(repo, ['log', '--oneline', '--no-decorate', `--max-count=${MAX_CHANGES}`, `${previous}..${commit}`]);
        return { lines: log ? log.split('\n') : [], total };
    }
    catch {
        return null;
    }
}
/** Empties the preview directory, only if it is empty or was created by apv (marker file). */
function freshDir(dir) {
    if (existsSync(dir)) {
        const entries = readdirSync(dir);
        if (entries.length && !entries.includes(DIR_MARKER)) {
            throw new PipelineError('PREVIEW_DIR', `Le dossier d'aperçu ${dir} existe, n'est pas vide et n'a pas été créé par apv (pas de fichier ${DIR_MARKER}) : rien n'est effacé. Choisissez un autre « preview.dir » ou videz-le vous-même.`);
        }
        rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DIR_MARKER), 'Copie d\'aperçu créée par « apv preview update » : ce dossier est vidé à chaque mise à jour.\n');
}
/** `git archive <commit> | tar -x -C <dir>`: the copy comes from the commit, never from the working tree. */
function archive(repo, commit, dir) {
    return new Promise((resolve, reject) => {
        const producer = spawn('git', ['archive', '--format=tar', commit], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
        const consumer = spawn('tar', ['-x', '-f', '-', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
        let errors = '';
        producer.stderr.on('data', (d) => { errors += d.toString(); });
        consumer.stderr.on('data', (d) => { errors += d.toString(); });
        producer.stdout.pipe(consumer.stdin);
        let pending = 2;
        let failed = false;
        const done = (who) => (status) => {
            if (status !== 0 && !failed) {
                failed = true;
                reject(new Error(`${who} a échoué (code ${status}) ${errors.trim().slice(-500)}`));
            }
            if (--pending === 0 && !failed)
                resolve();
        };
        producer.once('error', (e) => { if (!failed) {
            failed = true;
            reject(e);
        } });
        consumer.once('error', (e) => { if (!failed) {
            failed = true;
            reject(e);
        } });
        producer.once('close', done('git archive'));
        consumer.once('close', done('tar'));
    });
}
function ourServer(state) {
    return Boolean(state && state.pid !== null && isOurs(state.pid, state.procStart));
}
function tail(text, lines) {
    const all = text.replace(/\n$/, '').split('\n');
    return all.slice(-lines).join('\n');
}
/** Refusal that happens before anything changed (foreign process on the port, directory not ours). */
class Refusal extends Error {
    step;
    constructor(step, message) {
        super(message);
        this.step = step;
    }
}
/**
 * Holds the `preview` lease lock around `body` (renewed while it runs, released whatever happens).
 * Re-entrant through APV_LOCK_HELD, like `apv lock run`.
 */
export async function withPreviewLock(ctx, waitSeconds, purpose, body) {
    const held = (ctx.env['APV_LOCK_HELD'] ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const env = { ...ctx.env, APV_LOCK_HELD: [...new Set([...held, PREVIEW_LOCK])].join(',') };
    if (held.includes(PREVIEW_LOCK))
        return body(env);
    const poll = ctx.env['APV_LOCK_POLL_MS'] ? Number(ctx.env['APV_LOCK_POLL_MS']) : undefined;
    const store = new LockStore(defaultLockDir(ctx.env), poll && Number.isFinite(poll) ? { pollMs: poll } : {});
    const ttlSeconds = 600;
    const result = await store.acquire(PREVIEW_LOCK, {
        owner: { pid: process.pid, host: store.host, label: ctx.env['APV_LOCK_LABEL'] || ctx.env['USER'] || 'apv preview' },
        ttlSeconds, waitSeconds, purpose, onWait: waitReporter(PREVIEW_LOCK, ctx.progress),
    });
    if (!result.ok)
        throw new PipelineError('PREVIEW_LOCK', `Verrou « ${PREVIEW_LOCK} » non obtenu après ${waitSeconds} s : tenu par ${describeHolder(result.holder)}.`);
    if (result.takeover)
        ctx.progress(`Verrou « ${PREVIEW_LOCK} » repris (${result.takeover.reason}) à ${describeHolder(result.takeover.previous)}.\n`);
    const token = result.record.token;
    const heartbeat = setInterval(() => { store.renew(PREVIEW_LOCK, token, ttlSeconds).catch(() => undefined); }, 60_000);
    heartbeat.unref();
    try {
        return await body(env);
    }
    finally {
        clearInterval(heartbeat);
        try {
            await store.release(PREVIEW_LOCK, { token });
        }
        catch (error) {
            ctx.progress(`Libération du verrou « ${PREVIEW_LOCK} » en échec : ${errorMessage(error)}\n`);
        }
    }
}
/**
 * `apv preview update`: stops our server, copies the branch with git archive into a fresh directory,
 * runs install, migrate, build and seed, starts the server detached and waits for its health check.
 * Must run under the `preview` lock (see withPreviewLock).
 */
export async function updatePreview(ctx, loaded, branch, lockEnv) {
    const { repo } = ctx;
    const { config, dir, vars, redactor } = loaded;
    const updateLog = join(repo, PREVIEW_UPDATE_LOG);
    const logFile = join(repo, PREVIEW_LOG);
    mkdirSync(join(repo, '.apv', 'state'), { recursive: true });
    ensureApvGitignore(repo);
    const now = () => new Date().toISOString();
    writeFileSync(updateLog, `== ${now()} apv preview update ${branch}\n`);
    const note = (line) => appendFileSync(updateLog, `${redactor.redact(line)}\n`);
    const previous = readPreviewState(repo);
    let commit = null;
    /** Records the failure on the current record; a server of ours that still runs stays recorded. */
    const fail = (step, message, excerpt = '') => {
        note(`== échec de l'étape ${step} : ${message}`);
        const current = readPreviewState(repo);
        if (current) {
            const gone = current.pid !== null && !ourServer(current);
            writePreviewState(repo, {
                ...current, ...(gone ? { pid: null, procStart: null, stoppedAt: current.stoppedAt ?? now() } : {}),
                lastFailure: { step, at: now(), branch, commit: commit ?? '', message: redactor.redact(message).slice(0, 2000) },
            });
        }
        return { ok: false, step, message: redactor.redact(message), excerpt: redactor.redact(excerpt), updateLog, logFile, branch, commit };
    };
    try {
        commit = resolveCommit(repo, branch);
        note(`== commit ${commit}`);
        const { port, host } = config.serve;
        // 1. Our server goes first; anything left on the port afterwards is not ours.
        if (ourServer(previous)) {
            note(`== arrêt du serveur en cours (pid ${previous.pid})`);
            if (!(await stopGroup(previous.pid, previous.procStart)))
                throw new Refusal('arrêt', `le serveur en cours (pid ${previous.pid}) ne s'arrête pas`);
            writePreviewState(repo, { ...previous, pid: null, procStart: null, stoppedAt: now() });
        }
        let busy = await portInUse(port, host);
        for (let i = 0; busy && previous?.pid && i < 20; i++) {
            await new Promise(r => setTimeout(r, 250));
            busy = await portInUse(port, host);
        }
        if (busy) {
            throw new Refusal('port', `le port ${port} est déjà utilisé par un processus qui n'est pas l'aperçu d'apv. Il n'est pas arrêté : libérez le port (par exemple « ss -ltnp 'sport = :${port}' » pour le trouver) ou changez « preview.serve.port ».`);
        }
        // 2. Fresh copy of the commit.
        note(`== copie de ${branch} (${commit.slice(0, 7)}) dans ${dir}`);
        try {
            freshDir(dir);
            await archive(repo, commit, dir);
        }
        catch (error) {
            if (error instanceof PipelineError)
                throw new Refusal('copie', error.message);
            throw new Refusal('copie', errorMessage(error));
        }
        // 3. Steps.
        const baseEnv = {
            ...lockEnv, ...vars,
            APV_REPO: repo, APV_PREVIEW_DIR: dir, APV_PREVIEW_BRANCH: branch, APV_PREVIEW_COMMIT: commit, APV_PREVIEW_PORT: String(port),
            ...(host ? { APV_PREVIEW_HOST: host } : {}),
        };
        for (const step of STEP_NAMES) {
            const command = config.steps[step];
            if (command === undefined)
                continue;
            ctx.progress(`étape ${step}...\n`);
            note(`== étape ${step} : ${describeCommand(command)}`);
            let args;
            try {
                args = argv(command, baseEnv, `preview.steps.${step}`);
            }
            catch (error) {
                return fail(step, errorMessage(error));
            }
            let excerpt = '';
            const writer = new RedactingWriter(redactor, (s) => { appendFileSync(updateLog, s); excerpt = (excerpt + s).slice(-20_000); });
            const started = Date.now();
            const result = await runStep(args, dir, baseEnv, (s) => writer.push(s));
            writer.flush();
            const seconds = ((Date.now() - started) / 1000).toFixed(1);
            if (result.status !== 0) {
                const why = result.error ? `impossible de lancer la commande (${result.error})`
                    : result.status === null ? `interrompue par le signal ${result.signal}` : `code de sortie ${result.status}`;
                return fail(step, `${why} après ${seconds} s`, tail(excerpt, 20));
            }
            note(`== étape ${step} réussie en ${seconds} s`);
        }
        // 4. Server, detached in its own process group.
        const serveVars = { ...baseEnv, PORT: String(port) };
        let serveEnv;
        let serveArgs;
        try {
            const extra = {};
            for (const [name, value] of Object.entries(config.serve.env))
                extra[name] = expandVars(value, serveVars, `preview.serve.env.${name}`);
            serveEnv = { ...serveVars, ...extra };
            serveArgs = argv(config.serve.command, serveEnv, 'preview.serve.command');
        }
        catch (error) {
            return fail('serve', errorMessage(error));
        }
        if (existsSync(logFile))
            renameSync(logFile, join(repo, PREVIEW_PREVIOUS_LOG));
        note(`== serveur : ${describeCommand(config.serve.command)} (port ${port}, journal ${logFile})`);
        ctx.progress('démarrage du serveur...\n');
        let pid;
        try {
            pid = await startDetached(serveArgs, dir, serveEnv, logFile);
        }
        catch (error) {
            return fail('serve', errorMessage(error));
        }
        const procStart = procStat(pid)?.start ?? null;
        const url = previewUrl(config);
        const healthUrl = `http://${probeHost(host)}:${port}${config.health.path}`;
        const state = {
            version: 1, pid, procStart, port, host: host ?? null, branch, commit, startedAt: now(), stoppedAt: null,
            url, healthUrl, dir, lastFailure: null,
        };
        // Recorded before the health check: a server that never answers is still ours to stop.
        writePreviewState(repo, state);
        // 5. Health.
        const health = await waitHealthy(healthUrl, config.health.timeoutSec, () => isOurs(pid, procStart));
        if (health !== 'ok') {
            await stopGroup(pid, procStart);
            const logTail = existsSync(logFile) ? tail(readFileSync(logFile, 'utf8'), 20) : '';
            if (previous)
                writePreviewState(repo, { ...previous, pid: null, procStart: null, stoppedAt: previous.stoppedAt ?? now() });
            else
                rmSync(join(repo, '.apv', 'state', 'preview.json'), { force: true });
            return fail('health', health === 'dead'
                ? `le serveur s'est arrêté avant de répondre sur ${healthUrl}`
                : `aucune réponse 2xx ou 3xx de ${healthUrl} en ${config.health.timeoutSec} s`, logTail);
        }
        writePreviewState(repo, state);
        note(`== aperçu prêt : ${url} (pid ${pid})`);
        const previousCommit = previous?.commit ?? null;
        return {
            ok: true, url, branch, commit, pid, previousCommit, previousBranch: previous?.branch ?? null,
            changes: previousCommit && previousCommit !== commit ? changesSince(repo, previousCommit, commit) : null,
            logFile, updateLog,
        };
    }
    catch (error) {
        if (error instanceof Refusal)
            return fail(error.step, error.message);
        if (error instanceof PipelineError && error.code === 'PREVIEW_BRANCH')
            return fail('branche', error.message);
        throw error;
    }
}
/** `apv preview stop`: stops our server (whole process group) and keeps the record of the last preview. */
export async function stopPreview(repo) {
    const state = readPreviewState(repo);
    if (!state || state.pid === null)
        return { stopped: false, pid: null };
    const pid = state.pid;
    if (!ourServer(state)) {
        writePreviewState(repo, { ...state, pid: null, procStart: null, stoppedAt: state.stoppedAt ?? new Date().toISOString() });
        return { stopped: false, pid };
    }
    if (!(await stopGroup(pid, state.procStart)))
        throw new PipelineError('PREVIEW_STOP', `Le serveur d'aperçu (groupe ${pid}) ne s'arrête pas, même après SIGKILL.`);
    writePreviewState(repo, { ...state, pid: null, procStart: null, stoppedAt: new Date().toISOString() });
    return { stopped: true, pid };
}
/** `apv preview status`: running means our process group is alive and answers its health check. */
export async function previewStatus(repo) {
    const state = readPreviewState(repo);
    const alive = ourServer(state);
    const ok = alive ? await healthy(state.healthUrl) : false;
    const uptime = alive ? Math.max(0, Math.round((Date.now() - Date.parse(state.startedAt)) / 1000)) : null;
    return { running: alive && ok, alive, healthy: ok, state, uptimeSeconds: uptime };
}
/** Last lines of the server log (or of the update log), with env values masked. */
export function previewLogs(repo, redactor, lines, which) {
    const file = join(repo, which === 'server' ? PREVIEW_LOG : PREVIEW_UPDATE_LOG);
    if (!existsSync(file))
        return { file, text: null };
    return { file, text: redactor.redact(tail(readFileSync(file, 'utf8'), lines)) };
}
export { DEFAULT_BRANCH };
//# sourceMappingURL=service.js.map