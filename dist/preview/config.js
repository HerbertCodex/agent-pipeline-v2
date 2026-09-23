import { canonicalPath } from '../domain/paths.js';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { s } from '../domain/schema.js';
import { PipelineError } from '../domain/errors.js';
import { ENV_NAME } from './env.js';
/**
 * A command of the preview: a string runs through `sh -c` (pipes, `&&`, variables of the env file),
 * an array is an argv run without any shell, where `${NAME}` is replaced from the environment.
 */
export const previewCommandSchema = s.union(s.string(1, 10000), s.array(s.string(1, 10000), 1, 200));
/** Default longest run of one step, in seconds (`timeoutSec` of the step overrides it). */
export const DEFAULT_STEP_TIMEOUT_SEC = 900;
/** A step: a command, or `{ command, timeoutSec }` to change its longest run (default 900 s). */
export const previewStepSchema = s.union(previewCommandSchema, s.object({
    command: previewCommandSchema,
    timeoutSec: s.default(s.number(1, 86_400), DEFAULT_STEP_TIMEOUT_SEC),
}));
/** Command and longest run of a step, whatever its form. */
export function stepSpec(step) {
    return typeof step === 'string' || Array.isArray(step) ? { command: step, timeoutSec: DEFAULT_STEP_TIMEOUT_SEC } : step;
}
/** The build steps, run in this order in the fresh copy of the branch. */
export const STEP_NAMES = ['install', 'migrate', 'build', 'seed'];
export const previewSchema = s.object({
    /** Branch shown when `apv preview update` gets none (default `main`). */
    branch: s.optional(s.string(1, 250)),
    /** Directory of the copy; default `${XDG_STATE_HOME:-~/.local/state}/apv/preview/<project>`. */
    dir: s.optional(s.string(1, 4096)),
    /** Env file loaded for every step and for the server; its values are never printed. */
    envFile: s.optional(s.string(1, 4096)),
    steps: s.default(s.object({
        install: s.optional(previewStepSchema),
        migrate: s.optional(previewStepSchema),
        build: s.optional(previewStepSchema),
        seed: s.optional(previewStepSchema),
    }), {}),
    serve: s.object({
        command: previewCommandSchema,
        port: s.number(1, 65535),
        host: s.optional(s.string(1, 255, /^[A-Za-z0-9.:_-]+$/)),
        env: s.default(s.record(ENV_NAME, s.string(0, 100000), 500), {}),
    }),
    health: s.default(s.object({
        path: s.default(s.string(1, 2000, /^\/[^\s]*$/), '/'),
        timeoutSec: s.default(s.number(1, 3600), 60),
    }), { path: '/', timeoutSec: 60 }),
    announce: s.optional(s.object({ url: s.optional(s.string(1, 2000, /^https?:\/\/\S+$/)) })),
});
export const DEFAULT_BRANCH = 'main';
/** Project name used in the default directory and the lock name: the repository folder name, made file-safe. */
export function projectName(repo) {
    return basename(repo).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'projet';
}
export function defaultPreviewDir(repo, env) {
    const state = env['XDG_STATE_HOME'] || join(env['HOME'] || homedir(), '.local', 'state');
    return join(state, 'apv', 'preview', projectName(repo));
}
function real(path) {
    return canonicalPath(path);
}
function inside(child, parent) {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
/**
 * Directory of the copy. `~/` is the home directory, a relative path is relative to the repository.
 * The directory is emptied at every update, so it must not be the repository, inside it (never the
 * working tree), or contain it, the home directory or the root.
 */
export function resolvePreviewDir(repo, config, env) {
    const home = env['HOME'] || homedir();
    const raw = config.dir;
    const dir = raw === undefined ? defaultPreviewDir(repo, env)
        : raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : resolve(repo, raw);
    const target = real(dir);
    const refuse = (why) => { throw new PipelineError('PREVIEW_DIR', `Dossier d'aperçu refusé (${dir}) : ${why}. Il est vidé à chaque mise à jour.`); };
    if (inside(target, real(repo)))
        refuse('il est dans le dépôt (l\'aperçu ne s\'installe jamais dans l\'arbre de travail)');
    if (inside(real(repo), target))
        refuse('il contient le dépôt');
    if (inside(real(home), target))
        refuse('il contient le dossier personnel');
    if (target === resolve('/'))
        refuse('c\'est la racine');
    return dir;
}
/** The env file path, relative to the repository unless absolute or under `~/`. */
export function resolveEnvFile(repo, config, env) {
    const raw = config.envFile;
    if (raw === undefined)
        return null;
    const home = env['HOME'] || homedir();
    return raw.startsWith('~/') ? join(home, raw.slice(2)) : resolve(repo, raw);
}
/** Host the health check and the port check talk to: the served host, or the loopback when it listens everywhere. */
export function probeHost(host) {
    if (!host || host === '0.0.0.0' || host === '::' || host === '[::]')
        return '127.0.0.1';
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
/** Address announced to the operator: `announce.url`, else `http://localhost:<port>`. */
export function previewUrl(config) {
    return config.announce?.url ?? `http://localhost:${config.serve.port}`;
}
//# sourceMappingURL=config.js.map