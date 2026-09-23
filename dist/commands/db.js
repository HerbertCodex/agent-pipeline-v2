import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { formatHuman, formatJson, runDbCheck } from '../db/index.js';
export const dbHelp = `apv db check : contrôle statique du modèle de données (migrations SQL et code de l'application)

apv db check [--json] [--live] [--config FICHIER] [--root DOSSIER]
    Règles : naming.english_snake_case, fk.index, rls.enabled_forced, policy.too_broad,
    definer.search_path, definer.execute_grant, code.select_star, redundancy.user_id_guard,
    idempotency.create_tables. Configuration : champ « db » de .apv/config.json.
    --live : lit aussi la base, en lecture seule (index des clés étrangères, RLS, EXPLAIN des
    requêtes db.explain), par la commande APV_PSQL (par exemple
    APV_PSQL="docker exec -i <conteneur> psql -U postgres -d postgres") ou par psql du PATH
    avec APV_DB_URL ; sinon le dit explicitement.
Codes de sortie : 0 aucune erreur (avertissements possibles), 1 au moins une erreur, 2 usage.
`;
export async function run(args, io) {
    const [sub, ...rest] = args;
    if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
        io.stdout(dbHelp);
        return sub === undefined ? 2 : 0;
    }
    if (sub !== 'check') {
        io.stderr(`apv db : sous-commande inconnue « ${sub} »\n\n${dbHelp}`);
        return 2;
    }
    let values;
    try {
        ({ values } = parseArgs({
            args: rest, allowPositionals: false, strict: true,
            options: { json: { type: 'boolean' }, live: { type: 'boolean' }, config: { type: 'string' }, root: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
        }));
    }
    catch (error) {
        io.stderr(`apv db check : ${error.message}\n\n${dbHelp}`);
        return 2;
    }
    if (values.help) {
        io.stdout(dbHelp);
        return 0;
    }
    try {
        const report = runDbCheck({
            root: values.root ? resolve(io.cwd, values.root) : io.cwd,
            ...(values.config ? { configPath: values.config } : {}),
            live: Boolean(values.live),
            env: io.env,
        });
        io.stdout(values.json ? formatJson(report) : formatHuman(report));
        return report.errors > 0 ? 1 : 0;
    }
    catch (error) {
        io.stderr(`apv db check : ${error.message}\n`);
        return 1;
    }
}
//# sourceMappingURL=db.js.map