import { loadConfig } from '../config/load.js';
import { loadDbConfig } from '../db/config.js';
import { designDir } from '../design/config.js';
import { sensitivePaths } from '../policy/policy.js';
import { ALWAYS_REVIEWED, REVIEW_DOMAINS, reviewPlanSettings } from '../review/config.js';
import { planReviews } from '../review/plan.js';
import { RISK_LABEL } from '../review/risk.js';
import { gitRoot, resolveCommit } from '../run/git-probe.js';
import { PipelineError } from '../domain/errors.js';
import { DOMAIN_REVIEWERS, latestReviews, parseCapture, recordReview } from '../rules/reviews.js';
import { commonDir } from '../stacks/idle.js';
import { docsOnlyLane, laneLines, planInLane } from '../rules/docs-only.js';
import { rulesSettings } from '../rules/config.js';
import { REQUIRED_WEB_GATES } from '../rules/required.js';
import { anchorKey, readOperatorMessages } from '../rules/operator.js';
import { basename, dirname, join, resolve } from 'node:path';
import { lastQuotaReading, QUOTA_LOG } from '../quota/usage.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
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
Code serveur, chemin sensible et configuration l'emportent sur tests et outillage (sauf un fichier nommé
comme un test) : ils gardent tous les domaines ; les lignes des tests et de l'outillage restent lues
pour les termes de données et RGPD (adresse e-mail réelle comprise).
Niveau de risque du diff, avec sa raison, décidé par le chemin seul : faible quand chaque fichier est un
test (*.test.*, *.spec.*, *.e2e.*, dossiers test/ et tests/), de la documentation (*.md hors dossiers
servis) ou une maquette, sans terme de données ni RGPD (securite, plus fidelite pour une maquette) ;
élevé pour tout le reste, interface comprise (le contenu n'est jamais lu comme du texte seul), plan
inchangé.
Voie sans code (docs/REGLES.md) : quand chaque fichier du diff est du registre des décisions, une maquette
validée à l'empreinte de sa décision, un brouillon de maquette, une spec (.apv/specs), le journal du pipeline,
un fichier d'état non exécutable (.apv/state) ou de la documentation *.md hors dossiers servis, aucun domaine
n'est retenu (securite comprise), sauf ceux que forcent review.always ou --force ; le plan le dit et liste
les fichiers qui l'ont permise (lane en JSON). Liste fermée, réduite seulement par rules.docsOnly.
Relectures proportionnées (docs/REGLES.md) : un renommage pur de classes et d'identifiants (fichiers d'interface,
de style et de tests seulement, lignes gardées en place, noms renommés un à un avec leurs sélecteurs) ne garde
pas fidelite ; les notes de pilotage (.apv/state, journal, spec ajoutée) et un verrou de dépendances sans son
package.json gardent securite seule (un hôte de téléchargement nouveau du verrou est cité) ; les attributs data-*
et le Markdown de .apv/ ne sont pas lus pour les termes. Chaque domaine retenu dit s'il est exigé par le diff
ou retenu par prudence (basis) ; au niveau de quota finish_only, le plan le rappelle en tête.
--base    la branche de départ (la base de la PR) ; --head : la tête revue (défaut HEAD).
--force    garde un domaine quoi que dise le diff (répétable, ou liste séparée par des virgules).
--repo     le dépôt (défaut : le dossier courant) ; la configuration (review de .apv/config.json) y est lue.
Chemins et termes : review.paths (ui, data, migrations, personal, legal, neutral, tooling, server), review.terms (data,
personal), review.always (domaines toujours gardés), db.migrations et design.dir ; docs/CONFIGURATION.md.
Sortie : 0 plan établi, 1 référence introuvable ou configuration invalide, 2 appel incorrect.

  apv review record --commit <sha> --domain <domaine> --reviewer <agent> --report <fichier>
                    --critical <n> --high <n> --medium <n> --low <n> [--capture <largeur>:<thème>:<fichier>]...
  apv review show --commit <sha> [--json]

record  enregistre une relecture au commit exact, lancée depuis la copie relue (HEAD à ce commit, fichiers
        suivis inchangés) : domaine, agent relecteur (celui du domaine : securite apv:qa-securite, fidelite
        apv:qa-fidelite, donnees apv:architecte-donnees, rgpd apv:dpo), nombres de constats par gravité, rapport
        complet (qui cite le commit) et, pour fidelite, les captures (largeur desktop, phone ou tablet ; thème light
        ou dark ; PNG, JPEG ou WebP, une image différente par capture). Copie le tout dans le magasin du dépôt
        (<répertoire git commun>/apv/reviews/<commit>/), jamais versionné. Le crochet Bash du plugin ne laisse
        lancer record qu'à l'agent relecteur du domaine : ni l'implementer, ni l'intégrateur, ni le chef de projet.
show    affiche la dernière relecture de chaque domaine à ce commit (lue par apv rules check avant une fusion).
Sortie de record et show : 0 fait, 1 refusé (copie à un autre commit, relecteur ou fichiers invalides), 2 appel incorrect.`;
const options = {
    base: { type: 'string' }, head: { type: 'string' }, force: { type: 'string', multiple: true }, repo: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    commit: { type: 'string' }, domain: { type: 'string' }, reviewer: { type: 'string' }, report: { type: 'string' },
    critical: { type: 'string' }, high: { type: 'string' }, medium: { type: 'string' }, low: { type: 'string' }, capture: { type: 'string', multiple: true },
};
const RECORD_ONLY = ['domain', 'reviewer', 'report', 'critical', 'high', 'medium', 'low', 'capture'];
function count(value, name) {
    if (value === undefined)
        throw new UsageError(`--${name} manquant (nombre de constats ${name}, 0 s'il n'y en a pas)`);
    if (!/^\d{1,5}$/.test(value))
        throw new UsageError(`--${name} : entier attendu (${value})`);
    return Number(value);
}
function forced(values) {
    const out = [];
    for (const name of (values ?? []).flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean)) {
        if (!REVIEW_DOMAINS.includes(name))
            throw new UsageError(`--force : domaine inconnu ${name} (${REVIEW_DOMAINS.join(', ')})`);
        if (!out.includes(name))
            out.push(name);
    }
    return out;
}
const QUOTA_NOTICE = {
    finish_only: 'Quota au niveau finir seulement : les relectures par prudence attendent l\'accord de l\'opérateur',
    save_now: 'Quota au niveau sauvegarder maintenant : les relectures par prudence attendent l\'accord de l\'opérateur',
};
/**
 * The latest reading of `apv quota` (`.apv/state/quota.log`) in the checkout and in the main checkout of the repository
 * (the journal is not versioned: a worktree has its own, or none), or null when none was taken.
 */
function planQuota(repo, common) {
    const places = [repo, ...(basename(common) === '.git' ? [dirname(common)] : [])];
    const readings = places.map(p => lastQuotaReading(join(p, QUOTA_LOG))).filter((r) => r !== null);
    const last = readings.sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!last)
        return null;
    const notice = QUOTA_NOTICE[last.level];
    return { level: last.level, at: last.at, percent: last.percent, notice: notice ? `${notice} (relevé du ${last.at.slice(0, 16).replace('T', ' ')}, ${last.percent ?? '?'} %).` : null };
}
const BASIS_LABEL = { diff: 'exigée par le diff', prudence: 'par prudence' };
function text(plan) {
    const c = plan.counts;
    const lines = [
        ...(plan.quota?.notice ? [plan.quota.notice] : []),
        `Plan des revues : ${plan.base.ref} (${plan.mergeBase.slice(0, 12)}, base commune) à ${plan.head.ref} (${plan.head.sha.slice(0, 12)})`,
        ...laneLines(plan.lane),
        `${c.files} fichier(s) : ${c.renames} renommage(s) pur(s), ${c.paths} aux seuls chemins réécrits (imports, références, mise en forme), ${c.names} aux seuls noms de classes ou d'identifiants renommés, ${c.content} au contenu changé (dont ${c.neutral} tests, documentation ou outillage, ${c.notes} notes de pilotage, ${c.ledger} du registre des décisions, ${c.locks} verrou(s) de dépendances, ${c.unclassified} non classé(s) ou plus fort(s) que tests et outillage)`,
        `Risque : ${RISK_LABEL[plan.risk.level]} : ${plan.risk.reason}`,
        ...plan.risk.files.slice(0, 10).map(f => `    ${f.path} : ${f.why}`),
        ...(plan.risk.fileCount > 10 ? [`    (et ${plan.risk.fileCount - 10} autres)`] : []),
        '',
        'Domaines retenus :',
    ];
    const files = (d) => d.files.length ? `\n    ${d.files.join(', ')}${d.fileCount > d.files.length ? ` (et ${d.fileCount - d.files.length} autres)` : ''}` : '';
    // The security review is always kept: no basis said for it.
    for (const d of plan.domains.filter(x => x.decision === 'retained')) {
        lines.push(`  ${d.domain}${d.domain === ALWAYS_REVIEWED || !d.basis ? '' : ` (${BASIS_LABEL[d.basis]})`} : ${d.reason}${files(d)}`);
    }
    const skipped = plan.domains.filter(x => x.decision === 'skipped');
    lines.push('', skipped.length ? 'Domaines sautés :' : 'Domaines sautés : aucun');
    for (const d of skipped)
        lines.push(`  ${d.domain} : ${d.reason}`);
    if (skipped.length)
        lines.push('', 'Dans une exécution : apv run set <id> review:<domaine> skipped --note "<raison ci-dessus>" pour chaque domaine sauté ; --force <domaine> le garde.');
    return `${lines.join('\n')}\n`;
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, options);
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (!action)
            throw new UsageError('sous-commande manquante (plan, record ou show)');
        if (action !== 'plan' && action !== 'record' && action !== 'show')
            throw new UsageError(`sous-commande inconnue : review ${action}`);
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        if (action !== 'record') {
            const extra = RECORD_ONLY.filter(k => values[k] !== undefined);
            if (extra.length)
                throw new UsageError(`option de review record seulement : --${extra.join(', --')}`);
        }
        if (action === 'record' || action === 'show') {
            const planOnly = ['base', 'head', 'force'].filter(k => values[k] !== undefined);
            if (planOnly.length)
                throw new UsageError(`option de review plan seulement : --${planOnly.join(', --')}`);
            if (!values.commit)
                throw new UsageError('--commit <sha> manquant (le commit relu)');
            const checkout = gitRoot(repoPath(io, values.repo));
            const common = commonDir(checkout);
            if (action === 'show') {
                const sha = resolveCommit(checkout, values.commit);
                if (!sha)
                    throw new PipelineError('SHA', `Commit introuvable : ${values.commit}`);
                const found = latestReviews(common, sha);
                if (values.json) {
                    json(io, { commit: sha, reviews: Object.fromEntries(found) });
                    return EXIT.ok;
                }
                const lines = [`Relectures enregistrées à ${sha.slice(0, 12)} :`];
                if (!found.size)
                    lines.push('  aucune');
                for (const [domain, r] of found) {
                    const f = r.record?.findings;
                    lines.push(`  ${domain} : ${r.record ? `${r.record.reviewer}, ${r.record.at}, critique ${f.critical}, haut ${f.high}, moyen ${f.medium}, bas ${f.low}, ${r.record.captures.length} capture(s)` : 'illisible'}${r.problem ? ` ; INUTILISABLE : ${r.problem}` : ''}`);
                }
                io.stdout(`${lines.join('\n')}\n`);
                return EXIT.ok;
            }
            if (!values.domain)
                throw new UsageError(`--domain manquant (${Object.keys(DOMAIN_REVIEWERS).join(', ')})`);
            if (!values.reviewer)
                throw new UsageError('--reviewer manquant (l\'agent relecteur du domaine, par exemple apv:qa-securite)');
            if (!values.report)
                throw new UsageError('--report <fichier> manquant (le rapport complet de la relecture)');
            const findings = { critical: count(values.critical, 'critical'), high: count(values.high, 'high'), medium: count(values.medium, 'medium'), low: count(values.low, 'low') };
            const captures = (values.capture ?? []).map(c => { const parsed = parseCapture(c); return { ...parsed, path: resolve(io.cwd, parsed.path) }; });
            const record = recordReview(common, { checkout, commit: values.commit, domain: values.domain, reviewer: values.reviewer, findings, report: resolve(io.cwd, values.report), captures });
            if (values.json) {
                json(io, record);
                return EXIT.ok;
            }
            io.stdout(`Enregistrement ${record.id}\nRelecture ${record.domain} enregistrée à ${record.commit.slice(0, 12)} par ${record.reviewer} : critique ${findings.critical}, haut ${findings.high}, moyen ${findings.medium}, bas ${findings.low}` +
                `${record.captures.length ? ` ; captures ${record.captures.map(c => `${c.viewport}:${c.theme}`).join(', ')}` : ''}.\n` +
                'Le crochet du plugin la scelle si tu es l\'agent relecteur du domaine ; sans ce sceau, apv rules check ne la compte pas.\n' +
                `${findings.critical || findings.high ? 'Constats critiques ou hauts : la fusion de ce commit sera refusée (apv rules check) tant qu\'un nouveau commit corrigé n\'est pas relu.\n' : ''}`);
            return EXIT.ok;
        }
        if (values.commit !== undefined)
            throw new UsageError('--commit : option de review record et review show');
        if (!values.base)
            throw new UsageError('--base manquant (la branche de départ, base de la PR)');
        const force = forced(values.force);
        const repo = gitRoot(repoPath(io, values.repo));
        const { config } = loadConfig(repo);
        const settings = reviewPlanSettings(config.review);
        // `securite` in review.always or --force changes nothing: it is kept anyway (but in the lane without code, it keeps it).
        const sensitive = [...sensitivePaths, ...config.risk.highPaths];
        const dir = designDir(config.design);
        const raw = planReviews({
            repo, base: values.base, head: values.head ?? 'HEAD', settings,
            migrations: loadDbConfig(repo).config.migrations, designDir: dir,
            sensitive, force: force.filter(d => d !== ALWAYS_REVIEWED),
        });
        const common = commonDir(repo);
        const anchor = anchorKey(common);
        const lane = await docsOnlyLane({ repo, mergeBase: raw.mergeBase, head: raw.head.sha, plan: raw, designDir: dir, sensitive,
            settings: rulesSettings(config.rules, REQUIRED_WEB_GATES).docsOnly, messages: readOperatorMessages(common, anchor.key), key: anchor.key });
        const plan = { ...planInLane(raw, lane, { always: settings.always, operator: force }), quota: planQuota(repo, common) };
        if (values.json)
            json(io, plan);
        else
            io.stdout(text(plan));
        return EXIT.ok;
    });
}
//# sourceMappingURL=review.js.map