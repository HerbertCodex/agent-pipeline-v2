import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { configFile, loadConfig } from '../config/load.js';
import { modelSettings, modelsLine, type ModelSettings } from '../config/models.js';
import { decisionLedgerIssues, decisionLedgerSchema, ledgerHash, LEDGER_FILE, LEGACY_LEDGER_FILE } from '../lifecycle/decisions.js';
import { lastQuotaReading, QUOTA_LOG } from '../quota/usage.js';
import { parseSpecDocument } from '../spec/check.js';
import { cleanLine, isActiveRun, readRunSummaries, runSummaryLine, unreadRunsLine, type RunSummaryEntry } from '../run/summary.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';
import { localTime } from '../domain/time.js';
import { anchorLines, anchorStatus } from '../rules/anchor-status.js';
import { pluginLines, pluginStatus } from '../rules/plugin-status.js';
import { CI_PROTECTED_SCRIPTS, rulesSettings, type CiProofSettings } from '../rules/config.js';
import { processGh } from '../stack/github.js';
import { freshnessLines, freshnessReport, type FreshnessOptions, type FreshnessReport } from '../freshness/check.js';
import type { FreshnessSettings } from '../freshness/config.js';
import { duration, type RunMetrics } from '../metrics/run.js';
import { recentMeasures } from '../metrics/sources.js';

export const usage = `Utilisation :
  apv status [--repo <chemin>] [--json]

Résume l'état de .apv/ : configuration, registre des décisions (empreinte), specs de .apv/specs/,
état de reprise de .apv/state/, une ligne par exécution en cours (apv run) et dernier relevé de quota ; le plugin
de Claude Code (installé, activé, sa version face à celle de l'outil), les règles de fusion que le plugin installé
ne connaît pas encore et celles qu'apporte la prochaine version de l'outil (branche suivie, telle que récupérée) ;
puis les ancrages des règles avant fusion : journal de l'opérateur (messages reçus, ou pourquoi aucun), protection
de la branche par défaut sur GitHub (gh api ; indisponible en plan gratuit pour un dépôt privé, dit une fois),
audit des fusions faites hors de apv stack merge (apv audit merges). Ligne « Mesure » : temps de bout en bout et
chemin critique des trois dernières exécutions (apv metrics run, sans appel gh).

Section « Fichiers d'état périmés » (lecture seule, rien n'est déplacé ni supprimé) : .apv/state/resume.md, les
.apv/state/*.md et les chemins de freshness.paths (~/ accepté) modifiés il y a plus de freshness.maxAgeDays jours
(défaut 2), et ceux de plus de freshness.maxLines lignes (défaut 300), avec la proposition « couper : état court +
archive ». Seules la date et le nombre de lignes sont lus ; la date seule pour un nom de secret (.env*, *key*,
*secret*, *token*). Un fichier absent est ignoré.`;

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path); else if (entry.isFile()) out.push(path);
    }
  };
  walk(dir);
  return out;
}

export interface ApvStatus {
  repo: string;
  config: { file: string | null; legacy: boolean; gates: string[]; ignored: string[]; error: string | null };
  /** Model of each role and the effort (`models`, docs/CONFIGURATION.md): the defaults when the section is absent or the configuration invalid. */
  models: ModelSettings;
  /**
   * The proof by the CI as this working tree declares it (`rules.ciProof`; apv rules check reads it at the merge base):
   * null when undeclared or the configuration invalid.
   */
  ciProof: { settings: CiProofSettings | null };
  ledger: { file: string | null; decisions: number | null; hash: string | null; issues: number };
  specs: { file: string; title: string | null; error: string | null }[];
  state: { file: string; bytes: number; modifiedAt: string }[];
  /** Spec executions (`.apv/state/run-<id>.json`, apv run), the most recent ones up to the read bounds. */
  runs: RunSummaryEntry[];
  /** State files of executions left unread (read bounds reached). */
  runsUnread: number;
  quota: ReturnType<typeof lastQuotaReading>;
  /** Living state files not rewritten for too long or too long themselves (`freshness`, src/freshness/check.ts). */
  freshness: FreshnessReport;
  /** Time measure of the last three executions (apv metrics run, offline), most recent first; empty outside a repository. */
  metrics: Pick<RunMetrics, 'specId' | 'totalMs' | 'end' | 'criticalPath' | 'finished'>[];
}

export function apvStatus(repo: string, options: FreshnessOptions = {}): ApvStatus {
  const cfg: ApvStatus['config'] = { file: null, legacy: false, gates: [], ignored: [], error: null };
  // An invalid configuration leaves the defaults: the default living files are still watched.
  let freshnessSettings: FreshnessSettings | undefined;
  let models = modelSettings(undefined);
  let ciProof: CiProofSettings | null = null;
  try {
    const loaded = loadConfig(repo);
    freshnessSettings = loaded.config.freshness;
    models = modelSettings(loaded.config.models);
    ciProof = rulesSettings(loaded.config.rules, []).ciProof;
    Object.assign(cfg, { file: loaded.file && relative(repo, loaded.file), legacy: loaded.legacy, gates: loaded.config.gates.map(g => g.id), ignored: loaded.ignored });
  } catch (error) {
    const found = configFile(repo).file;
    Object.assign(cfg, { file: found && relative(repo, found), error: errorMessage(error) });
  }
  const ledgerFile = [LEDGER_FILE, LEGACY_LEDGER_FILE].find(f => existsSync(join(repo, f))) ?? null;
  const ledger: ApvStatus['ledger'] = { file: ledgerFile, decisions: null, hash: null, issues: 0 };
  if (ledgerFile) {
    try {
      const raw = JSON.parse(readFileSync(join(repo, ledgerFile), 'utf8')) as unknown;
      const issues = decisionLedgerIssues(raw);
      ledger.issues = issues.length;
      if (!issues.length) { const parsed = decisionLedgerSchema.parse(raw); ledger.decisions = parsed.decisions.length; ledger.hash = ledgerHash(parsed); }
    } catch { ledger.issues = 1; }
  }
  const specs = files(join(repo, '.apv', 'specs')).filter(f => f.endsWith('.json')).map(f => {
    try {
      const doc = parseSpecDocument(JSON.parse(readFileSync(f, 'utf8')) as unknown);
      const title = doc.spec !== null && typeof doc.spec === 'object' && typeof (doc.spec as Record<string, unknown>)['title'] === 'string' ? (doc.spec as Record<string, string>)['title']! : null;
      return { file: relative(repo, f), title, error: null };
    } catch (error) { return { file: relative(repo, f), title: null, error: errorMessage(error) }; }
  });
  const state = files(join(repo, '.apv', 'state')).map(f => { const st = statSync(f); return { file: relative(repo, f), bytes: st.size, modifiedAt: st.mtime.toISOString() }; });
  const runs = readRunSummaries(repo);
  return { repo, config: cfg, models, ciProof: { settings: ciProof }, ledger, specs, state, runs: runs.entries, runsUnread: runs.unread, quota: lastQuotaReading(join(repo, QUOTA_LOG)),
    freshness: freshnessReport(repo, freshnessSettings, options), metrics: measures(repo) };
}

/** The last three measures, reduced to what the line shows; a repository the measure cannot read gives none. */
function measures(repo: string): ApvStatus['metrics'] {
  try { return recentMeasures(repo).map(m => ({ specId: m.specId, totalMs: m.totalMs, end: m.end, criticalPath: m.criticalPath, finished: m.finished })); }
  catch { return []; }
}

const END_SHORT: Record<RunMetrics['end']['kind'], string> = { merge: 'jusqu\'à la fusion', delivery: 'jusqu\'à la livraison', 'last-event': 'en cours' };

/** « Mesure (apv metrics run) : a 7 h 59 min jusqu'à la fusion, chemin critique 1 h 59 min ; … ». */
export function metricsLine(list: ApvStatus['metrics']): string | null {
  if (!list.length) return null;
  return cleanLine(`Mesure (apv metrics run) : ${list.map(m => `${m.specId} ${duration(m.totalMs)} ${END_SHORT[m.end.kind]}, chemin critique ${duration(m.criticalPath.workMs)}`).join(' ; ')}`, 600);
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, { repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    if (positionals.length) throw new UsageError(`argument inattendu : ${positionals.join(' ')}`);
    const status = apvStatus(repoPath(io, values.repo), { ...(io.env['HOME'] ? { home: io.env['HOME'] } : {}) });
    const anchor = await anchorStatus(status.repo, processGh(io.env['APV_GH'] || 'gh', io.env, status.repo)).catch(() => null);
    let plugin: ReturnType<typeof pluginStatus> | null = null;
    try { plugin = pluginStatus(status.repo, io.env); } catch { plugin = null; }
    if (values.json) { json(io, { ...status, plugin, anchor }); return EXIT.ok; }
    const c = status.config;
    const q = status.quota;
    const active = status.runs.filter(isActiveRun);
    const lines = [
      `Projet : ${status.repo}`,
      `Configuration : ${c.file ? `${c.file}${c.legacy ? ' (format V2)' : ''}` : 'aucune'}${c.error ? ` ; invalide : ${c.error.split('\n')[0]}` : c.file ? ` ; contrôles : ${c.gates.join(', ') || 'aucun'}` : ''}`,
      modelsLine(status.models),
      ciProofLine(status.ciProof.settings),
      `Registre : ${status.ledger.file ? `${status.ledger.file} ; ${status.ledger.issues ? `invalide (${status.ledger.issues} erreur(s), voir apv ledger validate)` : `${status.ledger.decisions} décision(s), empreinte ${status.ledger.hash}`}` : 'aucun'}`,
      `Specs (.apv/specs) : ${status.specs.length ? '' : 'aucune'}`,
      // File names, titles and parse errors come from files any agent or commit can write: one cleaned line each.
      ...status.specs.map(s => cleanLine(`- ${s.file}${s.title ? ` : ${s.title}` : ''}${s.error ? ` (illisible : ${s.error.split(/\r?\n/)[0]})` : ''}`)),
      `État (.apv/state) : ${status.state.length ? '' : 'aucun'}`,
      ...status.state.map(s => cleanLine(`- ${s.file} (${s.bytes} octets, ${localTime(s.modifiedAt)})`)),
      `Exécutions en cours : ${active.length || status.runsUnread ? '' : 'aucune'}`,
      ...active.map(r => `- ${runSummaryLine(r)}`),
      ...(status.runsUnread ? [`- ${unreadRunsLine(status.runsUnread)}`] : []),
      `Quota : ${q ? `${localTime(q.at)} ; session ${q.session ? `${q.session.percent} %` : '?'} ; semaine ${q.week ? `${q.week.percent} %` : '?'} ; niveau ${q.level}` : 'aucun relevé'}`,
      ...(metricsLine(status.metrics) ? [metricsLine(status.metrics)!] : []),
      ...freshnessLines(status.freshness, value => cleanLine(value, 400), localTime),
    ];
    if (plugin) lines.push(...pluginLines(plugin));
    if (anchor) lines.push(...anchorLines(anchor));
    io.stdout(`${lines.map(l => l.trimEnd()).join('\n')}\n`);
    return EXIT.ok;
  });
}

/** The line « Preuve CI » of apv status: the declaration of the working tree, as apv rules check would read it at the base. */
export function ciProofLine(ci: CiProofSettings | null): string {
  if (!ci) return 'Preuve CI (rules.ciProof) : non déclarée (preuve locale seule)';
  return cleanLine(`Preuve CI (rules.ciProof) : ${ci.workflow}, job ${ci.job}, check run « ${ci.name} », contrôles ${ci.gates.join(', ')}`
    + `${ci.artifact ? `, reçus en artefact ${ci.artifact} (mesure seulement)` : ''} ; fichiers protégés : ${[...ci.protectedPaths, CI_PROTECTED_SCRIPTS].join(', ')}`
    + ' (lue à la base commune par apv rules check)', 2000);
}
