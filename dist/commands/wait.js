import { resolve } from 'node:path';
import { DEFAULT_POLL_MS, MAX_WAIT_SECONDS, waitFor } from '../execution/wait.js';
import { cleanLine } from '../run/summary.js';
import { EXIT, UsageError, guard, json, parse } from './common.js';
export const usage = `Utilisation :
  apv wait --pid <pid> [--timeout <secondes>] [--json]
  apv wait --file <chemin> [--contains <texte>] [--timeout <secondes>] [--json]

Attente bornée, pour une session qui ne peut pas attendre autrement (sleep, tail --pid et boucles
kill -0 refusés en session non interactive) : un seul appel attend au plus ${MAX_WAIT_SECONDS} s, sous la
limite de dix minutes d'un appel Bash.
--pid       attend la fin du processus (absent, ou zombie qui attend son parent). Le code de sortie
            du processus n'est pas connu de l'outil : lire son journal ou ses reçus.
--file      attend que le fichier existe ; avec --contains, qu'il contienne le texte (seuls les
            octets ajoutés depuis le relevé précédent sont relus ; fichier ordinaire seulement).
--timeout   délai en secondes, de 1 à ${MAX_WAIT_SECONDS} (défaut ${MAX_WAIT_SECONDS}). Relevé toutes les secondes.
Sortie : 0 condition remplie (« Terminé »), 1 délai dépassé (« Délai dépassé » : relancer apv wait
pour attendre encore), 2 appel incorrect.`;
const options = {
    pid: { type: 'string' }, file: { type: 'string' }, contains: { type: 'string' }, timeout: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
};
function condition(values, io) {
    if ((values.pid === undefined) === (values.file === undefined))
        throw new UsageError('une condition, et une seule : --pid <pid> ou --file <chemin>');
    if (values.pid !== undefined) {
        if (values.contains !== undefined)
            throw new UsageError('--contains accompagne --file');
        if (!/^\d{1,10}$/.test(values.pid))
            throw new UsageError(`--pid invalide : ${values.pid}`);
        const pid = Number(values.pid);
        // 0 and 1 name a process group and init; our own pid would never end while we wait.
        if (pid <= 1 || pid > 2 ** 31 - 1)
            throw new UsageError(`--pid invalide : ${values.pid}`);
        if (pid === process.pid)
            throw new UsageError('--pid : le processus de apv wait lui-même');
        return { kind: 'pid', pid };
    }
    if (!values.file)
        throw new UsageError('--file : chemin vide');
    if (values.contains !== undefined && !values.contains)
        throw new UsageError('--contains : texte vide');
    return { kind: 'file', path: resolve(io.cwd, values.file), ...(values.contains !== undefined ? { contains: values.contains } : {}) };
}
function timeoutSeconds(value) {
    if (value === undefined)
        return MAX_WAIT_SECONDS;
    if (!/^\d{1,6}$/.test(value) || Number(value) < 1 || Number(value) > MAX_WAIT_SECONDS) {
        throw new UsageError(`--timeout invalide : ${value} (secondes, de 1 à ${MAX_WAIT_SECONDS}, sous la limite d'un appel Bash ; relancer apv wait pour attendre plus)`);
    }
    return Number(value);
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, options);
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        if (positionals.length)
            throw new UsageError(`argument inattendu : ${positionals.join(' ')}`);
        const target = condition(values, io);
        const timeout = timeoutSeconds(values.timeout);
        const configured = Number(io.env['APV_WAIT_POLL_MS']);
        const pollMs = io.env['APV_WAIT_POLL_MS'] && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POLL_MS;
        const result = await waitFor(target, { timeoutSeconds: timeout, pollMs });
        const what = target.kind === 'pid' ? `le processus ${target.pid}`
            : `${cleanLine(target.path, 300)}${target.contains !== undefined ? ` (texte « ${cleanLine(target.contains, 100)} »)` : ''}`;
        if (values.json) {
            json(io, { condition: target.kind, ...(target.kind === 'pid' ? { pid: target.pid } : { file: target.path, contains: target.contains ?? null }),
                met: result.met, immediate: result.immediate, waitedSeconds: result.waitedSeconds, timeoutSeconds: timeout });
            return result.met ? EXIT.ok : EXIT.failed;
        }
        if (result.met) {
            const how = target.kind === 'pid'
                ? `${what} ${result.immediate ? 'n\'existait déjà plus au premier relevé' : `est terminé après ${result.waitedSeconds} s`} (son code de sortie : dans son journal ou ses reçus)`
                : `${what} ${target.contains !== undefined ? 'contient le texte' : 'existe'}${result.immediate ? ' dès le premier relevé' : ` après ${result.waitedSeconds} s`}`;
            io.stdout(`Terminé : ${how}.\n`);
            return EXIT.ok;
        }
        const still = target.kind === 'pid' ? `${what} tourne encore` : `${what} ${target.contains !== undefined ? 'ne contient pas encore le texte' : 'n\'existe pas encore'}`;
        io.stdout(`Délai dépassé : ${still} après ${timeout} s. Relancer apv wait pour attendre encore.\n`);
        return EXIT.failed;
    });
}
//# sourceMappingURL=wait.js.map