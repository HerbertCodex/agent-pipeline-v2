import { canonicalPath } from '../domain/paths.js';
import { VERSION } from '../domain/contracts.js';
import { errorMessage } from '../domain/errors.js';
/**
 * Every `apv` command lives in `src/commands/<name>.ts` and exports `run(args, io)`. Modules load lazily:
 * a module that fails to load is reported as unavailable instead of breaking the others.
 */
export const commands = {
    init: { summary: 'init [--name <nom>] : crée ce qui manque dans .apv/ (configuration, registre, consigne, specs, état) sans rien écraser', load: () => import('./init.js') },
    spec: { summary: 'spec validate <fichier> | new <id> : valide une spec (minimum de sécurité recalculé) ou en écrit le gabarit', load: () => import('./spec.js') },
    run: { summary: 'run start|set|next|status : état de reprise d\'une exécution de spec (vagues, tâches, revues)', load: () => import('./run.js') },
    stack: { summary: 'stack plan|merge <pr...> : vérifie puis fusionne une pile de PR dans l\'ordre (fusion : APV_ALLOW_MERGE=1)', load: () => import('./stack.js') },
    ledger: { summary: 'ledger validate|plan|apply : registre des décisions', load: () => import('./ledger.js') },
    scope: { summary: 'scope check --spec <fichier> --task <id> : fichiers modifiés contre les chemins autorisés', load: () => import('./scope.js') },
    gates: { summary: 'gates run [--only a,b] : exécute les contrôles déclarés et écrit des reçus', load: () => import('./gates.js') },
    lock: { summary: 'lock run|acquire|release|status <ressource> : verrous à bail (propriétaire vérifié, expiration, file d\'attente)', load: () => import('./lock.js') },
    db: { summary: 'db check [--live] : contrôle du modèle de données (migrations, code, base en lecture seule)', load: () => import('./db.js') },
    design: { summary: 'design register|list|check : maquettes validées (copie, empreinte, décision au registre, dérive)', load: () => import('./design.js') },
    quota: { summary: 'quota : relève l\'usage (session, semaine) et le journalise', load: () => import('./quota.js') },
    preview: { summary: 'preview update [branche]|status|stop|logs : aperçu vivant (copie de la branche, build, serveur détaché)', load: () => import('./preview.js') },
    status: { summary: 'status : résumé de .apv/ (configuration, registre, specs, état, quota)', load: () => import('./status.js') },
};
export function helpText() {
    return [`apv ${VERSION} : outil d'Agent Pipeline V3 (sans contrôleur)`, '', 'Utilisation : apv <commande> [arguments] [--json]', '', 'Commandes :',
        ...Object.values(commands).map(c => `  apv ${c.summary}`),
        '  apv help [commande] : aide générale ou d\'une commande', '',
        'Sortie : 0 succès, 1 échec du contrôle, 2 appel incorrect ou commande indisponible.'].join('\n');
}
async function load(name, io) {
    try {
        return await commands[name].load();
    }
    catch (error) {
        io.stderr(`apv ${name} : non disponible dans cette installation (${errorMessage(error)})\n`);
        return null;
    }
}
export async function dispatch(argv, input) {
    // Files given relative to the working directory are compared with Git's resolved roots.
    const io = { ...input, cwd: canonicalPath(input.cwd) };
    const [name, ...args] = argv;
    if (!name || name === '--help' || name === '-h') {
        io.stdout(`${helpText()}\n`);
        return name ? 0 : 2;
    }
    if (name === '--version' || name === '-v' || name === 'version') {
        io.stdout(`${VERSION}\n`);
        return 0;
    }
    if (name === 'help') {
        const [topic] = args;
        if (!topic) {
            io.stdout(`${helpText()}\n`);
            return 0;
        }
        if (!Object.hasOwn(commands, topic)) {
            io.stderr(`Commande inconnue : ${topic}\n\n${helpText()}\n`);
            return 2;
        }
        const module = await load(topic, io);
        return module ? module.run(['--help'], io) : 2;
    }
    if (!Object.hasOwn(commands, name)) {
        io.stderr(`Commande inconnue : ${name}\n\n${helpText()}\n`);
        return 2;
    }
    const module = await load(name, io);
    return module ? module.run(args, io) : 2;
}
//# sourceMappingURL=index.js.map