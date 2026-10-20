import { Git } from '../execution/git.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listMockups, loadDesignConfig, matchesScreen, registerMockup, type RegisteredMockup } from '../design/registry.js';
import { designAttributeState, hasWhitespaceErrors, type DesignAttributeResult } from '../design/attributes.js';
import { EXIT, UsageError, guard, json, list, parse, repoPath, table } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv design register <fichier.html> --name <nom> --quote "<mots de l'opérateur>"
                      [--title "<titre>"] [--screens a,b] [--artifact <url>] [--scope <motif,motif>]
                      [--repo <chemin>] [--json]
  apv design list [--screen <écran>] [--repo <chemin>] [--json]
  apv design check [--repo <chemin>] [--json]

register copie la maquette validée vers docs/design/<nom>-validee.html (dossier : design.dir de
.apv/config.json), calcule son sha256 et inscrit la décision maquette-<nom>-validee au registre,
avec la citation exacte de l'opérateur (obligatoire : le pipeline n'invente jamais une validation).
--scope donne un périmètre à la décision (motifs de chemins, syntaxe des chemins autorisés) : seules
les specs dont les tâches peuvent toucher ces chemins doivent la couvrir ; absent, le périmètre de
l'enregistrement actif est gardé (aucun : toute spec la couvre).
register ajoute aussi à .gitattributes la ligne « <dossier>/*.html -whitespace » quand Git ne l'applique
pas déjà : une maquette est figée par son empreinte, ses espaces de fin de ligne ne doivent pas faire
échouer git diff --check. Rien n'est commité : la commande affiche les fichiers à commiter.
list affiche les maquettes validées, leur empreinte et l'état du fichier (ok, modifiée, absente).
check sort en 1 si un fichier de maquette validée a changé ou disparu sans nouvel enregistrement, ou
si la ligne de .gitattributes manque alors qu'une maquette validée porte des espaces de fin de ligne
(git diff --check échouerait) ; la ligne absente est signalée dans tous les cas.`;

const STATE_LABEL: Record<RegisteredMockup['state'], string> = {
  ok: 'ok',
  drift: 'MODIFIÉE',
  missing: 'ABSENTE',
  legacy: 'sans empreinte',
};

function describe(m: RegisteredMockup): string[] {
  return [m.slug, m.decisionId, m.file ?? '(non versée par apv design)', m.sha256 ? m.sha256.slice(0, 12) : '', STATE_LABEL[m.state], m.screens.join(', ')];
}

function attributeNote(attributes: DesignAttributeResult): string | null {
  if (attributes.status === 'added') return `  ${attributes.file} : ligne « ${attributes.line} » ajoutée (maquettes hors de git diff --check)`;
  if (attributes.status === 'ineffective') return `  Attention : ligne « ${attributes.line} » ajoutée à ${attributes.file}, mais un autre fichier d'attributs la contredit (git check-attr whitespace)`;
  return null;
}

interface AttributeCheck extends DesignAttributeResult {
  /** Registered mockups whose file has trailing whitespace. */
  whitespace: string[];
  /** Missing line while a mockup has trailing whitespace: `git diff --check` fails. */
  blocking: boolean;
}

/** The `.gitattributes` line, checked when the project has validated mockups or a mockup folder. */
function attributeCheck(repo: string, mockups: RegisteredMockup[]): AttributeCheck | { status: 'not-applicable'; blocking: false } {
  const { dir } = loadDesignConfig(repo);
  const files = mockups.filter(m => m.file && m.state !== 'missing').map(m => m.file!);
  if (!files.length && !existsSync(join(repo, dir))) return { status: 'not-applicable', blocking: false };
  const state = designAttributeState(repo, dir);
  const whitespace = state.status === 'missing' ? files.filter(f => { try { return hasWhitespaceErrors(join(repo, f)); } catch { return false; } }) : [];
  return { ...state, whitespace, blocking: whitespace.length > 0 };
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      repo: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, screens: { type: 'string' }, quote: { type: 'string' },
      artifact: { type: 'string' }, screen: { type: 'string' }, scope: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    const repo = repoPath(io, values.repo);

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
        ...(values.scope !== undefined && { scopePaths: list(values.scope) }),
      });
      const attributesFile = result.attributes.status === 'added' || result.attributes.status === 'ineffective' ? [result.attributes.file] : [];
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
        ...(attributesNote ? [attributesNote] : []),
        '',
        'À commiter (rien n\'a été commité) :',
        `  git add -- ${toCommit.join(' ')}`,
        `  git commit -m "design: maquette validée ${result.slug}" -- ${toCommit.join(' ')}`,
        '',
      ].join('\n'));
      return EXIT.ok;
    }

    if (action === 'list' || action === 'check') {
      if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
      if (action === 'check' && values.screen) throw new UsageError('--screen ne sert qu\'à list');
      if (values.scope !== undefined) throw new UsageError('--scope ne sert qu\'à register');
      const all = listMockups(repo);
      const mockups = values.screen ? all.filter(m => matchesScreen(m, values.screen!)) : all;
      const broken = all.filter(m => m.state === 'drift' || m.state === 'missing');
      if (action === 'list') {
        if (values.json) { json(io, { mockups }); return EXIT.ok; }
        if (!mockups.length) {
          io.stdout(values.screen ? `Aucune maquette validée pour l'écran « ${values.screen} ».\n` : 'Aucune maquette validée au registre (apv design register pour en verser une).\n');
          return EXIT.ok;
        }
        io.stdout(`${table(['nom', 'décision', 'fichier', 'sha256', 'état', 'écrans'], mockups.map(describe))}\n`);
        const shown = broken.filter(m => mockups.includes(m));
        if (shown.length) io.stdout(`\nAttention : ${shown.length} maquette(s) modifiée(s) ou absente(s) depuis la validation. La référence est la version enregistrée (git log -- <fichier>) ; une nouvelle version validée se verse avec apv design register.\n`);
        return EXIT.ok;
      }
      const legacy = all.filter(m => m.state === 'legacy');
      const attributes = attributeCheck(repo, all);
      const ok = broken.length === 0 && !attributes.blocking;
      if (values.json) json(io, { ok, checked: all.length - legacy.length, broken, legacy: legacy.map(m => m.decisionId), attributes });
      else {
        if (broken.length) io.stdout(`Maquettes validées modifiées sans nouvel enregistrement :\n${broken.map(m => `- ${m.file} (${m.decisionId}) : ${m.state === 'missing' ? 'fichier absent' : `sha256 ${m.actualSha256} au lieu de ${m.sha256}`}`).join('\n')}\n`);
        else io.stdout(`Maquettes validées intactes : ${all.length - legacy.length} fichier(s) conforme(s) à leur empreinte.\n`);
        if (legacy.length) io.stdout(`Non vérifiable (décision sans empreinte, à verser avec apv design register) : ${legacy.map(m => m.decisionId).join(', ')}\n`);
        if (attributes.status === 'missing') {
          io.stdout(`${attributes.blocking ? 'Erreur' : 'Attention'} : ${attributes.file} ne contient pas « ${attributes.line} »` +
            (attributes.whitespace.length ? ` et ${attributes.whitespace.join(', ')} porte(nt) des espaces de fin de ligne : git diff --check échoue.` : ' : une maquette validée qui porterait des espaces de fin de ligne ferait échouer git diff --check.') +
            ` Ajoutez la ligne (apv design register l'ajoute) ; la maquette ne se nettoie pas, son empreinte changerait.\n`);
        }
      }
      return ok ? EXIT.ok : EXIT.failed;
    }
    throw new UsageError(action ? `sous-commande inconnue : design ${action}` : 'sous-commande manquante');
  });
}
