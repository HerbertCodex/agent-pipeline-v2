import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { configIssues, LEGACY_CONFIG_FILE } from '../config/load.js';
import { decisionLedgerIssues, decisionLedgerMarkdown, decisionLedgerSchema, ledgerHash, LEGACY_LEDGER_FILE } from '../lifecycle/decisions.js';
/**
 * What APV3 reads from a V2 `pipeline.v2.json` (spec, section 14): gates, risk, validation rules, skills and
 * the passed environment. Everything else (agents, budgets, delays, model profiles, tuning) belonged to the
 * removed controller and is listed as ignored, never copied.
 */
export const V2_KEPT_SECTIONS = ['gates', 'risk', 'validationRules', 'skills'];
export const V2_KEPT = [...V2_KEPT_SECTIONS, 'environment.passEnv'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function readJson(repo, file) {
    let text;
    try {
        text = readFileSync(join(repo, file), 'utf8');
    }
    catch (error) {
        throw new PipelineError('ONBOARD_V2', `${file} illisible : ${errorMessage(error)}. Rien n'est écrit.`);
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new PipelineError('ONBOARD_V2', `${file} n'est pas un JSON valide (${errorMessage(error)}). Rien n'est écrit : corrigez le fichier, puis relancez apv onboard.`);
    }
}
/** Picks the kept sections of a V2 configuration and validates them as a V3 configuration; refuses with every problem. */
export function importV2Config(repo, name) {
    const raw = readJson(repo, LEGACY_CONFIG_FILE);
    if (!isObject(raw))
        throw new PipelineError('ONBOARD_V2', `${LEGACY_CONFIG_FILE} doit contenir un objet JSON. Rien n'est écrit.`);
    const config = { name };
    const kept = [];
    for (const key of V2_KEPT_SECTIONS)
        if (raw[key] !== undefined) {
            config[key] = raw[key];
            kept.push(key);
        }
    const ignored = Object.keys(raw).filter(k => !V2_KEPT_SECTIONS.includes(k) && k !== 'environment');
    const env = raw['environment'];
    if (isObject(env)) {
        if (env['passEnv'] !== undefined) {
            config['environment'] = { passEnv: env['passEnv'] };
            kept.push('environment.passEnv');
        }
        ignored.push(...Object.keys(env).filter(k => k !== 'passEnv').map(k => `environment.${k}`));
    }
    else if (env !== undefined) {
        config['environment'] = env;
        kept.push('environment');
    }
    const { issues } = configIssues(config);
    if (issues.length) {
        throw new PipelineError('ONBOARD_V2', `${LEGACY_CONFIG_FILE} : sections reprises refusées par le schéma d'APV3, rien n'est écrit :\n${issues.map(i => `- ${i.message}`).join('\n')}`);
    }
    const gates = Array.isArray(config['gates']) ? config['gates'].map(g => String(g.id)) : [];
    return { file: LEGACY_CONFIG_FILE, config, kept, ignored: ignored.sort(), gates };
}
/** Reads the V2 ledger; a file `apv ledger validate` would refuse is refused with every problem, never converted. */
export function importV2Ledger(repo) {
    const raw = readJson(repo, LEGACY_LEDGER_FILE);
    const issues = decisionLedgerIssues(raw);
    if (issues.length) {
        throw new PipelineError('ONBOARD_V2', `${LEGACY_LEDGER_FILE} n'est pas un registre valide pour apv ledger validate, rien n'est écrit ` +
            `(un registre vide dans .apv/ masquerait ces décisions) :\n${issues.map(i => `- [${i.code}] ${i.message}`).join('\n')}`);
    }
    const ledger = decisionLedgerSchema.parse(raw);
    const text = readFileSync(join(repo, LEGACY_LEDGER_FILE), 'utf8');
    return { file: LEGACY_LEDGER_FILE, text: text.endsWith('\n') ? text : `${text}\n`, markdown: decisionLedgerMarkdown(ledger), decisions: ledger.decisions.length, hash: ledgerHash(ledger) };
}
/**
 * V2 keeps its specs in its state database, outside the repository. Spec files a project kept (the `--file`
 * proposals of `apv2 spec draft`) are looked for in these folders, and in the folder given by `--specs`.
 */
export const V2_SPEC_DIRS = ['.agent-pipeline/specs', 'specs', 'docs/specs'];
export const MAX_SPEC_BYTES = 4 * 1024 * 1024;
/** Kebab-case id of a spec file: its name without `.json` nor the `-import` suffix of V2 proposals. */
export function specIdOf(fileName) {
    const stem = fileName.replace(/\.json$/i, '').replace(/[-_.]import$/i, '');
    const id = stem.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
    return id || 'spec';
}
const shown = (repo, path) => {
    const rel = relative(repo, path);
    return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : path;
};
/** Spec files of the folders: JSON files only, read and paired with their request; nothing is validated here. */
export function findSpecCandidates(repo, dirs) {
    const out = [];
    for (const dir of dirs) {
        if (!existsSync(dir) || !statSync(dir).isDirectory())
            continue;
        for (const name of readdirSync(dir).filter(n => n.toLowerCase().endsWith('.json')).sort()) {
            const path = join(dir, name);
            const stat = statSync(path);
            if (!stat.isFile())
                continue;
            const id = specIdOf(name);
            const candidate = { file: shown(repo, path), path, id, requestFile: null, content: null, document: null, reasons: [] };
            out.push(candidate);
            if (stat.size > MAX_SPEC_BYTES) {
                candidate.reasons.push('fichier de plus de 4 Mio');
                continue;
            }
            const text = readFileSync(path, 'utf8');
            let raw;
            try {
                raw = JSON.parse(text);
            }
            catch (error) {
                candidate.reasons.push(`JSON invalide : ${errorMessage(error)}`);
                continue;
            }
            const isSpec = isObject(raw) && ((raw['title'] !== undefined && raw['tasks'] !== undefined) || (raw['spec'] !== undefined && raw['title'] === undefined));
            if (!isSpec) {
                candidate.reasons.push('pas une spec (ni "title" et "tasks", ni "spec")');
                continue;
            }
            const doc = raw;
            const stem = name.replace(/\.json$/i, '').replace(/[-_.]import$/i, '');
            const requestPath = join(dir, `${stem}-request.txt`);
            const request = existsSync(requestPath) && statSync(requestPath).isFile() ? readFileSync(requestPath, 'utf8') : null;
            if (request !== null && request.trim() && doc['spec'] === undefined) {
                candidate.requestFile = shown(repo, requestPath);
                candidate.document = { request, spec: doc };
                candidate.content = `${JSON.stringify(candidate.document, null, 2)}\n`;
            }
            else {
                candidate.document = doc;
                candidate.content = text.endsWith('\n') ? text : `${text}\n`;
            }
        }
    }
    return out;
}
/** Files of `.agent-pipeline/` that APV3 does not take over (roles, skills, architecture notes): the plugin provides them. */
export function v2FilesNotImported(repo) {
    const dir = join(repo, '.agent-pipeline');
    if (!existsSync(dir) || !statSync(dir).isDirectory())
        return [];
    const taken = ['DECISIONS.json', 'DECISIONS.md', 'specs'];
    return readdirSync(dir, { withFileTypes: true }).filter(e => !taken.includes(e.name))
        .map(e => `.agent-pipeline/${e.name}${e.isDirectory() ? '/' : ''}`).sort();
}
export const specFileName = (id) => `.apv/specs/${basename(id)}.json`;
//# sourceMappingURL=v2.js.map