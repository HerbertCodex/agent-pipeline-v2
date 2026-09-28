import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../config/load.js';
import { PipelineError } from '../domain/errors.js';
import { parseDuration } from '../lock/store.js';
import { gitRoot } from '../run/git-probe.js';
import { DEFAULT_IDLE_AFTER_MS } from '../stacks/config.js';
import { WATCH_INTERVAL_MS, commonDir, flockFree, idlePass, journal, probe, readRecord, resolveStacks, underStackLock, writeRecord, } from '../stacks/idle.js';
import { EXIT, UsageError, guard, json, parse, repoPath, table } from './common.js';
export const usage = `Utilisation :
  apv stacks status [--repo <chemin>] [--json]
  apv stacks idle-stop [--after <durée>] [--stack <id>]... [--dry-run] [--watch] [--interval <s>]
                       [--repo <chemin>] [--json]
  apv stacks start <id> [--repo <chemin>] [--json]

Piles de test déclarées (stacks de .apv/config.json : verrou lockFile ou resource, ports, commandes
stop et start).
status     pour chaque pile : verrou libre ou tenu, occupation (suite complète en cours, ports à
           l'écoute), dernière utilisation connue, inactive depuis, arrêtée ou redémarrée.
idle-stop  arrête (commande stop, sous le verrou de la pile et de la file des suites, pris sans
           attendre) chaque pile inactive depuis au moins --after (défaut : idleAfterMs de la pile,
           sinon 30 min) : aucun verrou de la pile tenu, aucune suite complète en cours, rien à
           l'écoute sur ses ports. L'inactivité se prouve par des passages successifs, espacés de
           2 min au plus, qui la trouvent libre, sans utilisation connue depuis le premier (fin d'un
           contrôle de apv gates run sous son verrou, événement de son bail apv lock) : un passage
           isolé n'arrête jamais rien. --watch repasse toutes les --interval secondes (30 par défaut)
           jusqu'à ce que chaque pile visée soit arrêtée, ou SIGINT. --dry-run n'arrête rien.
           Journal : <répertoire git commun>/apv/stacks/events.log.
start      redémarre une pile (commande start, sous son verrou pris sans attendre).
Sortie : 0 succès, 1 commande stop ou start en échec, pile inconnue ou occupée, 2 appel incorrect.`;
const options = {
    repo: { type: 'string' }, after: { type: 'string' }, stack: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' },
    watch: { type: 'boolean' }, interval: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
};
const ago = (iso, now = Date.now()) => {
    if (!iso)
        return '-';
    const ms = now - Date.parse(iso);
    return ms < 60_000 ? `il y a ${Math.round(ms / 1000)} s` : ms < 7_200_000 ? `il y a ${Math.floor(ms / 60_000)} min` : `il y a ${Math.floor(ms / 3_600_000)} h`;
};
const LABEL = { stopped: 'ARRÊTÉE', failed: 'ARRÊT EN ÉCHEC', 'would-stop': 'serait arrêtée (--dry-run)', kept: 'gardée' };
function decisionLine(d) {
    if (d.action === 'kept')
        return `pile ${d.id} : gardée : ${d.reason}`;
    if (d.action === 'would-stop')
        return `pile ${d.id} : ${LABEL[d.action]}, inactive depuis ${Math.floor(d.idleMs / 60_000)} min`;
    return `pile ${d.id} : ${LABEL[d.action]} après ${Math.floor(d.idleMs / 60_000)} min d'inactivité${d.action === 'failed' ? ` : ${d.output.slice(-500)}` : ''}`;
}
function select(stacks, ids) {
    if (!ids?.length)
        return stacks;
    const unknown = ids.filter(id => !stacks.some(s => s.id === id));
    if (unknown.length)
        throw new PipelineError('STACK_UNKNOWN', `Pile inconnue : ${unknown.join(', ')} (déclarées : ${stacks.map(s => s.id).join(', ') || 'aucune'})`);
    return stacks.filter(s => ids.includes(s.id));
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, options);
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (action !== 'status' && action !== 'idle-stop' && action !== 'start')
            throw new UsageError(action ? `sous-commande inconnue : stacks ${action}` : 'sous-commande manquante (status, idle-stop, start)');
        const own = { status: [], 'idle-stop': ['after', 'stack', 'dry-run', 'watch', 'interval'], start: [] };
        const foreign = ['after', 'stack', 'dry-run', 'watch', 'interval'].filter(k => values[k] !== undefined && !own[action].includes(k));
        if (foreign.length)
            throw new UsageError(`option(s) sans effet pour stacks ${action} : --${foreign.join(', --')}`);
        if (action !== 'start' && rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        const repo = gitRoot(repoPath(io, values.repo));
        const config = loadConfig(repo).config;
        const common = commonDir(repo);
        const context = { repo, common, config, env: io.env };
        const stacks = resolveStacks(config, common);
        if (!stacks.length) {
            if (values.json)
                json(io, { stacks: [] });
            else
                io.stdout('Aucune pile de test déclarée (stacks de .apv/config.json) : rien à surveiller ni à arrêter.\n');
            return EXIT.ok;
        }
        if (action === 'status') {
            const rows = stacks.map(stack => {
                const record = readRecord(common, stack.id);
                const busy = probe(stack, context);
                return { id: stack.id, lock: stack.lockFile ?? `bail ${stack.resource}`, lockFree: stack.lockFile ? flockFree(stack.lockFile) : null, busy,
                    lastUsedAt: record.lastUsedAt, freeSince: busy.length ? null : record.freeSince, stoppedAt: record.stoppedAt, startedAt: record.startedAt,
                    stop: stack.config.stop ?? null, start: stack.config.start ?? null, idleAfterMs: stack.config.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS };
            });
            if (values.json) {
                json(io, { stacks: rows });
                return EXIT.ok;
            }
            io.stdout(`${table(['pile', 'état', 'dernière utilisation', 'libre depuis', 'arrêtée', 'redémarrée'], rows.map(r => [r.id,
                r.busy.length ? `occupée (${r.busy.join(' ; ')})` : 'libre', ago(r.lastUsedAt), ago(r.freeSince), ago(r.stoppedAt), ago(r.startedAt)]))}\n` +
                rows.map(r => `pile ${r.id} : arrêt ${r.stop ? r.stop.join(' ') : 'non déclaré'} ; redémarrage ${r.start ? `apv stacks start ${r.id} (${r.start.join(' ')})` : 'non déclaré'}`).join('\n') + '\n');
            return EXIT.ok;
        }
        if (action === 'start') {
            const [id, ...extra] = rest;
            if (!id)
                throw new UsageError('stacks start attend l\'identifiant d\'une pile');
            if (extra.length)
                throw new UsageError(`argument inattendu : ${extra.join(' ')}`);
            const [stack] = select(stacks, [id]);
            if (!stack.config.start)
                throw new PipelineError('STACK_START', `La pile ${id} ne déclare pas de commande start (stacks de .apv/config.json).`);
            const result = await underStackLock(stack, context, stack.config.start, 'start');
            if (result === null) {
                if (values.json)
                    json(io, { id, started: false, reason: 'busy' });
                else
                    io.stdout(`Pile ${id} : verrou tenu (pile en usage, donc démarrée) ou suite complète en cours : rien n'a été lancé.\n`);
                return EXIT.failed;
            }
            if (result.ok) {
                const now = new Date().toISOString();
                writeRecord(common, { ...readRecord(common, id), startedAt: now, lastUsedAt: now, freeSince: null });
            }
            journal(common, { event: result.ok ? 'started' : 'start-failed', stack: id, command: stack.config.start, output: result.output.slice(-1000) });
            if (values.json)
                json(io, { id, started: result.ok, output: result.output });
            else
                io.stdout(`Pile ${id} : ${result.ok ? 'redémarrée' : 'redémarrage en échec'}.\n${result.output}\n`);
            return result.ok ? EXIT.ok : EXIT.failed;
        }
        // idle-stop
        const afterMs = values.after !== undefined ? (() => {
            try {
                return parseDuration(values.after, '--after') * 1000;
            }
            catch (error) {
                throw new UsageError(error.message);
            }
        })() : undefined;
        if (afterMs !== undefined && afterMs < 60_000)
            throw new UsageError('--after : une minute au moins');
        const intervalMs = values.interval !== undefined ? Number(values.interval) * 1000 : WATCH_INTERVAL_MS;
        if (!Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 110_000)
            throw new UsageError('--interval attend un nombre de secondes entre 0.1 et 110 (sous l\'écart de 2 min d\'une série)');
        const chosen = select(stacks, values.stack);
        const dryRun = values['dry-run'] === true;
        const passes = [];
        const abort = new AbortController();
        const onSignal = () => abort.abort();
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
        try {
            for (;;) {
                const decisions = await idlePass(chosen, context, { ...(afterMs !== undefined ? { afterMs } : {}), dryRun });
                passes.push(decisions);
                if (!values.json)
                    io.stdout(`${new Date().toLocaleTimeString('fr-FR')} ${decisions.map(decisionLine).join('\n')}\n`);
                const pending = chosen.filter(s => s.config.stop && !decisions.some(d => d.id === s.id && (d.action === 'stopped' || d.action === 'would-stop' ||
                    (d.action === 'kept' && d.reason.startsWith('déjà arrêtée')))));
                if (!values.watch || !pending.length || abort.signal.aborted)
                    break;
                try {
                    await sleep(intervalMs, undefined, { signal: abort.signal });
                }
                catch {
                    break;
                }
            }
        }
        finally {
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
        }
        const last = passes[passes.length - 1] ?? [];
        if (values.json)
            json(io, { passes: passes.length, decisions: last, all: passes });
        return last.some(d => d.action === 'failed') ? EXIT.failed : EXIT.ok;
    });
}
//# sourceMappingURL=stacks.js.map