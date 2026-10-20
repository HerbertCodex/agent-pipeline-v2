import { loadConfig } from '../config/load.js';
import { loadDbConfig } from '../db/config.js';
import { designDir } from '../design/config.js';
import { sensitivePaths } from '../policy/policy.js';
import { ALWAYS_REVIEWED, REVIEW_DOMAINS, reviewPlanSettings, type ReviewDomainName } from '../review/config.js';
import { planReviews, type ReviewPlan } from '../review/plan.js';
import { gitRoot } from '../run/git-probe.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv review plan --base <ref> [--head <ref>] [--force <domaine>]... [--repo <dépôt>] [--json]

Propose les domaines de revue de /apv:review d'après la nature du diff (depuis la base commune de
<base> et <head>, renommages détectés) : lancée par le chef de projet avant les revues.
Règles : securite toujours, sans exception ; fidelite si l'interface ou une maquette validée change de
contenu ; donnees si une migration, un schéma, une requête ou un dépôt change ; rgpd si une migration,
des données personnelles, un export, un traceur ou un texte légal changent. Un renommage pur (100 %) ou
des chemins seuls réécrits (imports, références à un fichier déplacé, imports remis en forme)
ne changent pas le contenu (sauf une migration). Un fichier non classé au
contenu changé garde tous les domaines (prudence) : un domaine n'est sauté que sur preuve positive.
--base     la branche de départ (la base de la PR) ; --head : la tête revue (défaut HEAD).
--force    garde un domaine quoi que dise le diff (répétable, ou liste séparée par des virgules).
--repo     le dépôt (défaut : le dossier courant) ; la configuration (review de .apv/config.json) y est lue.
Chemins et termes : review.paths (ui, data, migrations, personal, legal, neutral), review.terms (data,
personal), review.always (domaines toujours gardés), db.migrations et design.dir ; docs/CONFIGURATION.md.
Sortie : 0 plan établi, 1 référence introuvable ou configuration invalide, 2 appel incorrect.`;

const options = {
  base: { type: 'string' }, head: { type: 'string' }, force: { type: 'string', multiple: true }, repo: { type: 'string' },
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} as const;

function forced(values: string[] | undefined): ReviewDomainName[] {
  const out: ReviewDomainName[] = [];
  for (const name of (values ?? []).flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean)) {
    if (!(REVIEW_DOMAINS as readonly string[]).includes(name)) throw new UsageError(`--force : domaine inconnu ${name} (${REVIEW_DOMAINS.join(', ')})`);
    if (!out.includes(name as ReviewDomainName)) out.push(name as ReviewDomainName);
  }
  return out;
}

function text(plan: ReviewPlan): string {
  const c = plan.counts;
  const lines = [
    `Plan des revues : ${plan.base.ref} (${plan.mergeBase.slice(0, 12)}, base commune) à ${plan.head.ref} (${plan.head.sha.slice(0, 12)})`,
    `${c.files} fichier(s) : ${c.renames} renommage(s) pur(s), ${c.paths} aux seuls chemins réécrits (imports, références, mise en forme), ${c.content} au contenu changé (dont ${c.neutral} tests, documentation ou outillage, ${c.unclassified} non classé(s))`,
    '',
    'Domaines retenus :',
  ];
  const files = (d: ReviewPlan['domains'][number]): string => d.files.length ? `\n    ${d.files.join(', ')}${d.fileCount > d.files.length ? ` (et ${d.fileCount - d.files.length} autres)` : ''}` : '';
  for (const d of plan.domains.filter(x => x.decision === 'retained')) lines.push(`  ${d.domain} : ${d.reason}${files(d)}`);
  const skipped = plan.domains.filter(x => x.decision === 'skipped');
  lines.push('', skipped.length ? 'Domaines sautés :' : 'Domaines sautés : aucun');
  for (const d of skipped) lines.push(`  ${d.domain} : ${d.reason}`);
  if (skipped.length) lines.push('', 'Dans une exécution : apv run set <id> review:<domaine> skipped --note "<raison ci-dessus>" pour chaque domaine sauté ; --force <domaine> le garde.');
  return `${lines.join('\n')}\n`;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, options);
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (!action) throw new UsageError('sous-commande manquante (plan)');
    if (action !== 'plan') throw new UsageError(`sous-commande inconnue : review ${action}`);
    if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
    if (!values.base) throw new UsageError('--base manquant (la branche de départ, base de la PR)');
    const force = forced(values.force);
    const repo = gitRoot(repoPath(io, values.repo));
    const { config } = loadConfig(repo);
    const settings = reviewPlanSettings(config.review);
    // `securite` in review.always or --force changes nothing: it is kept anyway.
    const plan = planReviews({
      repo, base: values.base, head: values.head ?? 'HEAD', settings,
      migrations: loadDbConfig(repo).config.migrations, designDir: designDir(config.design),
      sensitive: [...sensitivePaths, ...config.risk.highPaths], force: force.filter(d => d !== ALWAYS_REVIEWED),
    });
    if (values.json) json(io, plan);
    else io.stdout(text(plan));
    return EXIT.ok;
  });
}
