import { existsSync } from 'node:fs';
import { declaredTestPorts, loadConfig } from '../config/load.js';
import { canonicalPath } from '../domain/paths.js';
import { errorMessage } from '../domain/errors.js';
import { cleanLine } from '../run/summary.js';
import { listProcesses, pipelineSiblings, protectedPids, protectedTool, repositoryWorktrees, stopProcesses, worktreeOf } from '../execution/procs.js';
import { EXIT, UsageError, guard, json, parse, repoPath, table } from './common.js';
export const DEFAULT_GRACE_SECONDS = 5;
export const MAX_GRACE_SECONDS = 60;
export const usage = `Utilisation :
  apv procs list [--repo <copie>] [--port <p>]... [--include-main] [--all] [--json]
  apv procs stop [--repo <copie>] [--port <p>]... [--include-main] [--grace <secondes>] [--json]

Processus du dépôt, lus dans /proc (Linux ; ailleurs, refus clair, sortie 1) : ceux dont le répertoire
courant est dans un worktree du dépôt (git worktree list, copie principale comprise) et ceux qui
écoutent sur les ports de test déclarés (resources.<ressource>.ports de .apv/config.json).
Cibles : --port <p> (répétable) les processus qui écoutent sur ces ports ; sans --port, --repo <copie>
ceux lancés dans cette copie (un worktree lié du dépôt, jamais la copie principale, qui porte la
session) ; sans l'un ni l'autre, ceux qui écoutent sur les ports de test déclarés. Avec --port, --repo
sert seulement à trouver le dépôt (défaut : le répertoire courant).
list montre les cibles arrêtables et celles qui écoutent sur un port visé, avec leurs ports, leur
worktree et si stop les arrêterait ; --all montre aussi les autres processus des worktrees (checkout
principal, outils protégés). Les commandes du pipeline qui lance apv (| tail, | cut) n'y sont jamais.
stop n'arrête qu'un processus dont le répertoire courant est dans un worktree lié du dépôt, jamais un
processus hors du dépôt (autre projet, autre utilisateur), jamais apv ni ses parents (la session),
jamais un outil protégé (serveur d'éditeur distant comme .vscode-server, serveur de langage, serveur
MCP, session Claude Code), et jamais un processus du checkout principal (premier worktree de git
worktree list : l'éditeur et les serveurs de l'opérateur), sauf --include-main pour un processus qui
écoute sur un port de test déclaré (tous les ports visés doivent l'être) :
SIGTERM, puis SIGKILL après --grace secondes (défaut ${DEFAULT_GRACE_SECONDS}, de 0 à ${MAX_GRACE_SECONDS}) pour ceux qui tournent encore.
Sortie : 0 toutes les cibles arrêtées (ou aucune trouvée), 1 une cible refusée (hors du dépôt, protégée,
checkout principal, droit refusé) ou encore vivante, ou système sans /proc, 2 appel incorrect.`;
const options = {
    repo: { type: 'string' }, port: { type: 'string', multiple: true }, grace: { type: 'string' },
    'include-main': { type: 'boolean' }, all: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
};
const REFUSAL_LABEL = {
    outside: 'hors du dépôt : non arrêté',
    protected: 'apv ou un de ses parents : non arrêté',
    'unknown-cwd': 'répertoire courant illisible (autre utilisateur) : non arrêté',
    tool: 'protégé : outil',
    'main-checkout': 'protégé : checkout principal',
};
const OUTCOME_LABEL = {
    terminated: 'arrêté (SIGTERM)', killed: 'arrêté (SIGKILL)', survived: 'ENCORE VIVANT après SIGKILL', gone: 'déjà terminé', denied: 'signal refusé (droits)',
};
function ports(values) {
    const out = [];
    for (const value of values ?? [])
        for (const part of value.split(',').map(x => x.trim()).filter(Boolean)) {
            if (!/^\d{1,5}$/.test(part) || Number(part) < 1 || Number(part) > 65535)
                throw new UsageError(`--port invalide : ${part} (de 1 à 65535)`);
            out.push(Number(part));
        }
    return [...new Set(out)].sort((a, b) => a - b);
}
function graceSeconds(value) {
    if (value === undefined)
        return DEFAULT_GRACE_SECONDS;
    if (!/^\d{1,3}$/.test(value) || Number(value) > MAX_GRACE_SECONDS)
        throw new UsageError(`--grace invalide : ${value} (secondes, de 0 à ${MAX_GRACE_SECONDS})`);
    return Number(value);
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, options);
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (action !== 'list' && action !== 'stop')
            throw new UsageError(action ? `sous-commande inconnue : procs ${action}` : 'sous-commande manquante');
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        if (action === 'list' && values.grace !== undefined)
            throw new UsageError('--grace ne sert qu\'à stop');
        if (action === 'stop' && values.all)
            throw new UsageError('--all ne sert qu\'à list');
        const includeMain = values['include-main'] === true;
        const grace = graceSeconds(values.grace);
        const explicitPorts = ports(values.port);
        const copyPath = repoPath(io, values.repo);
        if (!existsSync(copyPath))
            throw new UsageError(`--repo : chemin introuvable : ${copyPath}`);
        const worktrees = repositoryWorktrees(copyPath);
        const main = worktrees[0];
        let declared = new Map();
        try {
            declared = declaredTestPorts(loadConfig(main).config);
        }
        catch (error) {
            io.stderr(`Attention : configuration illisible, ports de test déclarés ignorés (${errorMessage(error)})\n`);
        }
        // What is targeted: explicit ports, else the processes of an explicit copy, else the declared ports.
        let copy = null;
        let targetPorts = [];
        let mode;
        if (explicitPorts.length) {
            mode = 'ports';
            targetPorts = explicitPorts;
        }
        else if (values.repo !== undefined) {
            copy = worktreeOf(canonicalPath(copyPath), worktrees);
            if (copy === null)
                throw new UsageError(`--repo : ${copyPath} n'est dans aucun worktree du dépôt`);
            if (copy === main) {
                throw new UsageError(`--repo désigne la copie principale (${main}), qui porte la session et ses outils : visez une copie liée (git worktree list), ou un port (--port <p>)`);
            }
            mode = 'copy';
        }
        else if (action === 'list') {
            mode = 'all';
            targetPorts = [...declared.keys()];
        }
        else {
            if (!declared.size)
                throw new UsageError('aucune cible : aucun port de test déclaré (resources.<ressource>.ports de .apv/config.json) ; précisez --port <p> ou --repo <copie>');
            mode = 'ports';
            targetPorts = [...declared.keys()];
        }
        if (includeMain) {
            if (mode === 'copy')
                throw new UsageError('--include-main ne sert qu\'avec des ports de test déclarés, pas avec --repo <copie> seul');
            const undeclared = targetPorts.filter(port => !declared.has(port));
            if (undeclared.length || !targetPorts.length) {
                throw new UsageError(`--include-main ne sert qu'à un port de test déclaré (resources.<ressource>.ports de .apv/config.json) : ${undeclared.length ? `non déclaré : ${undeclared.join(', ')}` : 'aucun port déclaré'}`);
            }
        }
        const protectedSet = protectedPids();
        const all = listProcesses();
        const pipeline = pipelineSiblings(all, protectedSet);
        const session = new Set([...protectedSet, ...pipeline]);
        const selected = all.filter(p => {
            if (p.zombie)
                return false;
            // The other commands of the pipeline that runs apv (| tail, | cut) are never listed, unless they hold a targeted port.
            if (pipeline.has(p.pid) && !p.ports.some(port => targetPorts.includes(port)))
                return false;
            // The session that runs apv (its shell may sit in the copy) is never a target of a copy.
            if (mode === 'copy')
                return worktreeOf(p.cwd, [copy]) !== null && !session.has(p.pid);
            const onPort = p.ports.some(port => targetPorts.includes(port));
            if (mode === 'ports')
                return onPort;
            return onPort || (worktreeOf(p.cwd, worktrees) !== null && !session.has(p.pid));
        });
        // A process of the main checkout may be stopped only with --include-main, and only if it holds a declared test port.
        const mainAllowed = (info) => includeMain && info.ports.some(port => targetPorts.includes(port) && declared.has(port));
        const every = selected.map(info => {
            const worktree = worktreeOf(info.cwd, worktrees);
            const tool = protectedTool(info);
            const refusal = session.has(info.pid) ? 'protected' : tool !== null ? 'tool' : info.cwd === null ? 'unknown-cwd' : worktree === null ? 'outside'
                : worktree === main && !mainAllowed(info) ? 'main-checkout' : null;
            return { info, worktree, refusal, tool };
        }).sort((a, b) => a.info.pid - b.info.pid);
        // list shows by default what stop would stop and what holds a targeted port; --all shows the rest of the worktrees too.
        const shown = (c) => values.all === true || action === 'stop' || c.refusal === null || c.info.ports.some(port => targetPorts.includes(port));
        const candidates = every.filter(shown);
        const hidden = every.length - candidates.length;
        const freePorts = targetPorts.filter(port => !candidates.some(c => c.info.ports.includes(port)));
        const portLabel = (port) => declared.has(port) ? `${port} (${declared.get(port).join(', ')})` : String(port);
        let outcomes = new Map();
        if (action === 'stop') {
            const stoppable = candidates.filter(c => c.refusal === null).map(c => c.info);
            outcomes = await stopProcesses(stoppable, { graceMs: grace * 1000 });
        }
        const failed = action === 'stop' && candidates.some(c => c.refusal !== null || ['survived', 'denied'].includes(outcomes.get(c.info.pid) ?? ''));
        if (values.json) {
            json(io, {
                action, mode, repository: main, worktrees, copy, ports: targetPorts, declaredPorts: Object.fromEntries(declared), freePorts, includeMain, hidden,
                processes: candidates.map(c => ({ pid: c.info.pid, ppid: c.info.ppid, ports: c.info.ports, cwd: c.info.cwd, cwdDeleted: c.info.cwdDeleted, worktree: c.worktree,
                    command: c.info.command, exe: c.info.exe, stoppable: c.refusal === null, refusal: c.refusal, ...(c.tool ? { tool: c.tool } : {}), ...(action === 'stop' && c.refusal === null ? { outcome: outcomes.get(c.info.pid) ?? 'gone' } : {}) })),
                ok: !failed,
            });
            return failed ? EXIT.failed : EXIT.ok;
        }
        const scope = mode === 'copy' ? `processus lancés dans ${copy}` : mode === 'ports' ? `ports ${targetPorts.map(portLabel).join(', ')}`
            : `worktrees du dépôt${targetPorts.length ? ` et ports de test déclarés ${targetPorts.map(portLabel).join(', ')}` : ' (aucun port de test déclaré)'}`;
        const lines = [`Dépôt ${main} (${worktrees.length} worktree(s)) ; cibles : ${scope}`];
        if (!candidates.length)
            lines.push(action === 'stop' ? 'Aucun processus à arrêter.' : 'Aucun processus.');
        else {
            const state = (c) => c.refusal === 'tool' ? `${REFUSAL_LABEL.tool} (${c.tool})` : c.refusal ? REFUSAL_LABEL[c.refusal]
                : action === 'stop' ? OUTCOME_LABEL[outcomes.get(c.info.pid) ?? 'gone'] : 'arrêtable (apv procs stop)';
            lines.push('', table(['pid', 'ports', 'worktree', 'état', 'commande'], candidates.map(c => [String(c.info.pid), c.info.ports.join(',') || '-',
                c.worktree ? `${c.worktree}${c.info.cwdDeleted ? ' (dossier supprimé)' : ''}` : (c.info.cwd ?? '?'), state(c), cleanLine(c.info.command, 80)])));
        }
        if (hidden)
            lines.push('', `${hidden} autre(s) processus des worktrees masqué(s), ni arrêtable(s) ni sur un port visé (checkout principal, outils protégés) : --all pour tout voir.`);
        if (mode !== 'copy' && freePorts.length)
            lines.push('', `Ports libres : ${freePorts.map(portLabel).join(', ')}.`);
        if (candidates.some(c => c.refusal === 'main-checkout')) {
            lines.push('', `Checkout principal (${main}) : ses processus (éditeur, serveurs et outils de l'opérateur) ne sont jamais arrêtés par défaut. `
                + (includeMain ? '--include-main ne vaut que pour un processus qui écoute sur un port de test déclaré.' : 'Un serveur de test qui y tient un port de test déclaré (resources) s\'arrête avec --include-main.'));
        }
        if (action === 'stop' && candidates.length) {
            const stopped = candidates.filter(c => ['terminated', 'killed', 'gone'].includes(outcomes.get(c.info.pid) ?? '') && c.refusal === null).length;
            lines.push('', failed
                ? `${stopped} processus arrêté(s) ; les autres ne l'ont pas été (voir l'état) : un processus hors du dépôt ou d'un autre utilisateur se traite à la main, avec l'opérateur.`
                : `${stopped} processus arrêté(s).`);
        }
        io.stdout(`${lines.join('\n')}\n`);
        return failed ? EXIT.failed : EXIT.ok;
    });
}
//# sourceMappingURL=procs.js.map