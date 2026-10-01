import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APV_DIR, apvGitignoreMissing, ensureApvGitignore } from '../config/apv-files.js';
import { CONFIG_FILE, configIssues, loadConfig } from '../config/load.js';
import { worktreeFiles } from '../knowledge/inventory.js';
import { apvOnPath, detectReuse, MAP_GATE, REUSE_GATE, STRUCTURE_GATE } from '../reuse/detect.js';
import { architectureMap } from '../structure/map-file.js';
import { structureSettings } from '../structure/config.js';
import { currentMap } from './map.js';
import { declaredGroups, designSettings } from '../design/config.js';
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
     * The `.gitattributes` line of the validated mockups, when the configuration declares their folder (`design.dir`) or groups
     * or the folder exists: registered under their sha256, they must stay out of `git diff --check`. An unreadable
     * configuration is left to `apv status` and the other commands: nothing is written then.
     */
    designAttributes() {
        let dir;
        let declared;
        let groups;
        try {
            const { config } = loadConfig(this.repo);
            const settings = designSettings(config.design);
            groups = declaredGroups(settings);
            declared = config.design?.dir !== undefined || groups.length > 0;
            dir = settings.dir;
        }
        catch {
            return;
        }
        if (!declared && !existsSync(join(this.repo, dir)))
            return;
        const had = existsSync(join(this.repo, GITATTRIBUTES));
        const result = ensureDesignAttribute(this.repo, dir, this.dryRun, groups);
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
    const gates = [...(proposal.web ? [REUSE_GATE] : []), STRUCTURE_GATE, MAP_GATE].map(g => ({ ...g, command: [...g.command], covers: [...g.covers] }));
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
    // The map never blocks the setup: a repository too large or unreadable for the inventory gets its configuration anyway.
    try {
        const { file, text, map, tree } = await currentMap(repo, config);
        const crowded = tree.findings.filter(f => f.code === 'flat-folder').map(f => ({ folder: f.folder, code: f.files.length, groups: (f.groups ?? []).map(g => g.dir) }));
        return { path: file, text, partial: map.partial !== null, crowded };
    }
    catch (error) {
        return { path: null, text: '', partial: false, error: errorMessage(error) };
    }
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
        ...(map?.path ? { map: { path: map.path, content: () => map.text } } : {}),
    });
    const architecture = await initialArchitecture(repo, writer);
    const reuse = { web: proposal.web, signals: proposal.signals, gates: configExists ? [] : gates, section: !configExists && proposal.web ? proposal.section : null, ...mapFields(map), architecture };
    return { repo, name, created: writer.created, existing: writer.existing, completed: writer.completed, reuse };
}
/**
 * The architecture map (docs/STRUCTURE.md), written when it does not exist, never touched when it does: generated parts
 * filled, written parts as drafts to complete with the operator. With a dry run, only said. Never blocks the setup.
 */
export async function initialArchitecture(repo, writer) {
    let config;
    try {
        config = loadConfig(repo).config;
    }
    catch (error) {
        return { file: 'docs/carte-architecture.md', status: 'failed', note: `configuration illisible (${errorMessage(error)})` };
    }
    const file = structureSettings(config.structure).architectureMap;
    if (existsSync(join(repo, file))) {
        writer.existing.push(file);
        return { file, status: 'existing', note: null };
    }
    if (writer.dryRun) {
        writer.created.push(file);
        return { file, status: 'created', note: null };
    }
    try {
        await architectureMap(repo, config, { check: false, create: true });
        writer.created.push(file);
        return { file, status: 'created', note: null };
    }
    catch (error) {
        return { file, status: 'failed', note: errorMessage(error) };
    }
}
/** The map fields of the setup, from what `initialMap` returned. */
export function mapFields(map) {
    const mapNote = map === null ? 'configuration illisible' : map.error ? `carte non construite (${map.error})` : map.partial ? 'carte partielle : dépôt au-delà de la limite de l\'inventaire (50 000 fichiers)' : null;
    return { map: map?.path ?? null, mapNote, apvOnPath: apvOnPath() };
}
/** Lines of the reuse setup for the text output of `apv init` and `apv onboard`. */
export function reuseLines(reuse) {
    const lines = [];
    if (reuse.gates.length) {
        const described = {
            reuse: 'reuse (apv reuse check --base {{baseSha}}, étape tâche et suite complète ; apv gates run demande donc --base)',
            structure: 'structure (apv structure check --base {{baseSha}}, étape tâche : un fichier ajouté à un dossier à plat, un dossier ou un point d\'entrée non décrit dans la carte de l\'architecture bloquent)',
            'code-map': 'code-map (apv map --check, suite complète ; la carte du code et celle de l\'architecture sont régénérées à l\'intégration)',
        };
        lines.push(`Contrôles ajoutés : ${reuse.gates.map(g => described[g] ?? g).join(', ')}.`);
        if (!reuse.apvOnPath)
            lines.push('ATTENTION : apv n\'est pas sur le PATH de cette machine ; ces contrôles échoueront (commande introuvable). Activez le plugin (son exécutable bin/apv) ou npm link, ou remplacez "apv" par ["node", "<chemin du plugin>/dist/cli.js", ...] dans .apv/config.json.');
    }
    if (reuse.section) {
        const s = reuse.section;
        lines.push(`Réutilisation (projet web : ${reuse.signals.join(' ; ')}) : dossiers partagés ${s.shared?.join(', ') ?? 'par défaut (**/components/**, **/ui/**...)'} ; éléments natifs réservés ${Object.entries(s.native?.elements ?? {}).map(([e, t]) => `<${e}>${t ? ` -> ${t}` : ''}`).join(', ')}, permis dans ${s.native?.allowedPaths?.join(', ') ?? 'les composants génériques (**/components/ui/**, **/ui/**, **/primitives/**...)'} ; langue ${s.typography?.locale ?? 'non trouvée (reuse.typography.locale)'} ; référence ${s.reference ?? 'non trouvée (pas de branche distante origin) : déclarez reuse.reference pour apv reuse check sans --base'}.`);
    }
    const a = reuse.architecture;
    if (a?.status === 'created')
        lines.push(`Carte de l'architecture : ${a.file} (parties générées remplies ; à compléter avec l'opérateur : en bref, couches et flux, règles transverses, rôles des dossiers). Relire aussi apv structure check : dossiers à plat et découpage proposé.`);
    else if (a?.status === 'failed')
        lines.push(`Carte de l'architecture non écrite (${a.note ?? 'erreur'}) : apv structure map.`);
    if (reuse.map === null)
        lines.push(`Carte du code non écrite : ${reuse.mapNote ?? 'configuration illisible'} ; corriger, puis apv map.`);
    else if (reuse.mapNote)
        lines.push(`Attention : ${reuse.mapNote}.`);
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