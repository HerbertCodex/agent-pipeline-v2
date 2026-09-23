import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APV_DIR, ensureApvGitignore } from '../config/apv-files.js';
import { CONFIG_FILE } from '../config/load.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { LEDGER_FILE } from '../lifecycle/decisions.js';
import { gitRoot } from '../run/git-probe.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv init [--name <nom>] [--repo <chemin>] [--json]

Crée ce qui manque dans .apv/ sans jamais écraser un fichier existant (la commande peut être relancée) :
config.json (nom du projet, contrôles vides), DECISIONS.json (registre vide), brief.md (consigne commune
des implementers, depuis le modèle de la compétence chef-de-projet), specs/, state/ et .gitignore
(fichiers machine). Liste ce qui est créé et ce qui existait déjà. Refuse hors d'un dépôt Git.
Le nom du projet est --name, sinon le nom du dossier du dépôt.
Sortie : 0 succès, 1 hors d'un dépôt Git ou modèle de consigne introuvable, 2 appel incorrect.`;
/** Root of the plugin, resolved from the compiled tool (`dist/commands/init.js`). */
export const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BRIEF_TEMPLATE = 'skills/chef-de-projet/references/brief-type.md';
/** The brief model is the fenced `markdown` block of the reference; the whole file when it has none. */
export function briefFromTemplate(template, name) {
    const open = template.indexOf('```markdown\n');
    const close = template.lastIndexOf('\n```');
    const body = open >= 0 && close > open ? template.slice(open + '```markdown\n'.length, close) : template;
    return `${body.replaceAll('<nom du projet>', name).trimEnd()}\n`;
}
export function initProject(repo, name, pluginRoot = PLUGIN_ROOT) {
    const templateFile = join(pluginRoot, BRIEF_TEMPLATE);
    let template;
    try {
        template = readFileSync(templateFile, 'utf8');
    }
    catch (error) {
        throw new PipelineError('INIT_TEMPLATE', `Modèle de consigne introuvable (${templateFile}) : ${errorMessage(error)}`);
    }
    const result = { repo, name, created: [], existing: [], completed: [] };
    const dir = (path) => {
        const full = join(repo, path);
        if (existsSync(full))
            result.existing.push(`${path}/`);
        else {
            mkdirSync(full, { recursive: true });
            result.created.push(`${path}/`);
        }
    };
    const file = (path, content) => {
        const full = join(repo, path);
        if (existsSync(full)) {
            result.existing.push(path);
            return;
        }
        // 'wx': never replaces a file that appeared meanwhile.
        writeFileSync(full, content(), { flag: 'wx' });
        result.created.push(path);
    };
    dir(APV_DIR);
    file(CONFIG_FILE, () => `${JSON.stringify({ name, gates: [] }, null, 2)}\n`);
    file(LEDGER_FILE, () => `${JSON.stringify({ schemaVersion: 1, decisions: [] }, null, 2)}\n`);
    file(`${APV_DIR}/brief.md`, () => briefFromTemplate(template, name));
    dir(`${APV_DIR}/specs`);
    dir(`${APV_DIR}/state`);
    const ignore = `${APV_DIR}/.gitignore`;
    const had = existsSync(join(repo, ignore));
    const wrote = ensureApvGitignore(repo);
    (had ? (wrote ? result.completed : result.existing) : result.created).push(ignore);
    return result;
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, { name: { type: 'string' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        if (positionals.length)
            throw new UsageError(`argument inattendu : ${positionals.join(' ')}`);
        const repo = gitRoot(repoPath(io, values.repo));
        const name = (values.name ?? basename(repo)).trim();
        if (!name || name.length > 100 || /[\n\r\0]/.test(name))
            throw new UsageError('--name : de 1 à 100 caractères, sur une ligne');
        const result = initProject(repo, name);
        if (values.json) {
            json(io, result);
            return EXIT.ok;
        }
        const lines = [`Projet « ${name} » : ${repo}`];
        lines.push(result.created.length ? `Créé : ${result.created.join(', ')}` : 'Rien à créer : .apv/ est complet.');
        if (result.completed.length)
            lines.push(`Complété : ${result.completed.join(', ')}`);
        if (result.existing.length)
            lines.push(`Existait déjà (inchangé) : ${result.existing.join(', ')}`);
        if (result.created.length || result.completed.length) {
            lines.push('Suite : adapter .apv/brief.md (passages entre chevrons) et déclarer les contrôles dans .apv/config.json, puis commiter .apv/.');
        }
        io.stdout(`${lines.join('\n')}\n`);
        return EXIT.ok;
    });
}
//# sourceMappingURL=init.js.map