import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APV_DIR, apvGitignoreMissing, ensureApvGitignore } from '../config/apv-files.js';
import { CONFIG_FILE, loadConfig } from '../config/load.js';
import { designDir } from '../design/config.js';
import { GITATTRIBUTES, ensureDesignAttribute } from '../design/attributes.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { LEDGER_FILE } from '../lifecycle/decisions.js';
import { gitRoot } from '../run/git-probe.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv init [--name <nom>] [--repo <chemin>] [--json]

Crée ce qui manque dans .apv/ sans jamais écraser un fichier existant (la commande peut être relancée) :
config.json (nom du projet, contrôles vides), DECISIONS.json (registre vide), brief.md (consigne commune
des implementers, depuis le modèle de la compétence chef-de-projet), specs/, state/ et .gitignore
(fichiers machine). Si la configuration déclare le dossier des maquettes validées (design.dir) ou si ce
dossier existe, ajoute à .gitattributes « <dossier>/*.html -whitespace » quand Git ne l'applique pas déjà. Liste ce qui est créé et ce qui existait déjà. Refuse hors d'un dépôt Git.
Le nom du projet est --name, sinon le nom du dossier du dépôt.
Sortie : 0 succès, 1 hors d'un dépôt Git ou modèle de consigne introuvable, 2 appel incorrect.`;

/** Root of the plugin, resolved from the compiled tool (`dist/commands/init.js`). */
export const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BRIEF_TEMPLATE = 'skills/chef-de-projet/references/brief-type.md';

/** The brief model is the fenced `markdown` block of the reference; the whole file when it has none. */
export function briefFromTemplate(template: string, name: string): string {
  const open = template.indexOf('```markdown\n');
  const close = template.lastIndexOf('\n```');
  const body = open >= 0 && close > open ? template.slice(open + '```markdown\n'.length, close) : template;
  return `${body.replaceAll('<nom du projet>', name).trimEnd()}\n`;
}

export interface InitResult { repo: string; name: string; created: string[]; existing: string[]; completed: string[] }

/** Reads the brief model shipped with the plugin; refused before anything is written. */
export function readBriefTemplate(pluginRoot = PLUGIN_ROOT): string {
  const templateFile = join(pluginRoot, BRIEF_TEMPLATE);
  try { return readFileSync(templateFile, 'utf8'); }
  catch (error) { throw new PipelineError('INIT_TEMPLATE', `Modèle de consigne introuvable (${templateFile}) : ${errorMessage(error)}`); }
}

/**
 * Creates what `.apv/` lacks, never replacing an existing file, and records what it did. With `dryRun`, the
 * same decisions are taken and recorded, but nothing is written. Shared by `apv init` and `apv onboard`.
 */
export class ApvWriter {
  readonly created: string[] = [];
  readonly existing: string[] = [];
  readonly completed: string[] = [];
  constructor(readonly repo: string, readonly dryRun = false) {}

  dir(path: string): void {
    const full = join(this.repo, path);
    if (existsSync(full)) { this.existing.push(`${path}/`); return; }
    if (!this.dryRun) mkdirSync(full, { recursive: true });
    this.created.push(`${path}/`);
  }

  /** Writes `content()` unless the file exists; returns true when the file is (or would be) created. */
  file(path: string, content: () => string): boolean {
    const full = join(this.repo, path);
    if (existsSync(full)) { this.existing.push(path); return false; }
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
  designAttributes(): void {
    let dir: string; let declared: boolean;
    try { const { config } = loadConfig(this.repo); declared = config.design?.dir !== undefined; dir = designDir(config.design); }
    catch { return; }
    if (!declared && !existsSync(join(this.repo, dir))) return;
    const had = existsSync(join(this.repo, GITATTRIBUTES));
    const result = ensureDesignAttribute(this.repo, dir, this.dryRun);
    (result.status === 'present' ? this.existing : had ? this.completed : this.created).push(GITATTRIBUTES);
  }

  gitignore(): void {
    const ignore = `${APV_DIR}/.gitignore`;
    const had = existsSync(join(this.repo, ignore));
    const writes = this.dryRun ? apvGitignoreMissing(this.repo).length > 0 : ensureApvGitignore(this.repo);
    (had ? (writes ? this.completed : this.existing) : this.created).push(ignore);
  }
}

export interface InitContent {
  /** Content of `.apv/config.json` when it is created; by default the name and no gate. */
  config?: () => string;
  /** Files written right after the configuration (the ledger and its readable version); by default an empty ledger. */
  ledger?: { path: string; content: () => string }[];
}

/** Writes the `.apv/` skeleton in a fixed order: directory, configuration, ledger, brief, specs, state, .gitignore. */
export function writeApvSkeleton(writer: ApvWriter, name: string, template: string, content: InitContent = {}): void {
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
}

export function initProject(repo: string, name: string, pluginRoot = PLUGIN_ROOT): InitResult {
  const template = readBriefTemplate(pluginRoot);
  const writer = new ApvWriter(repo);
  writeApvSkeleton(writer, name, template);
  return { repo, name, created: writer.created, existing: writer.existing, completed: writer.completed };
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, { name: { type: 'string' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    if (positionals.length) throw new UsageError(`argument inattendu : ${positionals.join(' ')}`);
    const repo = gitRoot(repoPath(io, values.repo));
    const name = (values.name ?? basename(repo)).trim();
    if (!name || name.length > 100 || /[\n\r\0]/.test(name)) throw new UsageError('--name : de 1 à 100 caractères, sur une ligne');
    const result = initProject(repo, name);
    if (values.json) { json(io, result); return EXIT.ok; }
    const lines = [`Projet « ${name} » : ${repo}`];
    lines.push(result.created.length ? `Créé : ${result.created.join(', ')}` : 'Rien à créer : .apv/ est complet.');
    if (result.completed.length) lines.push(`Complété : ${result.completed.join(', ')}`);
    if (result.existing.length) lines.push(`Existait déjà (inchangé) : ${result.existing.join(', ')}`);
    if (result.created.length || result.completed.length) {
      const attributes = [...result.created, ...result.completed].includes(GITATTRIBUTES) ? ` et ${GITATTRIBUTES}` : '';
      lines.push(`Suite : adapter .apv/brief.md (passages entre chevrons) et déclarer les contrôles dans .apv/config.json, puis commiter .apv/${attributes}.`);
    }
    io.stdout(`${lines.join('\n')}\n`);
    return EXIT.ok;
  });
}
