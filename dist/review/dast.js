import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_PASS_ENV, VERSION } from '../domain/contracts.js';
import { PipelineError } from '../domain/errors.js';
import { environment, expandCommand } from '../execution/process.js';
import { isInside } from '../execution/git.js';
import { canonicalPath } from '../domain/paths.js';
import { LOCK_WAIT_TIMEOUT_EXIT, TIMEOUT_EXIT, runLocked } from '../lock/run.js';
/**
 * `apv dast run`: the dynamic security scan (ZAP or another) that the project declares in `review.dast`, run by
 * the project lead before the reviews. The review agents may not start Docker: on the pilot project the planned
 * ZAP scan never ran (four deliveries in a row, September 2026). The lead runs it once, under its lease, and hands the
 * report to the security review, which reads it.
 */
export const DAST_SUMMARY = 'summary.json';
export const DAST_LOG = 'dast.log';
/** Files listed in the summary, at most. */
const MAX_LISTED = 200;
/**
 * The installation of the dependencies of the copy, without the scripts of the packages (`preinstall`, `postinstall`):
 * they would run outside the lease of the scan.
 */
export const DAST_INSTALL = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
/** Written in `node_modules` after a successful installation: the sha256 of the lockfile it installed. */
export const DAST_INSTALL_MARKER = '.apv-dast-install';
/**
 * Hosts that never leave the machine: `localhost`, `*.localhost`, 127.0.0.0/8 and `::1`. The only addresses an
 * environment file may name: anything else that looks like an address is refused (an allow-list, never a deny-list).
 */
const LOOPBACK = /^(?:localhost|(?:[a-z0-9-]+\.)+localhost|127(?:\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1)\.?$/i;
export const LOOPBACK_TEXT = 'seuls localhost, *.localhost, 127.0.0.0/8 et ::1 sont admis';
/** Variables an environment file may not set: those of the tool, and those that change what runs. */
const RESERVED_KEY = /^(?:APV_[A-Z0-9_]*|PATH|NODE_OPTIONS|NODE_PATH|HOME|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*)$/;
/** Variables that name an address: every word of their value must be a loopback address or a port. */
const HOST_KEY = /HOST|URL|URI|ADDR|ENDPOINT|SERVER|DSN|DOMAIN|ORIGIN|PROXY|TARGET|SITE|BASE|API|DATABASE|(?:^|_)DB(?:_|$)/i;
/** A variable of an address family whose value is not an address (`API_KEY`, `DB_PASSWORD`, `DATABASE_NAME`, `DB_PORT`). */
const NOT_ADDRESS_KEY = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|USER|USERNAME|NAME|ID|PORT|TIMEOUT|VERSION|MODE|SCHEMA)$/i;
/** `host:port` without a scheme (`prodserver:8080`, `localhost:5173`). */
const HOST_PORT = /^([\p{L}\p{N}._-]+):(\d{1,5})(?:[/\\]\S*)?$/u;
/** One or more schemes (`http:`, `jdbc:postgresql:`), then the rest. */
const SCHEMES = /^((?:[a-z][\w+.-]*:)+)(.*)$/i;
/** `%XX` decoded, a few times (`%253A`): an encoded address is read as the address. */
function decoded(value) {
    let out = value;
    for (let i = 0; i < 3; i++) {
        let next;
        try {
            next = decodeURIComponent(out);
        }
        catch {
            break;
        }
        if (next === out)
            break;
        out = next;
    }
    return out;
}
/** E-mail domains reserved for examples and tests: a test account there names no machine. */
const RESERVED_MAIL = /^[^@\s]+@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;
/** A host name: labels of letters, digits and hyphens, the last one of letters only (a TLD; not a version, not a key). */
const HOST_NAME = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62})?\.)+\p{L}{2,63}\.?(?::\d+)?(?:\/\S*)?$/u;
const IPV4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/\S*)?$/;
const IPV6 = /^\[?([0-9a-f]*:[0-9a-f]*:[0-9a-f:.]*)\]?(?::\d+)?$/i;
const URL_LIKE = /^(?:[a-z][\w+.-]*:)?\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/?#]*)/i;
const loopback = (host) => LOOPBACK.test(host.replace(/^\[|\]$/g, ''));
/**
 * Why a value of an environment file names an address outside the loopback, or null. Each word of the value is read
 * (a list, a JSON object, a libpq string `host=… port=…`): a URL (`scheme://`, `//`), `user@host`, `host=`, an IPv4 or
 * IPv6 address, a host name with a dot (`db.prod.example.com`, `bdd.exämple.fr`, with a trailing dot) must be loopback;
 * in a variable that names an address (`*_HOST`, `*_URL`...) or after `host`, a bare name (`prodserver`) or a number
 * beyond a port too. An e-mail address on a domain reserved for examples (`demo@example.org`) is a test account, not a
 * host. Never returns the value.
 */
export function addressRefusal(key, value) {
    const words = decoded(value).split(/[\s,;|"'`{}()<>]+/).filter(Boolean);
    const addressKey = HOST_KEY.test(key) && !NOT_ADDRESS_KEY.test(key);
    let strictNext = false;
    for (const raw of words) {
        // A separator alone (`:` of a JSON object, `=`) is no word; an IPv6 address keeps its colons.
        if (/^[:=]+$/.test(raw))
            continue;
        let word = raw.replace(/:$/, '');
        let strict = addressKey || strictNext;
        strictNext = /^(?:host|hostname|hostaddr|server|addr|address)$/i.test(word);
        if (strictNext)
            continue;
        const pair = /^([\w.-]+)=(.*)$/.exec(word);
        if (pair) {
            word = pair[2];
            strict ||= /^(?:host|hostaddr|hostname|server|addr)$/i.test(pair[1]);
            if (!word)
                continue;
        }
        const url = URL_LIKE.exec(word);
        if (url) {
            if (!loopback(url[1]))
                return 'adresse (URL) hors bouclage';
            continue;
        }
        // An IPv6 address before anything that reads colons (`fe80::1` starts with letters).
        const v6first = IPV6.exec(word);
        if (v6first && (v6first[1].match(/:/g)?.length ?? 0) >= 2) {
            if (!loopback(v6first[1]))
                return 'adresse IPv6 hors bouclage';
            continue;
        }
        // `host:port`: the host must be loopback, with or without a dot (`prodserver:8080`).
        const hostPort = HOST_PORT.exec(word);
        if (hostPort && !/^\d+$/.test(hostPort[1])) {
            if (!loopback(hostPort[1]))
                return 'hôte:port hors bouclage';
            continue;
        }
        // Any scheme, nested or not, with `//`, `/`, `\\` or nothing before the host (`http:host`, `jdbc:postgresql://host`).
        const schemes = SCHEMES.exec(word);
        if (schemes && !word.includes('@') && schemes[2]) {
            const rest = schemes[2];
            const authority = rest.replace(/^[/\\]+/, '').split(/[/\\?#]/)[0];
            const host = (/^\[[^\]]*\]/.exec(authority)?.[0] ?? authority.split(':')[0]);
            const urlish = /^[/\\]/.test(rest) || host.includes('.') || schemes[1].split(':').length > 2 || strict;
            if (urlish && host) {
                if (!loopback(host))
                    return 'adresse (schéma:hôte) hors bouclage';
                continue;
            }
        }
        if (word.includes('@')) {
            if (RESERVED_MAIL.test(word))
                continue;
            const host = word.slice(word.lastIndexOf('@') + 1).split(/[:/]/)[0];
            if (!loopback(host))
                return 'adresse (utilisateur@hôte ou e-mail hors domaine d\'exemple) hors bouclage';
            continue;
        }
        const v6 = IPV6.exec(word);
        if (v6 && (v6[1].match(/:/g)?.length ?? 0) >= 2) {
            if (!loopback(v6[1]))
                return 'adresse IPv6 hors bouclage';
            continue;
        }
        const v4 = IPV4.exec(word);
        if (v4) {
            if (!loopback(v4[1]))
                return 'adresse IPv4 hors bouclage';
            continue;
        }
        if (HOST_NAME.test(word)) {
            if (!loopback(word.split(/[:/]/)[0]))
                return 'nom d\'hôte hors bouclage';
            continue;
        }
        if (strict) {
            const host = word.split(/[:/]/)[0];
            if (/^\d+$/.test(word) && Number(word) <= 65535)
                continue;
            if (!loopback(host))
                return 'nom d\'hôte hors bouclage (variable d\'adresse)';
        }
    }
    return null;
}
/** `~` and `~/…` as the home folder of the account; a relative path from the copy. */
export function envFilePath(value, repo, home = homedir()) {
    const expanded = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
    return isAbsolute(expanded) ? expanded : resolve(repo, expanded);
}
/** `KEY=value` lines (`export KEY=value`, quotes removed, `#` comments and blank lines skipped). */
export function parseEnvFile(text) {
    const out = new Map();
    for (const [i, raw] of text.split(/\r?\n/).entries()) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m)
            throw new PipelineError('DAST_ENV', `review.dast.envFile : ligne ${i + 1} illisible (KEY=valeur attendu)`);
        let value = m[2];
        if (/^(['"]).*\1$/.test(value))
            value = value.slice(1, -1);
        else
            value = value.replace(/\s+#.*$/, '');
        out.set(m[1], value);
    }
    return out;
}
/**
 * Loads `review.dast.envFile`: refused (`DAST_ENV`) when it is absent, unreadable, sets a reserved variable (`APV_*`,
 * `PATH`, `NODE_OPTIONS`, `HOME`...), or when a value names an address outside the loopback (the scan never targets
 * production). The refusal names the keys, never their values.
 */
export function loadDastEnvFile(value, repo, home) {
    const file = envFilePath(value, repo, home || homedir());
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch {
        throw new PipelineError('DAST_ENV', `review.dast.envFile introuvable ou illisible : ${file}`);
    }
    const variables = parseEnvFile(text);
    const reserved = [...variables.keys()].filter(k => RESERVED_KEY.test(k));
    if (reserved.length) {
        throw new PipelineError('DAST_ENV', `review.dast.envFile (${file}) refusé : variable(s) réservée(s) ${reserved.join(', ')} (APV_*, PATH, NODE_OPTIONS, NODE_PATH, HOME, LD_*, DYLD_*) : elles changent ce que lance l'outil. Rien n'est lancé.`);
    }
    const remote = [...variables].map(([k, v]) => [k, addressRefusal(k, v)]).filter(([, why]) => why !== null);
    if (remote.length) {
        throw new PipelineError('DAST_ENV', `review.dast.envFile (${file}) refusé : ${remote.map(([k, why]) => `${k} (${why})`).join(', ')} ; ${LOOPBACK_TEXT} : le scan ne vise jamais la production. Rien n'est lancé.`);
    }
    return { file, variables };
}
/**
 * Prepares the copy: with a `package-lock.json`, `npm ci --ignore-scripts` in the copy unless the marker of a successful
 * installation of this very lockfile is there (an interrupted installation leaves a partial `node_modules`, never the
 * marker), output appended to the log, bounded by `timeoutMs`. Receives the variables of the scan (never those of the
 * environment file) plus `HOME` and `USERPROFILE` (the cache of npm).
 */
export function prepareCopy(repo, env, logFd, timeoutMs, command = DAST_INSTALL) {
    const lock = join(repo, 'package-lock.json');
    if (!existsSync(lock))
        return { status: 'skipped', reason: 'pas de package-lock.json dans la copie', command: null, exitCode: null, durationMs: 0 };
    const digest = createHash('sha256').update(readFileSync(lock)).digest('hex');
    const marker = join(repo, 'node_modules', DAST_INSTALL_MARKER);
    let installed = '';
    try {
        installed = readFileSync(marker, 'utf8').trim();
    }
    catch { /* never installed by the tool */ }
    if (installed === digest)
        return { status: 'skipped', reason: 'dépendances déjà installées par apv dast run pour ce package-lock.json', command: null, exitCode: null, durationMs: 0 };
    const started = Date.now();
    writeSync(logFd, `[apv dast] installation des dépendances de la copie : ${command.join(' ')}\n`);
    const r = spawnSync(command[0], command.slice(1), { cwd: repo, env, stdio: ['ignore', logFd, logFd], timeout: timeoutMs, killSignal: 'SIGTERM' });
    const durationMs = Date.now() - started;
    const exitCode = r.status ?? (r.error ? 127 : 1);
    if (r.error?.code === 'ETIMEDOUT') {
        return { status: 'timed_out', reason: `${command.join(' ')} : délai dépassé (${Math.round(timeoutMs / 1000)} s, review.dast.timeoutMs)`, command: [...command], exitCode: TIMEOUT_EXIT, durationMs };
    }
    if (r.error || r.status !== 0) {
        return { status: 'failed', reason: `${command.join(' ')} en échec : ${r.error ? r.error.message : `code ${exitCode}`}`, command: [...command], exitCode, durationMs };
    }
    try {
        mkdirSync(join(repo, 'node_modules'), { recursive: true });
        writeFileSync(marker, `${digest}\n`);
    }
    catch { /* the next run installs again */ }
    return { status: 'done', reason: installed ? 'package-lock.json changé depuis la dernière installation' : 'aucune installation de apv dast run pour ce package-lock.json', command: [...command], exitCode: 0, durationMs };
}
/**
 * Default folder of the reports: under the temporary directory of the machine, named after the copy and the
 * commit, never beside the repository nor inside the copy (removed after the reviews).
 */
export function defaultReportDir(repo, commit, now) {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    return join(canonicalPath(tmpdir()), 'apv-dast', `${basename(repo)}-${commit.slice(0, 12)}-${stamp}`);
}
/** Refuses a report folder inside the scanned copy (it would go with the copy) or already used by a scan. */
export function checkReportDir(repo, reportDir) {
    // Canonical paths on both sides: Git gives the resolved root (macOS: /var is /private/var), a symbolic link
    // may lead into the copy; comparing the written paths let a folder inside the copy through.
    if (isInside(canonicalPath(repo), canonicalPath(reportDir))) {
        throw new PipelineError('DAST_OUT', `Dossier des rapports dans la copie scannée (${reportDir}) : la copie est retirée après les revues ; choisir un dossier hors du dépôt (le dossier de session, par exemple)`);
    }
    if (existsSync(join(reportDir, DAST_SUMMARY))) {
        throw new PipelineError('DAST_OUT', `${join(reportDir, DAST_SUMMARY)} existe déjà : un dossier par scan (apv wait --file sur ce résumé rendrait la main tout de suite)`);
    }
}
/** Files of the report folder (relative, sorted), summary excluded, at most MAX_LISTED. */
function listFiles(dir) {
    const out = [];
    const walk = (current, depth) => {
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (out.length >= MAX_LISTED)
                return;
            const path = join(current, entry.name);
            if (entry.isDirectory()) {
                if (depth < 3)
                    walk(path, depth + 1);
                continue;
            }
            const rel = relative(dir, path).split(sep).join('/');
            if (rel !== DAST_SUMMARY)
                out.push(rel);
        }
    };
    walk(dir, 0);
    return out;
}
/** Atomic write: `apv wait --file <dossier>/summary.json` never sees half a summary. */
function writeSummary(dir, summary) {
    const file = join(dir, DAST_SUMMARY);
    const tmp = join(dir, `.${DAST_SUMMARY}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o644);
    try {
        writeSync(fd, `${JSON.stringify(summary, null, 2)}\n`);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    try {
        renameSync(tmp, file);
    }
    catch (error) {
        rmSync(tmp, { force: true });
        throw error;
    }
}
/**
 * Runs the scan command in the copy, under the lease `settings.resource`, output to `dast.log` of the report
 * folder, bounded by `settings.timeoutMs`; then writes `summary.json` there. The command receives the variables
 * of `DEFAULT_PASS_ENV` and `settings.passEnv` only, plus `APV_DAST_REPORT_DIR`, `APV_DAST_COMMIT` and
 * `APV_DAST_REPO`.
 */
export async function runDast(options) {
    const now = options.now ?? (() => new Date());
    const { settings } = options;
    const reportDir = canonicalPath(options.reportDir);
    checkReportDir(options.repo, reportDir);
    // The environment file first: an address outside the loopback refuses the scan before anything runs or is written.
    const loaded = settings.envFile !== undefined ? loadDastEnvFile(settings.envFile, options.repo, options.env['HOME']) : null;
    mkdirSync(reportDir, { recursive: true });
    const command = expandCommand(settings.command, { reportDir, commit: options.commit, repo: options.repo });
    const base = environment([...DEFAULT_PASS_ENV, ...settings.passEnv], options.env);
    const env = {
        ...base, ...(loaded ? Object.fromEntries(loaded.variables) : {}),
        APV_DAST_REPORT_DIR: reportDir, APV_DAST_COMMIT: options.commit, APV_DAST_REPO: options.repo,
        ...(options.env['APV_LOCK_HELD'] ? { APV_LOCK_HELD: options.env['APV_LOCK_HELD'] } : {}),
    };
    const started = now();
    let acquired = false;
    const log = openSync(join(reportDir, DAST_LOG), 'w', 0o644);
    let code;
    let install;
    let commandMs = 0;
    try {
        // The copy prepared before the lease: an installation takes no shared resource.
        install = prepareCopy(options.repo, { ...base, ...environment(['HOME', 'USERPROFILE'], options.env) }, log, settings.timeoutMs, options.installCommand);
        if (install.status === 'failed' || install.status === 'timed_out')
            code = install.exitCode ?? 1;
        else {
            const commandStarted = now().getTime();
            code = await runLocked(options.store, settings.resource, {
                owner: options.owner, ttlSeconds: 300, waitSeconds: options.waitSeconds, purpose: `apv dast run (${options.commit.slice(0, 12)})`,
                command, cwd: options.repo, env, stderr: options.stderr, stdio: ['ignore', log, log], timeoutMs: settings.timeoutMs,
                onAcquired: () => { acquired = true; },
            });
            commandMs = now().getTime() - commandStarted;
        }
    }
    finally {
        closeSync(log);
    }
    const finished = now();
    const durationMs = finished.getTime() - started.getTime();
    const status = install.status === 'failed' ? 'failed' : install.status === 'timed_out' ? 'timed_out' : !acquired && code === LOCK_WAIT_TIMEOUT_EXIT ? 'lock_timeout'
        : code === 0 ? 'passed' : code === TIMEOUT_EXIT && commandMs >= settings.timeoutMs ? 'timed_out' : 'failed';
    const summary = {
        tool: 'apv dast run', version: VERSION, commit: options.commit, repo: options.repo, clean: options.clean,
        resource: settings.resource, command, description: settings.description ?? null,
        startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs, status, exitCode: code,
        timeoutMs: settings.timeoutMs, log: DAST_LOG, files: listFiles(reportDir), install,
        envFile: settings.envFile !== undefined ? { file: loaded.file, loaded: true, variables: loaded.variables.size } : null,
    };
    writeSummary(reportDir, summary);
    return summary;
}
//# sourceMappingURL=dast.js.map