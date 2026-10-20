import { Git } from '../execution/git.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listMockups, loadDesignConfig, matchesScreen, mockupPlacement, registerMockup, type DesignConfig, type MockupPlacement, type RegisteredMockup } from '../design/registry.js';
import { designAttributeState, hasWhitespaceErrors, type DesignAttributeResult } from '../design/attributes.js';
import { declaredGroups, hasGroups } from '../design/config.js';
import { organizeMockups, type OrganizeResult } from '../design/organize.js';
import { EXIT, UsageError, guard, json, list, parse, repoPath, table } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv design register <fichier.html> --name <nom> --quote "<mots de l'opérateur>"
                      [--title "<titre>"] [--screens a,b] [--artifact <url>] [--scope <motif,motif>]
                      [--group <dossier>] [--repo <chemin>] [--json]
  apv design list [--screen <écran>] [--repo <chemin>] [--json]
  apv design check [--repo <chemin>] [--json]
  apv design organize [--dry-run] [--repo <chemin>] [--json]

register copie la maquette validée vers docs/design/<groupe>/<nom>-validee.html (dossier : design.dir
de .apv/config.json ; groupe : le premier de design.groups dont un motif reconnaît le nom, sinon
design.defaultGroup, sinon la racine du dossier), calcule son sha256 et inscrit la décision
maquette-<nom>-validee au registre, avec la citation exacte de l'opérateur (obligatoire : le pipeline
n'invente jamais une validation).
--group <dossier> choisit un groupe déclaré (design.groups ou design.defaultGroup) ; le choix est noté
dans la décision. Un nouvel enregistrement garde le groupe de la maquette (groupe noté, ou dossier de
son fichier s'il est la racine ou un groupe déclaré) sauf --group : il ne la déplace pas, organize le
fait. Seule exception : un fichier dans un dossier qui n'est plus un groupe déclaré (groupe retiré de
la configuration) ; la nouvelle version va alors dans le groupe des motifs et l'ancien fichier, laissé
en place, est nommé dans la sortie. Le groupe « brouillons » est réservé ; une cible ou une source qui
passe par un lien symbolique est refusée ; un titre ou un écran ne contient pas « Groupe : »,
« Écrans : », « Artefact : » ni « fichier … sha256 ».
--scope donne un périmètre à la décision (motifs de chemins, syntaxe des chemins autorisés) : seules
les specs dont les tâches peuvent toucher ces chemins doivent la couvrir ; absent, le périmètre de
l'enregistrement actif est gardé (aucun : toute spec la couvre).
register ajoute aussi à .gitattributes la ligne « <dossier>/**/*.html -whitespace » quand Git ne
l'applique pas déjà (la ligne « <dossier>/*.html -whitespace » d'une version antérieure, insuffisante
avec des groupes, est remplacée) : une maquette est figée par son empreinte, ses espaces de fin de
ligne ne doivent pas faire échouer git diff --check. Rien n'est commité : la commande affiche les
fichiers à commiter.
list affiche les maquettes validées, leur empreinte, leur groupe et l'état du fichier (ok, modifiée,
absente).
check sort en 1 si un fichier de maquette validée a changé ou disparu sans nouvel enregistrement, ou
si la ligne de .gitattributes manque alors qu'une maquette validée porte des espaces de fin de ligne
(git diff --check échouerait) ; la ligne absente et une maquette hors du dossier de son groupe sont
signalées sans échec.
organize range dans le dossier de leur groupe les maquettes validées qui n'y sont pas (git mv si Git
suit le fichier) et réécrit leur chemin dans leur décision au registre, sans nouvelle version (le
contenu validé ne change pas, empreinte vérifiée). Il ne déplace que des fichiers HTML réguliers sous
design.dir, jamais à travers un lien symbolique. Tout ou rien : une maquette modifiée, absente, hors
de design.dir ou liée, ou une cible qui existe déjà, bloque tout ; un échec en cours de route remet
fichiers et registre comme avant. Aucun autre fichier n'est modifié : les fichiers qui citent
encore un ancien chemin sont listés. --dry-run montre le plan sans rien toucher. Rien n'est commité.`;

const STATE_LABEL: Record<RegisteredMockup['state'], string> = {
  ok: 'ok',
  drift: 'MODIFIÉE',
  missing: 'ABSENTE',
  legacy: 'sans empreinte',
};

type PlacedMockup = RegisteredMockup & MockupPlacement;

const groupLabel = (group: string | null): string => group ?? '(racine)';

function describe(m: PlacedMockup, groups: boolean): string[] {
  const row = [m.slug, m.decisionId, m.file ?? '(non versée par apv design)', m.sha256 ? m.sha256.slice(0, 12) : '', STATE_LABEL[m.state], m.screens.join(', ')];
  return groups ? [...row.slice(0, 1), `${groupLabel(m.group)}${m.placed === false ? ' (à ranger)' : ''}`, ...row.slice(1)] : row;
}

function attributeNote(attributes: DesignAttributeResult): string | null {
  if (attributes.status === 'added') return `  ${attributes.file} : ligne « ${attributes.line} » ajoutée (maquettes hors de git diff --check)`;
  if (attributes.status === 'replaced') return `  ${attributes.file} : ligne « ${attributes.previous} » remplacée par « ${attributes.line} » (elle ne couvrait pas les sous-dossiers des groupes)`;
  if (attributes.status === 'ineffective') return `  Attention : ligne « ${attributes.line} » écrite dans ${attributes.file}, mais un autre fichier d'attributs la contredit (git check-attr whitespace)`;
  return null;
}

interface AttributeCheck extends DesignAttributeResult {
  /** Registered mockups whose file has trailing whitespace. */
  whitespace: string[];
  /** Missing line while a mockup has trailing whitespace: `git diff --check` fails. */
  blocking: boolean;
}

/** The `.gitattributes` line, checked when the project has validated mockups or a mockup folder. */
function attributeCheck(repo: string, design: DesignConfig, mockups: RegisteredMockup[]): AttributeCheck | { status: 'not-applicable'; blocking: false } {
  const files = mockups.filter(m => m.file && m.state !== 'missing').map(m => m.file!);
  if (!files.length && !existsSync(join(repo, design.dir))) return { status: 'not-applicable', blocking: false };
  const state = designAttributeState(repo, design.dir, declaredGroups(design));
  const whitespace = state.status === 'missing' ? files.filter(f => { try { return hasWhitespaceErrors(join(repo, f)); } catch { return false; } }) : [];
  return { ...state, whitespace, blocking: whitespace.length > 0 };
}

function organizeReport(result: OrganizeResult): string {
  const lines: string[] = [];
  const moveLine = (m: OrganizeResult['moves'][number]): string => `- ${m.from} -> ${m.to} (${m.decisionId}, groupe ${groupLabel(m.group)}${m.tracked ? '' : ', fichier non suivi par Git'})`;
  if (!result.moves.length && !result.blocked.length) lines.push('Toutes les maquettes validées sont dans le dossier de leur groupe. Rien à faire.');
  if (result.blocked.length) {
    lines.push('Rangement impossible, rien n\'a été déplacé :', ...result.blocked.map(b => `- ${b.file} -> ${b.to} (${b.decisionId}) : ${b.reason}`),
      'Une maquette modifiée ou absente se règle d\'abord (apv design check) ; une cible existante se retire ou se renomme à la main.');
    if (result.moves.length) lines.push('', 'Les autres déplacements prévus :', ...result.moves.map(moveLine));
  } else if (result.moves.length) {
    lines.push(result.applied ? 'Maquettes rangées (empreinte inchangée, chemin réécrit dans leur décision, sans nouvelle version) :' : 'Plan (--dry-run, rien n\'a été touché) :',
      ...result.moves.map(moveLine));
    if (!result.applied) lines.push(`Décisions réécrites en place : ${result.ledgerFile} et ${result.ledgerMarkdown}.`);
  }
  if (result.legacy.length) lines.push(`Non rangeable (décision sans fichier ni empreinte) : ${result.legacy.join(', ')}`);
  if (result.references.length) {
    lines.push('', `Fichiers qui citent encore un ancien chemin (non modifiés${result.applied ? '' : ' par organize'}, à mettre à jour) :`,
      ...result.references.flatMap(r => [`- ${r.path} :`, ...r.files.map(f => `    ${f}`)]));
  }
  if (result.attributes.status === 'missing' && (result.moves.length || result.blocked.length)) {
    lines.push('', `Attention : ${result.attributes.file} ne contient pas « ${result.attributes.line} »${result.attributes.previous ? ` (la ligne « ${result.attributes.previous} » ne couvre pas les sous-dossiers)` : ''} ; organize ne le modifie pas : apv init ou le prochain apv design register la pose.`);
  }
  if (result.applied) {
    lines.push('', 'À commiter (rien n\'a été commité) :', `  git add -- ${result.toAdd.join(' ')}`, `  git commit -m "design: maquettes validées rangées par groupe" -- ${result.toCommit.join(' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      repo: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, screens: { type: 'string' }, quote: { type: 'string' },
      artifact: { type: 'string' }, screen: { type: 'string' }, scope: { type: 'string' }, group: { type: 'string' }, 'dry-run': { type: 'boolean' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    const repo = repoPath(io, values.repo);
    if (action !== 'register' && values.group !== undefined) throw new UsageError('--group ne sert qu\'à register');
    if (action !== 'organize' && values['dry-run']) throw new UsageError('--dry-run ne sert qu\'à organize');

    if (action === 'register') {
      const [file, ...extra] = rest;
      if (!file) throw new UsageError('fichier de la maquette manquant');
      if (extra.length) throw new UsageError(`argument inattendu : ${extra.join(' ')}`);
      if (!values.name) throw new UsageError('--name manquant (ex. --name tableau-de-bord)');
      if (values.quote === undefined || values.quote.trim() === '')
        throw new UsageError('--quote manquant : citez mot pour mot la validation de l\'opérateur (« je valide »). Sans validation explicite, rien n\'est versé.');
      const reviewer = await new Git().configValue(repo, 'user.name').catch(() => null);
      const result = await registerMockup(repo, {
        file, slug: values.name, quote: values.quote, ...(values.title !== undefined && { title: values.title }),
        screens: list(values.screens), ...(values.artifact !== undefined && { artifact: values.artifact }), ...(reviewer && { reviewer }),
        ...(values.scope !== undefined && { scopePaths: list(values.scope) }), ...(values.group !== undefined && { group: values.group }),
      });
      const attributesFile = ['added', 'replaced', 'ineffective'].includes(result.attributes.status) ? [result.attributes.file] : [];
      const toCommit = [...(result.unchanged ? [] : [result.target, result.ledgerFile, result.ledgerMarkdown]), ...attributesFile].filter(Boolean);
      if (values.json) { json(io, { ...result, toCommit }); return EXIT.ok; }
      const attributesNote = attributeNote(result.attributes);
      if (result.unchanged) {
        io.stdout([`Déjà enregistrée : ${result.target} (décision ${result.decisionId}, sha256 ${result.sha256}). Rien à faire pour la maquette.`,
          ...(attributesNote ? [attributesNote, `À commiter : git add -- ${toCommit.join(' ')}`] : []), ''].join('\n'));
        return EXIT.ok;
      }
      io.stdout([
        `Maquette validée enregistrée : ${result.target}`,
        `  sha256   ${result.sha256}`,
        `  décision ${result.decisionId}${result.supersedes.length ? ` (remplace ${result.supersedes.join(', ')})` : ''} dans ${result.ledgerFile}`,
        ...(result.group !== null ? [`  groupe   ${result.group}`] : []),
        ...(result.previousFile ? [`  L'ancien fichier ${result.previousFile} reste en place : retirez-le (git rm -- ${result.previousFile}) s'il ne sert plus.`] : []),
        ...(attributesNote ? [attributesNote] : []),
        '',
        'À commiter (rien n\'a été commité) :',
        `  git add -- ${toCommit.join(' ')}`,
        `  git commit -m "design: maquette validée ${result.slug}" -- ${toCommit.join(' ')}`,
        '',
      ].join('\n'));
      return EXIT.ok;
    }

    if (action === 'organize') {
      if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
      if (values.screen !== undefined || values.scope !== undefined) throw new UsageError('--screen et --scope ne servent pas à organize');
      const result = await organizeMockups(repo, { dryRun: values['dry-run'] === true });
      if (values.json) json(io, { ok: result.blocked.length === 0, ...result });
      else io.stdout(organizeReport(result));
      return result.blocked.length ? EXIT.failed : EXIT.ok;
    }

    if (action === 'list' || action === 'check') {
      if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
      if (action === 'check' && values.screen) throw new UsageError('--screen ne sert qu\'à list');
      if (values.scope !== undefined) throw new UsageError('--scope ne sert qu\'à register');
      const design = loadDesignConfig(repo);
      const all: PlacedMockup[] = listMockups(repo).map(m => ({ ...m, ...mockupPlacement(design, m) }));
      const mockups = values.screen ? all.filter(m => matchesScreen(m, values.screen!)) : all;
      const broken = all.filter(m => m.state === 'drift' || m.state === 'missing');
      if (action === 'list') {
        if (values.json) { json(io, { mockups }); return EXIT.ok; }
        if (!mockups.length) {
          io.stdout(values.screen ? `Aucune maquette validée pour l'écran « ${values.screen} ».\n` : 'Aucune maquette validée au registre (apv design register pour en verser une).\n');
          return EXIT.ok;
        }
        const groups = hasGroups(design);
        const headers = ['nom', 'décision', 'fichier', 'sha256', 'état', 'écrans'];
        io.stdout(`${table(groups ? ['nom', 'groupe', ...headers.slice(1)] : headers, mockups.map(m => describe(m, groups)))}\n`);
        const shown = broken.filter(m => mockups.includes(m));
        if (shown.length) io.stdout(`\nAttention : ${shown.length} maquette(s) modifiée(s) ou absente(s) depuis la validation. La référence est la version enregistrée (git log -- <fichier>) ; une nouvelle version validée se verse avec apv design register.\n`);
        const misplaced = mockups.filter(m => m.placed === false && m.state !== 'missing');
        if (misplaced.length) io.stdout(`\n${misplaced.length} maquette(s) hors du dossier de leur groupe : apv design organize les range.\n`);
        return EXIT.ok;
      }
      const legacy = all.filter(m => m.state === 'legacy');
      const misplaced = all.filter(m => m.placed === false && m.state !== 'missing').map(m => ({ decisionId: m.decisionId, file: m.file!, group: m.group, folder: m.folder }));
      const attributes = attributeCheck(repo, design, all);
      const ok = broken.length === 0 && !attributes.blocking;
      if (values.json) json(io, { ok, checked: all.length - legacy.length, broken, legacy: legacy.map(m => m.decisionId), misplaced, attributes });
      else {
        if (broken.length) io.stdout(`Maquettes validées modifiées sans nouvel enregistrement :\n${broken.map(m => `- ${m.file} (${m.decisionId}) : ${m.state === 'missing' ? 'fichier absent' : `sha256 ${m.actualSha256} au lieu de ${m.sha256}`}`).join('\n')}\n`);
        else io.stdout(`Maquettes validées intactes : ${all.length - legacy.length} fichier(s) conforme(s) à leur empreinte.\n`);
        if (legacy.length) io.stdout(`Non vérifiable (décision sans empreinte, à verser avec apv design register) : ${legacy.map(m => m.decisionId).join(', ')}\n`);
        if (misplaced.length) {
          io.stdout(`Attention : maquette(s) hors du dossier de leur groupe (apv design organize les range) :\n${misplaced.map(m => `- ${m.file} (${m.decisionId}) : groupe ${groupLabel(m.group)}, dossier ${m.folder}/`).join('\n')}\n`);
        }
        if (attributes.status === 'missing') {
          io.stdout(`${attributes.blocking ? 'Erreur' : 'Attention'} : ${attributes.file} ne contient pas « ${attributes.line} »` +
            (attributes.previous ? ` (la ligne « ${attributes.previous} » ne couvre pas les sous-dossiers des groupes)` : '') +
            (attributes.whitespace.length ? ` et ${attributes.whitespace.join(', ')} porte(nt) des espaces de fin de ligne : git diff --check échoue.` : ' : une maquette validée qui porterait des espaces de fin de ligne ferait échouer git diff --check.') +
            ` Ajoutez la ligne (apv design register ou apv init ${attributes.previous ? 'la met à la place de l\'ancienne' : 'l\'ajoute'}) ; la maquette ne se nettoie pas, son empreinte changerait.\n`);
        }
      }
      return ok ? EXIT.ok : EXIT.failed;
    }
    throw new UsageError(action ? `sous-commande inconnue : design ${action}` : 'sous-commande manquante');
  });
}
