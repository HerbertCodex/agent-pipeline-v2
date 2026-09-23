import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { checkSpec, readSpecDocument } from '../spec/check.js';
import { gitRoot } from '../run/git-probe.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv spec validate <fichier> [--repo <chemin>] [--request <texte> | --request-file <fichier>]
                    [--config <fichier>] [--draft] [--json]
  apv spec new <id> [--title <texte>] [--repo <chemin>] [--json]

validate : valide une spec (schéma, dépendances, chemins autorisés, registre des décisions) contre le
minimum de sécurité recalculé depuis le dépôt, comme au lancement. Toutes les erreurs sont listées.
Sortie : 0 si la spec est valide, 1 sinon, 2 si l'appel est incorrect.
new : écrit le gabarit .apv/specs/<id>.json (une tâche exemple, passages « À compléter »), au format
accepté par apv spec validate --draft ; <id> en kebab-case ; refuse d'écraser (sortie 1).`;

/** Kebab-case spec id: lower-case letters and digits separated by single hyphens. */
export const SPEC_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Skeleton of a new spec. Every text to write says « À compléter » and names nothing security-sensitive, so
 * that the recalculated security minimum stays neutral until the author describes the real change.
 */
export function specTemplate(title: string): Record<string, unknown> {
  return {
    title,
    problem: 'À compléter : le problème que cette spec résout, pour qui, et pourquoi maintenant.',
    scope: ['À compléter : ce que la spec change, une ligne par élément.'],
    outOfScope: ['À compléter : ce que la spec exclut explicitement.'],
    acceptance: [{ id: 'AC-1', description: 'À compléter : un critère observable.', verification: 'À compléter : comment le vérifier (test, capture, commande).' }],
    decisions: [],
    decisionCoverage: [],
    decisionResolutions: [],
    // Draft mode accepts it; launch mode (apv spec validate without --draft, apv run start) refuses a skeleton.
    questions: [{ id: 'Q-REDACTION', question: 'Spec à rédiger : remplacer chaque passage « À compléter », puis retirer cette question.' }],
    tasks: [{
      id: 'T1', title: 'À compléter : première tâche', description: 'À compléter : ce que la tâche fait, ses fichiers, ses tests.',
      acceptanceIds: ['AC-1'], allowedPaths: ['src/**'], dependsOn: [], minimumLane: 'standard',
    }],
    minimumLane: 'standard',
    experience: { uiImpact: 'none', surfaces: [], rationale: 'À compléter : effet sur l\'interface (none, minor ou major) et pourquoi.' },
  };
}

function newSpec(positionals: string[], values: { title?: string | undefined; repo?: string | undefined; json?: boolean | undefined }, io: CommandIO): number {
  const [id, ...rest] = positionals;
  if (!id) throw new UsageError('identifiant de spec manquant');
  if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
  if (!SPEC_ID.test(id) || id.length > 80) throw new UsageError(`identifiant invalide : ${id} (kebab-case : minuscules, chiffres et tirets, 80 caractères au plus)`);
  const title = (values.title ?? id).trim();
  if (!title || title.length > 500) throw new UsageError('--title : de 1 à 500 caractères');
  const repo = gitRoot(repoPath(io, values.repo));
  const file = resolve(repo, '.apv', 'specs', `${id}.json`);
  const shown = relative(repo, file).split(sep).join('/');
  if (existsSync(file)) {
    if (values.json) json(io, { created: false, file: shown, reason: 'exists' });
    else io.stderr(`La spec ${shown} existe déjà : rien n'est écrasé.\n`);
    return EXIT.failed;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(specTemplate(title), null, 2)}\n`, { flag: 'wx' });
  if (values.json) json(io, { created: true, file: shown, id, title });
  else io.stdout(`Spec créée : ${shown}\nÀ compléter, puis : apv spec validate ${shown} --draft (en rédaction) et sans --draft avant apv run start ${id}.\n`);
  return EXIT.ok;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      repo: { type: 'string' }, request: { type: 'string' }, 'request-file': { type: 'string' },
      config: { type: 'string' }, draft: { type: 'boolean' }, title: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, file, ...rest] = positionals;
    if (action === 'new') {
      const misplaced = (['request', 'request-file', 'config', 'draft'] as const).filter(o => values[o] !== undefined);
      if (misplaced.length) throw new UsageError(`option(s) sans effet pour spec new : --${misplaced.join(', --')}`);
      return newSpec(positionals.slice(1), values, io);
    }
    if (values.title !== undefined) throw new UsageError('--title : réservé à spec new');
    if (action !== 'validate') throw new UsageError(action ? `sous-commande inconnue : spec ${action}` : 'sous-commande manquante');
    if (!file) throw new UsageError('fichier de spec manquant');
    if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
    if (values.request !== undefined && values['request-file'] !== undefined) throw new UsageError('--request et --request-file sont exclusifs');
    const path = resolve(io.cwd, file);
    let request: string | undefined = values.request;
    if (values['request-file'] !== undefined) {
      try { request = readFileSync(resolve(io.cwd, values['request-file']), 'utf8'); }
      catch (error) { throw new UsageError(`demande illisible : ${errorMessage(error)}`); }
    }
    let document;
    try { document = readSpecDocument(path); }
    catch (error) {
      if (!(error instanceof PipelineError)) throw error;
      const issues = [{ code: error.code, message: error.message }];
      if (values.json) json(io, { valid: false, file: path, issues });
      else io.stdout(`Spec invalide : ${path}\n- [${error.code}] ${error.message}\n`);
      return EXIT.failed;
    }
    const result = await checkSpec({ repo: repoPath(io, values.repo), document, ready: !values.draft,
      ...(request !== undefined ? { request } : {}), ...(values.config ? { configFile: values.config } : {}) });
    const security = { minimumLane: result.security.minimumLane, topics: result.security.topics.map(t => t.id),
      requiresThreatModel: result.security.requiresThreatModel, negativeTestsRequired: result.security.negativeTestsRequired, signals: result.security.signals };
    if (values.json) {
      json(io, { valid: result.valid, file: path, title: result.title, sha: result.sha, mode: values.draft ? 'draft' : 'ready',
        requestSource: result.requestSource, ledgerFile: result.ledgerFile, configFile: result.configFile, security, issues: result.issues });
    } else {
      const source = { option: 'ligne de commande', document: 'document de spec', spec: 'texte de la spec (aucune demande fournie)' }[result.requestSource];
      const lines = [
        `${result.valid ? 'Spec valide' : 'Spec invalide'} : ${result.title ?? path}`,
        `Dépôt à ${result.sha.slice(0, 12)} ; demande lue depuis : ${source} ; mode : ${values.draft ? 'brouillon' : 'prête à lancer'}`,
        `Registre : ${result.ledgerFile ?? 'aucun'} ; configuration : ${result.configFile ?? 'aucune'}`,
        `Minimum de sécurité : voie ${security.minimumLane} ; sujets OWASP : ${security.topics.join(', ') || 'aucun'}` +
          `${security.requiresThreatModel ? ' ; modèle de menace requis' : ''}${security.negativeTestsRequired ? ' ; tests négatifs requis' : ''}`,
      ];
      if (!result.valid) lines.push('', `${result.issues.length} erreur(s) :`, ...result.issues.map(i => `- [${i.code}] ${i.message}`));
      io.stdout(`${lines.join('\n')}\n`);
    }
    return result.valid ? EXIT.ok : EXIT.failed;
  });
}
