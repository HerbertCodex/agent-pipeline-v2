import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APV_DIR, apvGitignoreMissing, ensureApvGitignore } from '../config/apv-files.js';
import { CONFIG_FILE, configIssues, loadConfig } from '../config/load.js';
import { worktreeFiles } from '../knowledge/inventory.js';
import { detectReuse, MAP_GATE, REUSE_GATE } from '../reuse/detect.js';
import { currentMap } from './map.js';
import { designDir } from '../design/config.js';
import { GITATTRIBUTES, ensureDesignAttribute } from '../design/attributes.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { LEDGER_FILE } from '../lifecycle/decisions.js';
import { gitRoot } from '../run/git-probe.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv init [--name <nom>] [--repo <chemin>] [--json]

Crée ce qui manque dans .apv/ sans jamais écraser un fichier existant (la commande peut être relancée) :
config.json (nom du projet, contrôles vides), DECISIONS.json (registre vide), brief.md (consigne commune
des implementers, depuis le modèle de la compétence chef-de-projet), specs/, state/ et .gitignore
(fichiers machine) et la carte du code (.apv/code-map.md, comme apv map). La configuration créée déclare les
contrôles code-map (apv map --check) et, pour un projet web, reuse (apv reuse check) avec la section reuse
détectée (dossiers partagés, composant qui remplace chaque élément natif réservé, langue, branche de référence).
Si la configuration déclare le dossier des maquettes validées (design.dir) ou si ce
dossier existe, ajoute à .gitattributes « <dossier>/*.html -whitespace » quand Git ne l'applique pas déjà. Liste ce qui est créé et ce qui existait déjà. Refuse hors d'un dépôt Git.
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
/** Reads the brief model shipped with the plugin; refused before anything is written. */
export function readBriefTemplate(pluginRoot = PLUGIN_ROOT) {
    const templateFile = join(pluginRoot, BRIEF_TEMPLATE);
    try {
        return readFileSync(templateFile, 'utf8');
    }
    catch (error) {
        throw new PipelineError('INIT_TEMPLATE', `Modèle de consigne introuvable (${templateFile}) : ${errorMessage(error)}`);
    }
}
/**
 * Creates what `.apv/` lacks, never replacing an existing file, and records what it did. With `dryRun`, the
 * same decisions are taken and recorded, but nothing is written. Shared by `apv init` and `apv onboard`.
 */
export class ApvWriter {
    repo;
    dryRun;
    created = [];
    existing = [];
    completed = [];
    constructor(repo, dryRun = false) {
        this.repo = repo;
        this.dryRun = dryRun;
    }
    dir(path) {
        const full = join(this.repo, path);
        if (existsSync(full)) {
            this.existing.push(`${path}/`);
            return;
        }
        if (!this.dryRun)
            mkdirSync(full, { recursive: true });
        this.created.push(`${path}/`);
    }
    /** Writes `content()` unless the file exists; returns true when the file is (or would be) created. */
    file(path, content) {
        const full = join(this.repo, path);
        if (existsSync(full)) {
            this.existing.push(path);
            return false;
        }
        const text = content();
        if (!this.dryRun) {
            mkdirSync(dirname(full), { recursive: true });
            // 'wx': never replaces a file that appeared meanwhile.
            writeFileSync(full, text, { flag: 'wx' });
        }
        this.created.push(path);
        return true;
    }
    /**
     * The `.gitattributes` line of the validated mockups, when the configuration declares their folder (`design.dir`)
     * or the folder exists: registered under their sha256, they must stay out of `git diff --check`. An unreadable
     * configuration is left to `apv status` and the other commands: nothing is written then.
     */
    designAttributes() {
        let dir;
        let declared;
        try {
            const { config } = loadConfig(this.repo);
            declared = config.design?.dir !== undefined;
            dir = designDir(config.design);
        }
        catch {
            return;
        }
        if (!declared && !existsSync(join(this.repo, dir)))
            return;
        const had = existsSync(join(this.repo, GITATTRIBUTES));
        const result = ensureDesignAttribute(this.repo, dir, this.dryRun);
        (result.status === 'present' ? this.existing : had ? this.completed : this.created).push(GITATTRIBUTES);
    }
    gitignore() {
        const ignore = `${APV_DIR}/.gitignore`;
        const had = existsSync(join(this.repo, ignore));
        const writes = this.dryRun ? apvGitignoreMissing(this.repo).length > 0 : ensureApvGitignore(this.repo);
        (had ? (writes ? this.completed : this.existing) : this.created).push(ignore);
    }
}
/** Writes the `.apv/` skeleton in a fixed order: directory, configuration, ledger, brief, specs, state, .gitignore. */
export function writeApvSkeleton(writer, name, template, content = {}) {
    writer.dir(APV_DIR);
    writer.file(CONFIG_FILE, content.config ?? (() => `${JSON.stringify({ name, gates: [] }, null, 2)}\n`));
    for (const entry of content.ledger ?? [{ path: LEDGER_FILE, content: () => `${JSON.stringify({ schemaVersion: 1, decisions: [] }, null, 2)}\n` }]) {
        writer.file(entry.path, entry.content);
    }
    writer.file(`${APV_DIR}/brief.md`, () => briefFromTemplate(template, name));
    writer.dir(`${APV_DIR}/specs`);
    writer.dir(`${APV_DIR}/state`);
    writer.gitignore();
    writer.designAttributes();
    if (content.map)
        writer.file(content.map.path, content.map.content);
}
/**
 * The configuration of a new project: its name, the checks of the reuse (`reuse` for a web project, `code-map`
 * always, both at the task stage so that they also run in the full suite) and the detected `reuse` section.
 */
export function reuseConfig(name, proposal) {
    const gates = [...(proposal.web ? [REUSE_GATE] : []), MAP_GATE].map(g => ({ ...g, command: [...g.command], covers: [...g.covers] }));
    return { document: { name, gates, ...(proposal.web ? { reuse: proposal.section } : {}) }, gates: gates.map(g => g.id) };
}
/** The code map of the repository under `config` (the one about to be written, or the existing one); null when unreadable. */
export async function initialMap(repo, configText) {
    let config;
    try {
        if (configText === undefined)
            config = loadConfig(repo).config;
        else {
            const checked = configIssues(JSON.parse(configText));
            if (!checked.config)
                return null;
            config = checked.config;
        }
    }
    catch {
        return null;
    }
    const { file, text } = await currentMap(repo, config);
    return { path: file, text };
}
export async function initProject(repo, name, pluginRoot = PLUGIN_ROOT) {
    const template = readBriefTemplate(pluginRoot);
    const proposal = detectReuse(repo, await worktreeFiles(repo));
    const configExists = existsSync(join(repo, CONFIG_FILE));
    const { document, gates } = reuseConfig(name, proposal);
    const { issues } = configIssues(document);
    if (!configExists && issues.length)
        throw new PipelineError('INIT', `Configuration détectée refusée par le schéma : ${issues.map(i => i.message).join(' ; ')}`);
    const configText = configExists ? undefined : `${JSON.stringify(document, null, 2)}\n`;
    const map = await initialMap(repo, configText);
    const writer = new ApvWriter(repo);
    writeApvSkeleton(writer, name, template, {
        ...(configText !== undefined ? { config: () => configText } : {}),
        ...(map ? { map: { path: map.path, content: () => map.text } } : {}),
    });
    const reuse = { web: proposal.web, signals: proposal.signals, gates: configExists ? [] : gates, section: !configExists && proposal.web ? proposal.section : null, map: map?.path ?? null };
    return { repo, name, created: writer.created, existing: writer.existing, completed: writer.completed, reuse };
}
/** Lines of the reuse setup for the text output of `apv init` and `apv onboard`. */
export function reuseLines(reuse) {
    const lines = [];
    if (reuse.gates.length) {
        lines.push(`Contrôles ajoutés (étape tâche, donc aussi dans la suite complète) : ${reuse.gates.map(g => (g === 'reuse' ? 'reuse (apv reuse check)' : 'code-map (apv map --check)')).join(', ')}.`);
    }
    if (reuse.section) {
        const s = reuse.section;
        lines.push(`Réutilisation (projet web : ${reuse.signals.join(' ; ')}) : dossiers partagés ${s.shared?.join(', ') ?? 'par défaut (**/components/**, **/ui/**...)'} ; éléments natifs réservés ${Object.entries(s.native?.elements ?? {}).map(([e, t]) => `<${e}>${t ? ` -> ${t}` : ''}`).join(', ')}${s.native?.allowedPaths ? `, permis dans ${s.native.allowedPaths.join(', ')}` : ''} ; langue ${s.typography?.locale ?? 'non trouvée (reuse.typography.locale)'} ; référence ${s.reference ?? 'non trouvée : sans reuse.reference, tout le code existant compte comme nouveau'}.`);
    }
    if (reuse.map === null)
        lines.push('Carte du code non écrite : configuration illisible ; la corriger, puis apv map.');
    return lines;
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
        const result = await initProject(repo, name);
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
        lines.push(...reuseLines(result.reuse));
        if (result.created.length || result.completed.length) {
            const attributes = [...result.created, ...result.completed].includes(GITATTRIBUTES) ? ` et ${GITATTRIBUTES}` : '';
            lines.push(`Suite : adapter .apv/brief.md (passages entre chevrons) et déclarer les contrôles dans .apv/config.json, puis commiter .apv/${attributes}.`);
        }
        io.stdout(`${lines.join('\n')}\n`);
        return EXIT.ok;
    });
}
//# sourceMappingURL=init.js.map