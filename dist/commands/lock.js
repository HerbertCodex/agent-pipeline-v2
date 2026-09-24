import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { LockStore, defaultLockDir, parseDuration, sanitizeResource } from '../lock/store.js';
import { LOCK_WAIT_TIMEOUT_EXIT, describeHolder, runLocked, signalExitCode, waitReporter } from '../lock/run.js';
import { spawn } from 'node:child_process';
import { localTime } from '../domain/time.js';
export const lockHelp = `apv lock : verrous à bail pour les ressources partagées (base de test, ports, navigateur)

apv lock run <ressource> [--ttl 900] [--wait 1800] [--label L] [--purpose P] -- <commande...>
    Prend le verrou, lance la commande, renouvelle le bail pendant qu'elle tourne et libère
    à la sortie (succès, échec ou SIGINT/SIGTERM). Renvoie le code de sortie de la commande.
apv lock acquire <ressource> [--ttl 900] [--wait 1800] [--label L] [--purpose P] [--pid N] [--json]
    Prend le verrou et rend la main. Sans --pid, seul le bail protège le verrou (pas de
    renouvellement) : préférer « run ». Affiche le jeton à fournir à « release ».
apv lock release <ressource> [--token T] [--force --reason "..."]
    Seul le propriétaire libère (jeton, variable APV_LOCK_TOKEN, ou même pid) ; --force exige une raison.
apv lock status [ressource] [--json]
    Détenteurs, âge, échéance, état (périmé ou non) et file d'attente.

Options communes : --dir DOSSIER (sinon APV_LOCK_DIR, sinon \${XDG_STATE_HOME:-~/.local/state}/apv/locks).
Durées en secondes ou avec unité (90s, 15m, 2h).
Codes de sortie : 0 succès, 1 refus ou erreur, 2 usage, ${LOCK_WAIT_TIMEOUT_EXIT} délai d'attente dépassé.
Réentrance : si APV_LOCK_HELD contient la ressource (posée par « run »), la commande est lancée sans reprendre le verrou.
`;
const DEFAULT_TTL = 900;
const DEFAULT_WAIT = 1800;
class UsageError extends Error {
}
function store(values, io) {
    const dir = values.dir ? resolve(io.cwd, values.dir) : defaultLockDir(io.env);
    const poll = io.env.APV_LOCK_POLL_MS ? Number(io.env.APV_LOCK_POLL_MS) : undefined;
    return new LockStore(dir, poll && Number.isFinite(poll) ? { pollMs: poll } : {});
}
function defaultLabel(io) {
    return io.env.APV_LOCK_LABEL || io.env.USER || 'inconnu';
}
function seconds(value, fallback, name) {
    if (value === undefined)
        return fallback;
    try {
        return parseDuration(value, name);
    }
    catch (error) {
        throw new UsageError(error.message);
    }
}
function formatAge(ms) {
    const s = Math.round(Math.abs(ms) / 1000);
    const text = s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
    return ms < 0 ? `dépassé de ${text}` : text;
}
const commonOptions = {
    dir: { type: 'string' },
    ttl: { type: 'string' },
    wait: { type: 'string' },
    label: { type: 'string' },
    purpose: { type: 'string' },
    pid: { type: 'string' },
    token: { type: 'string' },
    force: { type: 'boolean' },
    reason: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
};
function heldResources(env) {
    return (env.APV_LOCK_HELD ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
async function runCommand(rest, io) {
    const separator = rest.indexOf('--');
    if (separator < 0)
        throw new UsageError('« run » attend « -- » suivi de la commande à lancer');
    const command = rest.slice(separator + 1);
    if (command.length === 0)
        throw new UsageError('commande vide après « -- »');
    const { values, positionals } = parseArgs({ args: rest.slice(0, separator), allowPositionals: true, strict: true, options: commonOptions });
    const resource = positionals[0];
    if (!resource || positionals.length > 1)
        throw new UsageError('« run » attend exactement une ressource');
    const ttlSeconds = seconds(values.ttl, DEFAULT_TTL, '--ttl');
    const waitSeconds = seconds(values.wait, DEFAULT_WAIT, '--wait');
    const locks = store(values, io);
    const owner = { pid: process.pid, host: locks.host, label: values.label ?? defaultLabel(io) };
    if (heldResources(io.env).map(sanitizeResource).includes(sanitizeResource(resource))) {
        const current = locks.read(resource);
        if (current.exists && !locks.staleness(current)) {
            io.stderr(`Verrou « ${resource} » déjà tenu par un processus parent (APV_LOCK_HELD) : commande lancée sans le reprendre.\n`);
            return runUnlocked(command, io);
        }
        io.stderr(`APV_LOCK_HELD mentionne « ${resource} » mais le verrou n'est plus tenu : il est repris normalement.\n`);
    }
    return runLocked(locks, resource, {
        owner, ttlSeconds, waitSeconds, purpose: values.purpose ?? command.join(' ').slice(0, 200),
        command, cwd: io.cwd, env: io.env, stderr: io.stderr,
    });
}
async function runUnlocked(command, io) {
    const [file, ...args] = command;
    return new Promise((done) => {
        const child = spawn(file, args, { cwd: io.cwd, env: io.env, stdio: 'inherit' });
        child.once('error', (error) => { io.stderr(`Impossible de lancer « ${file} » : ${error.message}\n`); done(127); });
        child.once('exit', (code, signal) => done(code ?? signalExitCode(signal ?? 'SIGTERM')));
    });
}
async function acquireCommand(rest, io) {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: commonOptions });
    const resource = positionals[0];
    if (!resource || positionals.length > 1)
        throw new UsageError('« acquire » attend exactement une ressource');
    const ttlSeconds = seconds(values.ttl, DEFAULT_TTL, '--ttl');
    const waitSeconds = seconds(values.wait, DEFAULT_WAIT, '--wait');
    let pid = null;
    if (values.pid !== undefined) {
        pid = Number(values.pid);
        if (!Number.isInteger(pid) || pid < 0)
            throw new UsageError(`--pid invalide : « ${values.pid} »`);
        if (pid === 0)
            pid = null;
    }
    const locks = store(values, io);
    const owner = { pid, host: locks.host, label: values.label ?? defaultLabel(io) };
    const result = await locks.acquire(resource, {
        owner, ttlSeconds, waitSeconds, purpose: values.purpose ?? '',
        onWait: waitReporter(resource, io.stderr),
    });
    if (!result.ok) {
        io.stderr(`Verrou « ${resource} » non obtenu après ${waitSeconds} s : tenu par ${describeHolder(result.holder)}.\n`);
        return LOCK_WAIT_TIMEOUT_EXIT;
    }
    if (result.takeover)
        io.stderr(`Verrou « ${resource} » repris (${result.takeover.reason}) à ${describeHolder(result.takeover.previous)}.\n`);
    if (values.json) {
        io.stdout(`${JSON.stringify(result.record, null, 2)}\n`);
    }
    else {
        io.stdout(`Verrou « ${resource} » acquis jusqu'à ${localTime(result.record.expiresAt)}${pid === null ? ' (bail seul, sans renouvellement)' : ''}.\n`);
        io.stdout(`Jeton : ${result.record.token}\n`);
        io.stdout(`Libération : apv lock release ${resource} --token ${result.record.token}\n`);
    }
    return 0;
}
async function releaseCommand(rest, io) {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: commonOptions });
    const resource = positionals[0];
    if (!resource || positionals.length > 1)
        throw new UsageError('« release » attend exactement une ressource');
    if (values.force && !values.reason?.trim())
        throw new UsageError('--force exige --reason "..." (la raison est journalisée)');
    const locks = store(values, io);
    const token = values.token ?? io.env.APV_LOCK_TOKEN;
    const result = await locks.release(resource, {
        ...(token ? { token } : {}),
        callerPids: [process.pid, process.ppid],
        force: Boolean(values.force),
        ...(values.reason ? { reason: values.reason } : {}),
    });
    switch (result.status) {
        case 'released':
            io.stdout(`Verrou « ${resource} » libéré.\n`);
            return 0;
        case 'forced':
            io.stdout(`Verrou « ${resource} » libéré de force (raison journalisée : ${values.reason}). Ancien détenteur : ${describeHolder(result.previous)}.\n`);
            return 0;
        case 'not_held':
            io.stdout(`Verrou « ${resource} » : personne ne le tient.\n`);
            return 0;
        case 'refused':
            io.stderr(`Refusé : le verrou « ${resource} » appartient à ${describeHolder(result.holder)}. Fournir --token, ou --force --reason "..." pour une libération forcée journalisée.\n`);
            return 1;
    }
}
function statusCommand(rest, io) {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: commonOptions });
    if (positionals.length > 1)
        throw new UsageError('« status » accepte au plus une ressource');
    const locks = store(values, io);
    const wanted = positionals[0] ? sanitizeResource(positionals[0]) : null;
    const rows = locks.list().filter((row) => !wanted || sanitizeResource(row.resource) === wanted);
    const now = Date.now();
    if (values.json) {
        io.stdout(`${JSON.stringify({
            dir: locks.dir,
            locks: rows.map((row) => ({
                resource: row.resource,
                held: row.snapshot.exists,
                record: row.snapshot.record,
                stale: row.stale,
                ageSeconds: row.snapshot.record ? Math.round((now - Date.parse(row.snapshot.record.acquiredAt)) / 1000) : null,
                expiresInSeconds: row.snapshot.record ? Math.round((Date.parse(row.snapshot.record.expiresAt) - now) / 1000) : null,
                queue: row.waiters.map((w) => ({ owner: w.owner, enqueuedAt: w.enqueuedAt })),
            })),
        }, null, 2)}\n`);
        return 0;
    }
    if (rows.length === 0) {
        io.stdout(wanted ? `Verrou « ${positionals[0]} » : libre, file vide (${locks.dir}).\n` : `Aucun verrou ni attente dans ${locks.dir}.\n`);
        return 0;
    }
    for (const row of rows) {
        const record = row.snapshot.record;
        const state = !row.snapshot.exists ? 'libre' : row.stale ? `périmé (${row.stale}), sera repris` : 'tenu';
        io.stdout(`${row.resource} : ${state}\n`);
        if (record) {
            io.stdout(`  détenteur : ${record.owner.label} (${record.owner.pid === null ? 'bail seul' : `pid ${record.owner.pid}`} sur ${record.owner.host})\n`);
            if (record.purpose)
                io.stdout(`  objet : ${record.purpose}\n`);
            io.stdout(`  âge : ${formatAge(now - Date.parse(record.acquiredAt))} ; dernier battement il y a ${formatAge(now - Date.parse(record.heartbeatAt))} ; expire dans ${formatAge(Date.parse(record.expiresAt) - now)}\n`);
        }
        else if (row.snapshot.exists) {
            io.stdout('  fichier de verrou illisible (écriture en cours ou corrompu)\n');
        }
        row.waiters.forEach((waiter, index) => {
            io.stdout(`  file ${index + 1} : ${waiter.owner.label} (${waiter.owner.pid === null ? 'sans pid' : `pid ${waiter.owner.pid}`} sur ${waiter.owner.host}) depuis ${localTime(waiter.enqueuedAt)}\n`);
        });
    }
    return 0;
}
export async function run(args, io) {
    const [sub, ...rest] = args;
    const beforeCommand = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
    if (beforeCommand.includes('--help') || beforeCommand.includes('-h')) {
        io.stdout(lockHelp);
        return 0;
    }
    try {
        switch (sub) {
            case 'run': return await runCommand(rest, io);
            case 'acquire': return await acquireCommand(rest, io);
            case 'release': return await releaseCommand(rest, io);
            case 'status': return statusCommand(rest, io);
            case undefined:
            case 'help':
            case '--help':
            case '-h':
                io.stdout(lockHelp);
                return sub === undefined ? 2 : 0;
            default:
                throw new UsageError(`sous-commande inconnue : « ${sub} »`);
        }
    }
    catch (error) {
        if (error instanceof UsageError || error.code?.startsWith('ERR_PARSE_ARGS')) {
            io.stderr(`apv lock : ${error.message}\n\n${lockHelp}`);
            return 2;
        }
        io.stderr(`apv lock : ${error.message}\n`);
        return 1;
    }
}
//# sourceMappingURL=lock.js.map