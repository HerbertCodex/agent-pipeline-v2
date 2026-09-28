import { loadConfig, suiteSettings } from '../config/load.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { parseDuration } from '../lock/store.js';
import { signalExitCode } from '../lock/run.js';
import { matches } from '../policy/policy.js';
import { probeHost } from '../preview/config.js';
import { loadPreview, previewStatus, stopPreview, updatePreview, withPreviewLock, type PreviewContext } from '../preview/service.js';
import { DEFAULT_REVIEW_PATHS } from '../review/config.js';
import { gitRead, gitRoot, resolveCommit } from '../run/git-probe.js';
import { runAudit, type AuditSummary, type PageFactorResult } from '../web/audit.js';
import { FORM_FACTORS, PAGE_PATH, WEB_METRIC_IDS, type FormFactor, type WebCategory, type WebMetric, type WebSettings } from '../web/config.js';
import type { Shortfall } from '../web/lighthouse.js';
import { EXIT, UsageError, guard, json, parse, repoPath, table } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv web audit (--url <origine> | --production | --preview) [--page <chemin>]... [--runs N]
                [--form-factor mobile|desktop] [--base <ref>] [--readiness-only] [--wait <durée>]
                [--repo <chemin>] [--json]

Qualité mesurable des pages publiques d'un site (section « web » de .apv/config.json) :
Lighthouse (version épinglée web.lighthouse) en Chrome sans interface, mobile et bureau, N passages
valides par page (web.runs, 3 par défaut, --runs) dont la médiane est gardée par catégorie
(performance, accessibility, best-practices, seo, agentic-browsing) et par métrique (FCP, LCP,
TBT, CLS, SI), comparée aux seuils (web.thresholds). Une mesure invalide (erreur Lighthouse comme
NO_FCP, avertissement de mesure, statut HTTP autre que 200, redirection, score absent, autre
version) est écartée, jamais comptée, et le passage refait (au plus N de plus). Puis contrôles de
préparation à la recherche et aux IA, sur l'origine auditée seulement : statut 200, robots.txt, sitemap,
canonical, title et description uniques, lang, JSON-LD, hreflang, llms.txt (web.checks : refuse,
warn ou off). On mesure ce que le projet contrôle : aucun classement n'est promis.
  --url <origine>   site déjà en ligne (production : lecture seule), par exemple https://exemple.fr
  --production      l'origine web.productionUrl (audit après une fusion déployée)
  --preview         l'aperçu local d'APV (section preview) sur le commit HEAD : réutilisé s'il sert
                    déjà ce commit, sinon construit et démarré puis arrêté à la fin (jamais laissé en
                    marche), sous le verrou preview:<projet> ; --wait borne l'attente du verrou (30m).
  --base <ref>      avec --preview (contrôle d'une PR) : audit seulement si un fichier qui répond à
                    web.paths (défaut : review.paths.ui, sinon les motifs d'interface génériques) a
                    changé depuis la base commune de <ref> et de HEAD ; sinon « non concerné », sortie 0.
  --page <chemin>   limite aux pages données (répétable), déclarées ou non dans web.pages.
  --readiness-only  contrôles de préparation seulement, sans Lighthouse.
Mesure sous la file des suites complètes (suite.queue ; déjà tenue quand l'audit tourne dans une
suite, APV_SUITE_RUN), et seulement si la charge moyenne sur 1 min est sous web.load.max (défaut :
suite.queue.maxLoad, sinon la moitié des processeurs), attendue au plus web.load.waitMs : au-delà,
refus WEB_LOAD. Chrome : web.chrome, CHROME_PATH, le Chromium de Playwright, sinon celui du
système ; ceux qu'une mesure laisse sont arrêtés. Rapports (JSON et HTML du passage médian,
summary.json) dans web.reportsDir (.apv/web/<audit>/ par défaut, ignoré par Git).
Sortie : 0 tous les seuils atteints et aucun refus, 1 seuil manqué, mesure invalide, refus d'un
contrôle, charge trop haute ou aperçu en échec, 2 appel incorrect.`;

const options = {
  url: { type: 'string' }, production: { type: 'boolean' }, preview: { type: 'boolean' }, page: { type: 'string', multiple: true },
  runs: { type: 'string' }, 'form-factor': { type: 'string' }, base: { type: 'string' }, 'readiness-only': { type: 'boolean' },
  wait: { type: 'string' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} as const;

const CATEGORY_LABEL: Record<WebCategory, string> = { performance: 'perf', accessibility: 'a11y', 'best-practices': 'bp', seo: 'seo', 'agentic-browsing': 'agent' };
const CATEGORY_NAME: Record<WebCategory, string> = { performance: 'performance', accessibility: 'accessibilité', 'best-practices': 'bonnes pratiques', seo: 'SEO', 'agentic-browsing': 'navigation par agent' };
const FACTOR: Record<FormFactor, string> = { mobile: 'mobile', desktop: 'bureau' };

const comma = (n: number, digits: number): string => n.toFixed(digits).replace(/\.?0+$/, '').replace('.', ',');
export function metricText(metric: WebMetric, value: number): string {
  if (metric === 'cls') return comma(value, 3) || '0';
  return value >= 1000 ? `${comma(value / 1000, 1)} s` : `${Math.round(value)} ms`;
}
const scoreText = (value: number): string => Number.isInteger(value) ? String(value) : comma(value, 1);
function shortfallText(s: Shortfall): string {
  if (s.kind === 'category') return `${CATEGORY_NAME[s.id as WebCategory] ?? s.id} ${scoreText(s.value)} < ${s.threshold}`;
  const m = s.id as WebMetric;
  return `${m.toUpperCase()} ${metricText(m, s.value)} > ${metricText(m, s.threshold)}`;
}
const bytes = (n: number): string => n >= 1024 * 1024 ? `${comma(n / 1024 / 1024, 1)} Mio` : `${Math.round(n / 1024)} Kio`;

function text(summary: AuditSummary): string {
  const lines: string[] = [];
  const cats = summary.categories;
  if (summary.lighthouse) {
    const rows = summary.pages.flatMap(p => p.results.map(r => {
      const missed = new Set(r.shortfalls.map(s => s.id));
      const cell = (id: string, value: string | undefined) => value === undefined ? '-' : missed.has(id) ? `${value}!` : value;
      return [p.path, FACTOR[r.formFactor], ...cats.map(c => cell(c, r.median?.scores[c] !== undefined ? scoreText(r.median.scores[c]!) : undefined)),
        ...WEB_METRIC_IDS.map(m => cell(m, r.median?.metrics[m] !== undefined ? metricText(m, r.median.metrics[m]!) : undefined)),
        r.valid ? '' : 'mesure invalide'];
    }));
    lines.push(table(['page', 'appareil', ...cats.map(c => CATEGORY_LABEL[c]), ...WEB_METRIC_IDS.map(m => m.toUpperCase()), ''], rows));
    const t = summary.thresholds;
    const metricThresholds = WEB_METRIC_IDS.filter(m => t.metrics[m] !== null).map(m => `${m.toUpperCase()} <= ${metricText(m, t.metrics[m]!)}`);
    lines.push(`Médiane de ${summary.runs} passage(s) valides ; « ! » : seuil manqué (${cats.map(c => `${CATEGORY_LABEL[c]} >= ${t.categories[c]}`).join(', ')}${metricThresholds.length ? `, ${metricThresholds.join(', ')}` : ''}).`);
    const failing = summary.pages.flatMap(p => p.results.filter(r => r.shortfalls.length || !r.valid).map(r => ({ p, r })));
    for (const { p, r } of failing) lines.push('', ...resultLines(p.path, r));
  }
  const { findings, notes } = summary.readiness;
  const refused = findings.filter(f => f.level === 'refuse');
  const warned = findings.filter(f => f.level === 'warn');
  lines.push(...(lines.length ? [''] : []), `Préparation à la recherche et aux IA : ${refused.length ? `${refused.length} refus` : 'aucun refus'}, ${warned.length} avertissement(s).`);
  for (const f of [...refused, ...warned]) lines.push(`  [${f.level === 'refuse' ? 'refus' : 'avert.'}] ${f.check}${f.page ? ` ${f.page}` : ''} : ${f.message}`);
  for (const n of notes) lines.push(`  note : ${n}`);
  return lines.join('\n');
}

function resultLines(path: string, r: PageFactorResult): string[] {
  const out = [`${path} (${FACTOR[r.formFactor]}) : ${r.valid ? r.shortfalls.map(shortfallText).join(' ; ') : `mesure invalide (${r.runs.length} passage(s) valides sur ${r.runs.length + r.invalid.length})`}`];
  for (const i of r.invalid) out.push(`  passage ${i.attempt} écarté : ${i.reasons.join(' ; ')}`);
  if (r.opportunities.length) {
    out.push('  Principales opportunités (passage médian) :');
    r.opportunities.forEach((o, i) => {
      const metrics = Object.entries(o.savings).map(([m, v]) => `${m} ${m === 'CLS' ? comma(v, 3) : metricText('lcp', v)}`).join(', ');
      const gain = [metrics ? `gain estimé ${metrics}` : '', o.displayValue ?? (o.savingsBytes ? `${bytes(o.savingsBytes)} en moins` : '')].filter(Boolean).join(' ; ');
      out.push(`  ${i + 1}. ${o.title} (${CATEGORY_NAME[o.category]}, ${o.id})${gain ? ` : ${gain}` : ''}`);
    });
  }
  if (r.report) out.push(`  Rapport : ${r.report.html ?? r.report.json}`);
  return out;
}

/** Files changed between the merge base of `ref` and HEAD. */
function changedSince(repo: string, ref: string): { base: string; files: string[] } {
  const target = resolveCommit(repo, ref);
  if (!target) throw new UsageError(`--base : référence introuvable : ${ref}`);
  const base = gitRead(repo, ['merge-base', target, 'HEAD']);
  if (!base) throw new PipelineError('WEB_BASE', `Aucune base commune entre ${ref} et HEAD`);
  const out = gitRead(repo, ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD']);
  return { base, files: (out ?? '').split('\0').filter(Boolean) };
}

function origin(value: string, what: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new UsageError(`${what} : adresse invalide : ${value}`); }
  if (!/^https?:$/.test(url.protocol)) throw new UsageError(`${what} : http ou https attendu : ${value}`);
  if (url.username || url.password) throw new UsageError(`${what} : pas d'identifiants dans l'adresse`);
  return url.origin;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, options);
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (!action) throw new UsageError('sous-commande manquante (audit)');
    if (action !== 'audit') throw new UsageError(`sous-commande inconnue : web ${action}`);
    if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
    const targets = [values.url !== undefined, values.production === true, values.preview === true].filter(Boolean).length;
    if (targets !== 1) throw new UsageError('une cible et une seule : --url <origine>, --production ou --preview');
    if (values.base !== undefined && !values.preview) throw new UsageError('--base ne sert qu\'avec --preview (contrôle d\'une PR)');
    if (values.wait !== undefined && !values.preview) throw new UsageError('--wait ne sert qu\'avec --preview (verrou de l\'aperçu)');
    let runs: number | undefined;
    if (values.runs !== undefined) {
      runs = Number(values.runs);
      if (!Number.isSafeInteger(runs) || runs < 1 || runs > 15) throw new UsageError('--runs attend un entier entre 1 et 15');
    }
    const factor = values['form-factor'];
    if (factor !== undefined && !(FORM_FACTORS as readonly string[]).includes(factor)) throw new UsageError('--form-factor attend mobile ou desktop');
    for (const page of values.page ?? []) if (!PAGE_PATH.test(page)) throw new UsageError(`--page : chemin absolu du site attendu (« /faq ») : ${page}`);
    let waitSeconds = 1800;
    if (values.wait !== undefined) { try { waitSeconds = parseDuration(values.wait, '--wait'); } catch (error) { throw new UsageError(errorMessage(error)); } }

    const repo = gitRoot(repoPath(io, values.repo));
    const loaded = loadConfig(repo);
    const settings: WebSettings | undefined = loaded.config.web;
    if (!settings) throw new PipelineError('WEB_NONE', `Aucune section « web » dans la configuration de ${repo} (docs/CONFIGURATION.md, « Qualité web »)`);
    const suite = suiteSettings(loaded.config);
    const pages = values.page?.length ? [...new Set(values.page)] : settings.pages;
    const formFactors = factor ? [factor as FormFactor] : settings.formFactors;
    const head = resolveCommit(repo, 'HEAD');
    const say = (line: string): void => { io.stderr(`${line}\n`); };

    if (values.base !== undefined) {
      const globs = settings.paths ?? loaded.config.review?.paths?.ui ?? [...DEFAULT_REVIEW_PATHS.ui];
      const { base, files } = changedSince(repo, values.base);
      const touched = files.filter(f => globs.some(g => matches(f, g)));
      if (!touched.length) {
        const message = `Aucun fichier d'interface modifié depuis ${base.slice(0, 12)} (base commune avec ${values.base}, motifs web.paths) : audit web non requis.`;
        if (values.json) json(io, { ok: true, skipped: true, reason: message, base, changed: files.length });
        else io.stdout(`${message}\n`);
        return EXIT.ok;
      }
      say(`${touched.length} fichier(s) d'interface modifié(s) depuis ${base.slice(0, 12)} (${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ', ...' : ''}) : audit de l'aperçu.`);
    }

    const abort = new AbortController();
    let received: NodeJS.Signals | null = null;
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => {
      const handler = (): void => {
        if (!received) { received = signal; io.stderr(`Signal ${signal} reçu : mesure annulée ; Chrome et l'aperçu lancés par l'audit sont arrêtés avant la sortie.\n`); }
        abort.abort();
      };
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const audit = (target: string, source: 'url' | 'preview', commit: string | null) => runAudit({
      repo, settings, suiteQueue: suite.queue, suiteMaxLoad: suite.queue.maxLoad, origin: target, source, commit, pages, formFactors,
      runs: runs ?? settings.runs, readinessOnly: values['readiness-only'] === true, env: io.env, log: say, signal: abort.signal,
      ...(io.env['APV_LOCK_POLL_MS'] ? { hooks: { lockPollMs: Number(io.env['APV_LOCK_POLL_MS']) } } : {}),
    });
    let summary: AuditSummary;
    const notes: string[] = [];
    try {
      if (values.preview) {
        if (!head) throw new PipelineError('WEB_PREVIEW', `Aucun commit dans ${repo}`);
        if (gitRead(repo, ['status', '--porcelain', '--untracked-files=no'])) notes.push(`l'arbre a des modifications non commitées : l'aperçu audite le commit ${head.slice(0, 12)}, pas l'arbre de travail`);
        const loadedPreview = loadPreview(repo, io.env);
        const ctx: PreviewContext = { repo, env: io.env, progress: s => { if (!values.json) io.stderr(s); } };
        summary = await withPreviewLock(ctx, waitSeconds, 'apv web audit --preview', async lockEnv => {
          const status = await previewStatus(repo);
          const reuse = status.running && status.state?.commit === head;
          if (!reuse) {
            if (status.running && status.state) notes.push(`l'aperçu en marche (branche ${status.state.branch}, commit ${status.state.commit.slice(0, 12)}) a été remplacé puis arrêté ; apv preview update ${status.state.branch} le relance`);
            say(`Aperçu du commit ${head.slice(0, 12)} : construction et démarrage...`);
            const updated = await updatePreview(ctx, loadedPreview, head, lockEnv);
            if (!updated.ok) throw new PipelineError('WEB_PREVIEW', `Aperçu en échec à l'étape « ${updated.step} » : ${updated.message} (journal : ${updated.updateLog}${updated.step === 'health' || updated.step === 'serve' ? `, serveur : ${updated.logFile}` : ''}). Aucun serveur ne reste.`);
          } else notes.push(`aperçu déjà en marche sur ce commit, réutilisé et laissé comme il était`);
          const { port, host } = loadedPreview.config.serve;
          try { return await audit(`http://${probeHost(host)}:${port}`, 'preview', head); }
          finally {
            if (!reuse) { const stopped = await stopPreview(repo); if (stopped.stopped) say(`Aperçu arrêté (groupe de processus ${stopped.pid}).`); }
          }
        });
      } else {
        const target = values.production ? (settings.productionUrl ? origin(settings.productionUrl, 'web.productionUrl') : null) : origin(values.url!, '--url');
        if (!target) throw new PipelineError('WEB_NONE', 'web.productionUrl absent : --production ne sait pas quelle origine auditer (ou --url <origine>)');
        summary = await audit(target, 'url', head);
      }
    } catch (error) {
      if (received) { io.stderr(`Interrompu (${received}) : ${errorMessage(error)}\n`); return signalExitCode(received); }
      throw error;
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }

    if (values.json) { json(io, { ...summary, notes }); return summary.ok ? EXIT.ok : EXIT.failed; }
    const head0 = summary.lighthouse
      ? `Lighthouse ${summary.lighthouse.version} (${summary.lighthouse.source === 'npx' ? 'npx' : 'dépendance du projet'}), ${summary.browser?.path} (${summary.browser?.source}), ${summary.runs} passage(s) valides par page et appareil`
      : 'contrôles de préparation seulement (--readiness-only)';
    const queue = summary.queue ? `${summary.queue.held ? `file des suites tenue${summary.queue.waitedMs > 1000 ? ` après ${Math.round(summary.queue.waitedMs / 1000)} s` : ''}` : summary.queue.reason} ; ` : '';
    const load = summary.lighthouse ? `${queue}charge au départ ${summary.load.atStart?.toFixed(2) ?? '?'}, la plus haute ${summary.load.highest?.toFixed(2) ?? '?'} (seuil ${summary.load.max})` : '';
    io.stdout([
      `Audit web de ${summary.origin} (${summary.source === 'preview' ? `aperçu, commit ${summary.commit?.slice(0, 12)}` : 'en ligne, lecture seule'}) : ${head0}.`,
      ...(load ? [load] : []), '', text(summary), ...(notes.length ? [''] : []), ...notes.map(n => `Note : ${n}`), '',
      `Rapports : ${summary.reportsDir} (summary.json, <page>.<appareil>.report.html)`,
      summary.ok ? 'Verdict : tous les seuils atteints, aucun refus.'
        : `Verdict : ${[summary.counts.shortfalls ? `${summary.counts.shortfalls} seuil(s) manqué(s)` : '', summary.counts.invalid ? `${summary.counts.invalid} mesure(s) invalide(s)` : '',
          summary.counts.refused ? `${summary.counts.refused} refus de préparation` : ''].filter(Boolean).join(', ')}.`,
    ].join('\n') + '\n');
    return summary.ok ? EXIT.ok : EXIT.failed;
  });
}
