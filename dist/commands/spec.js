import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { checkSpec, readSpecDocument } from '../spec/check.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv spec validate <fichier> [--repo <chemin>] [--request <texte> | --request-file <fichier>]
                    [--config <fichier>] [--draft] [--json]

Valide une spec (schéma, dépendances, chemins autorisés, registre des décisions) contre le minimum
de sécurité recalculé depuis le dépôt, comme au lancement. Toutes les erreurs sont listées.
Sortie : 0 si la spec est valide, 1 sinon, 2 si l'appel est incorrect.`;
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, {
            repo: { type: 'string' }, request: { type: 'string' }, 'request-file': { type: 'string' },
            config: { type: 'string' }, draft: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, file, ...rest] = positionals;
        if (action !== 'validate')
            throw new UsageError(action ? `sous-commande inconnue : spec ${action}` : 'sous-commande manquante');
        if (!file)
            throw new UsageError('fichier de spec manquant');
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        if (values.request !== undefined && values['request-file'] !== undefined)
            throw new UsageError('--request et --request-file sont exclusifs');
        const path = resolve(io.cwd, file);
        let request = values.request;
        if (values['request-file'] !== undefined) {
            try {
                request = readFileSync(resolve(io.cwd, values['request-file']), 'utf8');
            }
            catch (error) {
                throw new UsageError(`demande illisible : ${errorMessage(error)}`);
            }
        }
        let document;
        try {
            document = readSpecDocument(path);
        }
        catch (error) {
            if (!(error instanceof PipelineError))
                throw error;
            const issues = [{ code: error.code, message: error.message }];
            if (values.json)
                json(io, { valid: false, file: path, issues });
            else
                io.stdout(`Spec invalide : ${path}\n- [${error.code}] ${error.message}\n`);
            return EXIT.failed;
        }
        const result = await checkSpec({ repo: repoPath(io, values.repo), document, ready: !values.draft,
            ...(request !== undefined ? { request } : {}), ...(values.config ? { configFile: values.config } : {}) });
        const security = { minimumLane: result.security.minimumLane, topics: result.security.topics.map(t => t.id),
            requiresThreatModel: result.security.requiresThreatModel, negativeTestsRequired: result.security.negativeTestsRequired, signals: result.security.signals };
        if (values.json) {
            json(io, { valid: result.valid, file: path, title: result.title, sha: result.sha, mode: values.draft ? 'draft' : 'ready',
                requestSource: result.requestSource, ledgerFile: result.ledgerFile, configFile: result.configFile, security, issues: result.issues });
        }
        else {
            const source = { option: 'ligne de commande', document: 'document de spec', spec: 'texte de la spec (aucune demande fournie)' }[result.requestSource];
            const lines = [
                `${result.valid ? 'Spec valide' : 'Spec invalide'} : ${result.title ?? path}`,
                `Dépôt à ${result.sha.slice(0, 12)} ; demande lue depuis : ${source} ; mode : ${values.draft ? 'brouillon' : 'prête à lancer'}`,
                `Registre : ${result.ledgerFile ?? 'aucun'} ; configuration : ${result.configFile ?? 'aucune'}`,
                `Minimum de sécurité : voie ${security.minimumLane} ; sujets OWASP : ${security.topics.join(', ') || 'aucun'}` +
                    `${security.requiresThreatModel ? ' ; modèle de menace requis' : ''}${security.negativeTestsRequired ? ' ; tests négatifs requis' : ''}`,
            ];
            if (!result.valid)
                lines.push('', `${result.issues.length} erreur(s) :`, ...result.issues.map(i => `- [${i.code}] ${i.message}`));
            io.stdout(`${lines.join('\n')}\n`);
        }
        return result.valid ? EXIT.ok : EXIT.failed;
    });
}
//# sourceMappingURL=spec.js.map