import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalPath } from '../domain/paths.js';
import { Git } from '../execution/git.js';
import { loadConfig } from '../config/load.js';
import type { StructureReport } from '../structure/analyze.js';
import { checkStructure, type StructureCheckReport } from '../structure/check.js';
import { architectureMap } from '../structure/map-file.js';
import { conventionOf, profileById, type StackProfile } from '../structure/profiles.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv structure check [--base <ref>] [--path <dossier>]... [--all] [--repo <chemin>] [--json]
  apv structure map [--check] [--repo <chemin>] [--json]

check analyse l'arborescence des fichiers de code (docs/STRUCTURE.md) et signale :
  flat-folder      un dossier qui a plus de N fichiers de code directement (défaut 12 ; tests et
                   fichiers compagnons comptés à part), avec un découpage proposé par usage (qui importe
                   quoi, routes et composants qui s'en servent, mots des noms et des exports), même sans
                   préfixe commun : socle gardé à la racine, sous-dossiers nommés, raisons et convention ;
  repeated-prefix  plusieurs fichiers qui partagent un préfixe de domaine (singulier et pluriel rapprochés) ;
  mixed-roles      un dossier qui mêle des rôles (actions, dépôts de données, clients, utilitaires HTTP...)
                   pour plusieurs domaines ;
  stray-file       un fichier dont le préfixe est le nom d'un dossier voisin.
Chaque constat a sa proposition ; le plan de rangement (ancien -> nouveau) n'est jamais appliqué.
--base (le contrôle déclaré passe {{baseSha}}) compare le changement à sa base commune, avec la configuration
de la base : un fichier de code ajouté à un dossier à plat (ou qui en fait un) bloque (flat-growth), avec le
sous-dossier où le mettre ; un dossier de premier ou deuxième niveau, une route principale ou un point
d'entrée ajouté sans rôle dans la carte de l'architecture, ou un lien de la carte cassé, bloque
(architecture-map). L'existant est signalé sans bloquer ; un déplacement qui vide un dossier à plat dans ses
sous-dossiers est accepté. Sans --base, rien n'est comparé : fichiers suivis seulement, carte signalée sans
bloquer. --path limite l'analyse à un dossier et à ses sous-dossiers ; répétable. --all liste tous les
constats existants de la carte (par défaut : 10).
map écrit la carte de l'architecture (structure.architectureMap, par défaut docs/carte-architecture.md) si
elle manque, puis réécrit ses parties générées (arborescence, points d'entrée, liens) sans jamais toucher à
ses parties écrites ; --check compare seulement.
Configuration facultative : section « structure » de .apv/config.json (roots, maxFlatFiles, roles, domains,
ignore, severity, architectureMap, profile).
Sortie : 0 aucun constat bloquant, 1 au moins un (ou carte périmée pour map --check), configuration
invalide ou base introuvable, 2 appel incorrect.`;

const LABEL = { warning: 'avertissement', error: 'erreur' } as const;
const short = (dir: string, path: string): string => (dir === '.' ? path : path.slice(dir.length + 1));

/** Tracked files of the repository, as Git lists them (never ignored or untracked files). */
export async function trackedFiles(git: Git, repo: string): Promise<string[]> {
  return (await git.exec(repo, ['ls-files', '--cached', '--deduplicate', '-z'])).split('\0').filter(Boolean);
}

const CODE_LABEL = { 'flat-growth': 'dossier à plat alourdi', 'architecture-map': 'carte de l\'architecture', configuration: 'configuration' } as const;
const EXISTING_SHOWN = 10;

/** Labels of the conventions a group follows, with their documentation. */
function conventions(profile: StackProfile, ids: readonly string[]): string {
  return ids.map(id => conventionOf(profile, id)).filter((c): c is NonNullable<typeof c> => !!c)
    .map(c => `${c.label}${c.url ? ` (${c.url})` : ''}`).join(' ; ');
}

export function formatReport(report: StructureReport & Partial<Pick<StructureCheckReport, 'changes' | 'base' | 'architectureMap' | 'usageError'>>, scope: string[], all = false): string {
  const profile = profileById(report.architectureMap?.profile ?? 'generic');
  const errors = report.findings.filter(f => f.severity === 'error').length;
  const tracked = report.base?.mergeBase ? 'du dépôt (suivis et non suivis non ignorés)' : 'suivis';
  const lines = [`Arborescence : ${report.analyzedFiles} fichier(s) de code ${tracked} analysés${scope.length ? ` (dans ${scope.join(', ')})` : ''}, ${report.findings.length} constat(s), dont ${errors} de gravité error.`];
  if (report.usageError) lines.push(`Attention : graphe des imports indisponible (${report.usageError}) : le découpage ne lit que les noms.`);
  if (!report.findings.length) lines.push('Aucun constat.');
  for (const folder of report.folders) {
    const dir = folder.folder;
    lines.push('', `${dir}/ : ${folder.code} fichier(s) de code, ${folder.tests} test(s), ${folder.companions} compagnon(s)`);
    for (const f of report.findings.filter(x => x.folder === dir)) {
      const state = !report.base?.mergeBase ? '' : f.blocking ? ' [bloquant]' : f.isNew === false ? ' [existant]' : '';
      lines.push(`  [${LABEL[f.severity]}]${state} ${f.code} : ${f.proposal}${f.code === 'flat-folder' ? '' : ` Fichiers : ${f.files.map(p => short(dir, p)).join(', ')}.`}`);
      if (f.code !== 'flat-folder') continue;
      for (const c of f.core ?? []) lines.push(`    socle : ${short(dir, c.path)} (${c.reason})`);
      for (const g of f.groups ?? []) {
        lines.push(`    ${g.dir}/${g.existing ? ' (existant)' : ''} : ${g.members.map(p => short(dir, p)).join(', ')}`);
        lines.push(`      pourquoi : ${g.reasons.join(' ; ')}`);
        const c = conventions(profile, g.conventions);
        if (c) lines.push(`      convention : ${c}`);
      }
    }
    // One line per main file; its tests and companion files follow it.
    const moves = report.plan.filter(m => m.from.startsWith(dir === '.' ? '' : `${dir}/`) && !m.from.slice(dir === '.' ? 0 : dir.length + 1).includes('/'));
    const mains = report.findings.filter(f => f.folder === dir).flatMap(f => f.moves);
    const seen = new Set<string>();
    if (mains.length) lines.push('  Plan :');
    for (const m of mains) {
      if (seen.has(m.from)) continue;
      seen.add(m.from);
      const stem = m.from.slice(m.from.lastIndexOf('/') + 1).split('.')[0]!;
      const others = moves.filter(x => x.from !== m.from && x.from.slice(x.from.lastIndexOf('/') + 1).split('.')[0] === stem);
      lines.push(`    ${short(dir, m.from)} -> ${short(dir, m.to)}${others.length ? ` (avec ${others.map(x => short(dir, x.from)).join(', ')})` : ''}`);
    }
    if (mains.length && folder.unplaced.length) lines.push(`  Restent en place, à décider avec l'opérateur : ${folder.unplaced.map(p => short(dir, p)).join(', ')}`);
  }
  if (report.findings.length) {
    lines.push('', report.plan.length
      ? `Plan de rangement : ${report.plan.length} déplacement(s), tests et fichiers compagnons compris (liste complète : --json). Jamais appliqué par apv : à valider avec l'opérateur, puis git mv et imports mis à jour.`
      : 'Aucun déplacement proposé.');
  }
  if (report.changes && report.architectureMap) {
    const base = report.base?.mergeBase ? `base commune de ${report.base.ref} (${report.base.mergeBase.slice(0, 12)})` : null;
    const m = report.architectureMap;
    lines.push('', `Carte de l'architecture : ${m.path} (${m.exists ? `${m.described}/${m.items} élément(s) décrits` : 'absente'}, pile ${profile.label}).`);
    lines.push(base ? `Comparaison avec la ${base} : ${report.changes.filter(c => c.isNew).length} constat(s) nouveau(x), ${report.changes.filter(c => !c.isNew).length} existant(s).` : 'Sans --base : rien n\'est comparé, la carte est signalée sans bloquer.');
    for (const c of report.changes.filter(x => x.isNew)) lines.push(`  ${c.blocking ? '[bloquant] ' : ''}${CODE_LABEL[c.code]} : ${c.path} : ${c.message}`);
    const existing = report.changes.filter(x => !x.isNew);
    for (const c of all ? existing : existing.slice(0, EXISTING_SHOWN)) lines.push(`  [existant] ${CODE_LABEL[c.code]} : ${c.message}`);
    if (!all && existing.length > EXISTING_SHOWN) lines.push(`  et ${existing.length - EXISTING_SHOWN} autre(s) existant(s) (--all pour tout lister).`);
  }
  const blocking = [...(report.changes ?? []), ...report.findings].filter(f => f.blocking).length;
  if (blocking) {
    const advice: string[] = [];
    if (report.changes?.some(c => c.blocking && c.code === 'flat-growth')) advice.push('placer chaque fichier dans le sous-dossier proposé (ou ranger le dossier d\'abord, avec l\'opérateur)');
    if (report.changes?.some(c => c.blocking && c.code === 'architecture-map')) advice.push('décrire chaque nouveau dossier, route principale ou point d\'entrée dans le bloc « Rôles » de la carte de l\'architecture, et réparer ses liens');
    if (report.findings.some(f => f.blocking)) advice.push('suivre la proposition des constats de gravité error');
    lines.push('', `Résultat : ÉCHEC, ${blocking} constat(s) bloquant(s) : ${[...advice, 'jamais relever le seuil ni baisser la gravité dans le changement'].join(' ; ')}.`);
  }
  return `${lines.join('\n')}\n`;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      path: { type: 'string', multiple: true }, base: { type: 'string' }, all: { type: 'boolean' }, check: { type: 'boolean' },
      repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (action !== 'check' && action !== 'map') throw new UsageError(action ? `sous-commande inconnue : structure ${action}` : 'sous-commande manquante');
    if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
    const git = new Git();
    const repo = await git.root(repoPath(io, values.repo));
    if (action === 'map') {
      if (values.path || values.base !== undefined || values.all) throw new UsageError('structure map : --path, --base et --all ne s\'appliquent pas');
      const { config } = loadConfig(repo);
      const result = await architectureMap(repo, config, { check: values.check === true, create: values.check !== true });
      const failed = result.status === 'stale' || result.status === 'missing';
      if (values.json) { json(io, { ...result, repo }); return failed ? EXIT.failed : EXIT.ok; }
      const text = {
        created: `Carte de l'architecture écrite : ${result.file}. Compléter ses parties écrites (en bref, couches et flux, règles transverses, rôles), puis la commiter.`,
        written: `Carte de l'architecture mise à jour (parties générées) : ${result.file}. À commiter.`,
        unchanged: `Carte de l'architecture à jour : ${result.file}.`,
        'up-to-date': `Carte de l'architecture à jour : ${result.file}.`,
        stale: `Carte de l'architecture périmée : ses parties générées ne correspondent plus au code (${result.file}). Lancez apv structure map (ou apv map), puis commitez-la.`,
        missing: `Carte de l'architecture absente : ${result.file}. Lancez apv structure map.`,
        absent: `Carte de l'architecture absente : ${result.file}.`,
      }[result.status];
      const lines = [text];
      if (result.difference?.onlyExpected.length) lines.push('  Attendu, absent de la carte :', ...result.difference.onlyExpected.map(l => `    ${l}`));
      io.stdout(`${lines.join('\n')}\n`);
      return failed ? EXIT.failed : EXIT.ok;
    }
    if (values.check) throw new UsageError('structure check : --check ne s\'applique qu\'à structure map');
    if (values.base !== undefined && (!values.base || values.base.startsWith('-'))) throw new UsageError('--base : référence Git attendue');
    const scope = (values.path ?? []).map(p => {
      const rel = relative(repo, canonicalPath(resolve(repo, p))).split('\\').join('/');
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new UsageError(`--path hors du dépôt : ${p}`);
      return rel || '.';
    });
    const { config } = loadConfig(repo);
    const report = await checkStructure(repo, config, { ...(values.base !== undefined ? { base: values.base } : {}), paths: scope, tracked: await trackedFiles(git, repo) });
    if (values.json) json(io, { ...report, repo, paths: scope });
    else io.stdout(formatReport(report, scope, values.all === true));
    return report.ok ? EXIT.ok : EXIT.failed;
  });
}
