import { Git } from '../execution/git.js';
import { listMockups, matchesScreen, registerMockup } from '../design/registry.js';
import { EXIT, UsageError, guard, json, list, parse, repoPath, table } from './common.js';
export const usage = `Utilisation :
  apv design register <fichier.html> --name <nom> --quote "<mots de l'opérateur>"
                      [--title "<titre>"] [--screens a,b] [--artifact <url>] [--repo <chemin>] [--json]
  apv design list [--screen <écran>] [--repo <chemin>] [--json]
  apv design check [--repo <chemin>] [--json]

register copie la maquette validée vers docs/design/<nom>-validee.html (dossier : design.dir de
.apv/config.json), calcule son sha256 et inscrit la décision maquette-<nom>-validee au registre,
avec la citation exacte de l'opérateur (obligatoire : le pipeline n'invente jamais une validation).
Rien n'est commité : la commande affiche les fichiers à commiter.
list affiche les maquettes validées, leur empreinte et l'état du fichier (ok, modifiée, absente).
check sort en 1 si un fichier de maquette validée a changé ou disparu sans nouvel enregistrement.`;
const STATE_LABEL = {
    ok: 'ok',
    drift: 'MODIFIÉE',
    missing: 'ABSENTE',
    legacy: 'sans empreinte',
};
function describe(m) {
    return [m.slug, m.decisionId, m.file ?? '(non versée par apv design)', m.sha256 ? m.sha256.slice(0, 12) : '', STATE_LABEL[m.state], m.screens.join(', ')];
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, {
            repo: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, screens: { type: 'string' }, quote: { type: 'string' },
            artifact: { type: 'string' }, screen: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        const repo = repoPath(io, values.repo);
        if (action === 'register') {
            const [file, ...extra] = rest;
            if (!file)
                throw new UsageError('fichier de la maquette manquant');
            if (extra.length)
                throw new UsageError(`argument inattendu : ${extra.join(' ')}`);
            if (!values.name)
                throw new UsageError('--name manquant (ex. --name tableau-de-bord)');
            if (values.quote === undefined || values.quote.trim() === '')
                throw new UsageError('--quote manquant : citez mot pour mot la validation de l\'opérateur (« je valide »). Sans validation explicite, rien n\'est versé.');
            const reviewer = await new Git().configValue(repo, 'user.name').catch(() => null);
            const result = await registerMockup(repo, {
                file, slug: values.name, quote: values.quote, ...(values.title !== undefined && { title: values.title }),
                screens: list(values.screens), ...(values.artifact !== undefined && { artifact: values.artifact }), ...(reviewer && { reviewer }),
            });
            const toCommit = [result.target, result.ledgerFile, result.ledgerMarkdown].filter(Boolean);
            if (values.json) {
                json(io, { ...result, toCommit: result.unchanged ? [] : toCommit });
                return EXIT.ok;
            }
            if (result.unchanged) {
                io.stdout(`Déjà enregistrée : ${result.target} (décision ${result.decisionId}, sha256 ${result.sha256}). Rien à faire.\n`);
                return EXIT.ok;
            }
            io.stdout([
                `Maquette validée enregistrée : ${result.target}`,
                `  sha256   ${result.sha256}`,
                `  décision ${result.decisionId}${result.supersedes.length ? ` (remplace ${result.supersedes.join(', ')})` : ''} dans ${result.ledgerFile}`,
                '',
                'À commiter (rien n\'a été commité) :',
                `  git add -- ${toCommit.join(' ')}`,
                `  git commit -m "design: maquette validée ${result.slug}" -- ${toCommit.join(' ')}`,
                '',
            ].join('\n'));
            return EXIT.ok;
        }
        if (action === 'list' || action === 'check') {
            if (rest.length)
                throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
            if (action === 'check' && values.screen)
                throw new UsageError('--screen ne sert qu\'à list');
            const all = listMockups(repo);
            const mockups = values.screen ? all.filter(m => matchesScreen(m, values.screen)) : all;
            const broken = all.filter(m => m.state === 'drift' || m.state === 'missing');
            if (action === 'list') {
                if (values.json) {
                    json(io, { mockups });
                    return EXIT.ok;
                }
                if (!mockups.length) {
                    io.stdout(values.screen ? `Aucune maquette validée pour l'écran « ${values.screen} ».\n` : 'Aucune maquette validée au registre (apv design register pour en verser une).\n');
                    return EXIT.ok;
                }
                io.stdout(`${table(['nom', 'décision', 'fichier', 'sha256', 'état', 'écrans'], mockups.map(describe))}\n`);
                const shown = broken.filter(m => mockups.includes(m));
                if (shown.length)
                    io.stdout(`\nAttention : ${shown.length} maquette(s) modifiée(s) ou absente(s) depuis la validation. La référence est la version enregistrée (git log -- <fichier>) ; une nouvelle version validée se verse avec apv design register.\n`);
                return EXIT.ok;
            }
            const legacy = all.filter(m => m.state === 'legacy');
            if (values.json)
                json(io, { ok: broken.length === 0, checked: all.length - legacy.length, broken, legacy: legacy.map(m => m.decisionId) });
            else {
                if (broken.length)
                    io.stdout(`Maquettes validées modifiées sans nouvel enregistrement :\n${broken.map(m => `- ${m.file} (${m.decisionId}) : ${m.state === 'missing' ? 'fichier absent' : `sha256 ${m.actualSha256} au lieu de ${m.sha256}`}`).join('\n')}\n`);
                else
                    io.stdout(`Maquettes validées intactes : ${all.length - legacy.length} fichier(s) conforme(s) à leur empreinte.\n`);
                if (legacy.length)
                    io.stdout(`Non vérifiable (décision sans empreinte, à verser avec apv design register) : ${legacy.map(m => m.decisionId).join(', ')}\n`);
            }
            return broken.length ? EXIT.failed : EXIT.ok;
        }
        throw new UsageError(action ? `sous-commande inconnue : design ${action}` : 'sous-commande manquante');
    });
}
//# sourceMappingURL=design.js.map