import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
export const DEFAULT_DB_CONFIG = {
    migrations: ['supabase/migrations/*.sql'],
    codeGlobs: ['src/**/*.ts', 'src/**/*.js', 'src/**/*.svelte'],
    codeExclude: ['**/*.test.*', '**/*.spec.*'],
    allowFrench: [],
    exceptions: [],
    rlsTables: [],
    explain: [],
    seqScanRows: 10_000,
    supabaseDefaults: true,
    liveSchemas: ['public'],
};
const stringList = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string');
/** Reads `db` from `.apv/config.json` (or `configPath`); unknown or invalid fields are reported, never ignored silently. */
export function loadDbConfig(root, configPath) {
    const path = configPath ? resolve(root, configPath) : join(root, '.apv', 'config.json');
    const config = structuredClone(DEFAULT_DB_CONFIG);
    const problems = [];
    if (!existsSync(path)) {
        if (configPath)
            problems.push(`fichier de configuration introuvable : ${path}`);
        return { config, path: null, problems };
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        problems.push(`${path} : JSON invalide (${error.message})`);
        return { config, path, problems };
    }
    const db = raw?.db;
    if (db === undefined)
        return { config, path, problems };
    if (!db || typeof db !== 'object' || Array.isArray(db)) {
        problems.push(`${path} : le champ « db » doit être un objet`);
        return { config, path, problems };
    }
    for (const [key, value] of Object.entries(db)) {
        switch (key) {
            case 'migrations':
                if (typeof value === 'string')
                    config.migrations = [value];
                else if (stringList(value))
                    config.migrations = value;
                else
                    problems.push('db.migrations : chaîne ou liste de chaînes attendue');
                break;
            case 'code':
                if (stringList(value))
                    config.codeGlobs = value;
                else
                    problems.push('db.code : liste de chaînes attendue');
                break;
            case 'codeExclude':
            case 'allowFrench':
            case 'rlsTables':
            case 'liveSchemas':
                if (stringList(value))
                    config[key] = value;
                else
                    problems.push(`db.${key} : liste de chaînes attendue`);
                break;
            case 'seqScanRows':
                if (typeof value === 'number' && value >= 0)
                    config.seqScanRows = value;
                else
                    problems.push('db.seqScanRows : nombre positif attendu');
                break;
            case 'supabaseDefaults':
                if (typeof value === 'boolean')
                    config.supabaseDefaults = value;
                else
                    problems.push('db.supabaseDefaults : booléen attendu');
                break;
            case 'exceptions':
                if (!Array.isArray(value)) {
                    problems.push('db.exceptions : liste attendue');
                    break;
                }
                value.forEach((item, index) => {
                    const e = item;
                    if (!e || typeof e.rule !== 'string' || typeof e.target !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()) {
                        problems.push(`db.exceptions[${index}] : { rule, target, reason } attendus, raison non vide`);
                    }
                    else {
                        config.exceptions.push({ rule: e.rule, target: e.target, reason: e.reason });
                    }
                });
                break;
            case 'explain':
                if (!Array.isArray(value)) {
                    problems.push('db.explain : liste attendue');
                    break;
                }
                value.forEach((item, index) => {
                    const q = item;
                    if (!q || typeof q.name !== 'string' || typeof q.sql !== 'string' || !q.sql.trim())
                        problems.push(`db.explain[${index}] : { name, sql } attendus`);
                    else
                        config.explain.push({ name: q.name, sql: q.sql });
                });
                break;
            default:
                problems.push(`db.${key} : champ inconnu`);
        }
    }
    return { config, path, problems };
}
//# sourceMappingURL=config.js.map