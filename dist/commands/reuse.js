import { loadConfig } from '../config/load.js';
import { gitRoot } from '../run/git-probe.js';
import { checkReuse } from '../reuse/check.js';
import { REUSE_RULES } from '../reuse/config.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv reuse check [--base <ref>] [--all] [--repo <chemin>] [--json]

Contrôle que le changement réutilise les éléments existants du projet (docs/REUSE.md) :
  native      élément natif réservé (par défaut select, dialog, datalist) écrit hors des composants partagés ;
  styles      primitive de la feuille globale (.btn, .input...) redéfinie dans un style local ;
  duplicates  bloc de code copié (au moins 5 lignes et 50 jetons par défaut), paires fichier:lignes ;
  names       nouveau composant dont le nom ou le rôle doublonne un composant partagé (AdminToast et Toast) ;
  typography  valeur qui se coupe en fin de ligne faute d'espace insécable (14 h 47, 12 €), langue déclarée.
Ce que le changement ajoute depuis la base commune de --base (sinon de reuse.reference, par exemple
origin/main) compte comme nouveau ; ce qui existait déjà est signalé sans bloquer. Sans base ni référence,
tout compte comme nouveau. --all liste aussi tous les constats existants (par défaut : 5 par règle).
Configuration facultative : section « reuse » de .apv/config.json (reference, shared, ignore, native, styles,
duplicates, names, typography, severity).
Sortie : 0 aucun constat bloquant (gravité error et nouveau), 1 au moins un, configuration invalide ou
référence introuvable, 2 appel incorrect.`;
const LABEL = {
    native: 'Éléments natifs réservés',
    styles: 'Primitives de style redéfinies',
    duplicates: 'Code dupliqué',
    names: 'Composants homonymes ou redondants',
    typography: 'Valeurs typographiques sécables',
};
const SEVERITY = { off: 'désactivée', warning: 'avertissement', error: 'erreur' };
const EXISTING_SHOWN = 5;
const place = (f) => `${f.path}:${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ''}`;
export function formatReuse(report, all) {
    const base = report.base.mergeBase
        ? `base commune de ${report.base.ref} (${report.base.mergeBase.slice(0, 12)})${report.base.source === 'option' ? ', --base' : ', reuse.reference'}`
        : 'aucune base (ni --base ni reuse.reference) : tout compte comme nouveau';
    const lines = [`Réutilisation : ${report.analyzedFiles} fichier(s) analysé(s), ${base}.`];
    for (const rule of REUSE_RULES) {
        const s = report.rules[rule];
        lines.push('', `${LABEL[rule]} (${SEVERITY[s.severity]}) : ${s.active ? `${s.new} nouveau(x), ${s.existing} existant(s)` : s.note ?? 'règle désactivée'}`);
        const found = report.findings.filter(f => f.rule === rule);
        for (const f of found.filter(x => x.isNew))
            lines.push(`  ${f.blocking ? '[bloquant] ' : ''}${place(f)} : ${f.message}`);
        const existing = found.filter(x => !x.isNew);
        for (const f of all ? existing : existing.slice(0, EXISTING_SHOWN))
            lines.push(`  [existant] ${place(f)} : ${f.message}`);
        if (!all && existing.length > EXISTING_SHOWN)
            lines.push(`  et ${existing.length - EXISTING_SHOWN} autre(s) existant(s) (--all pour tout lister).`);
    }
    const blocking = report.findings.filter(f => f.blocking).length;
    lines.push('', report.ok
        ? 'Résultat : aucun constat bloquant.'
        : `Résultat : ÉCHEC, ${blocking} constat(s) bloquant(s). Réutiliser le composant ou le module existant (carte du code : .apv/code-map.md), l'étendre de façon générique, ou factoriser le bloc copié ; retirer ce que le changement rend inutile.`);
    return `${lines.join('\n')}\n`;
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, {
            base: { type: 'string' }, all: { type: 'boolean' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (action !== 'check')
            throw new UsageError(action ? `sous-commande inconnue : reuse ${action}` : 'sous-commande manquante');
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        if (values.base !== undefined && (!values.base || values.base.startsWith('-')))
            throw new UsageError('--base : référence Git attendue');
        const repo = gitRoot(repoPath(io, values.repo));
        const { config } = loadConfig(repo);
        const report = await checkReuse(repo, config, values.base !== undefined ? { base: values.base } : {});
        if (values.json)
            json(io, { ...report, repo });
        else
            io.stdout(formatReuse(report, values.all === true));
        return report.ok ? EXIT.ok : EXIT.failed;
    });
}
//# sourceMappingURL=reuse.js.map