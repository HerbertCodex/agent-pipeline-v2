import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { configFile, loadConfig } from '../config/load.js';
import { modelSettings, modelsLine } from '../config/models.js';
import { decisionLedgerIssues, decisionLedgerSchema, ledgerHash, LEDGER_FILE, LEGACY_LEDGER_FILE } from '../lifecycle/decisions.js';
import { lastQuotaReading, QUOTA_LOG } from '../quota/usage.js';
import { parseSpecDocument } from '../spec/check.js';
import { cleanLine, isActiveRun, readRunSummaries, runSummaryLine, unreadRunsLine } from '../run/summary.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import { localTime } from '../domain/time.js';
import { anchorLines, anchorStatus } from '../rules/anchor-status.js';
import { pluginLines, pluginStatus } from '../rules/plugin-status.js';
import { processGh } from '../stack/github.js';
import { freshnessLines, freshnessReport } from '../freshness/check.js';
import { duration } from '../metrics/run.js';
import { recentMeasures } from '../metrics/sources.js';
import { operatorOrdersStatus } from '../orders/status.js';
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
function files(dir) {
    if (!existsSync(dir))
        return [];
    const out = [];
    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(current, entry.name);
            if (entry.isDirectory())
                walk(path);
            else if (entry.isFile())
                out.push(path);
        }
    };
    walk(dir);
    return out;
}
export function apvStatus(repo, options = {}) {
    const cfg = { file: null, legacy: false, gates: [], ignored: [], error: null };
    // An invalid configuration leaves the defaults: the default living files are still watched.
    let freshnessSettings;
    let models = modelSettings(undefined);
    try {
        const loaded = loadConfig(repo);
        freshnessSettings = loaded.config.freshness;
        models = modelSettings(loaded.config.models);
        Object.assign(cfg, { file: loaded.file && relative(repo, loaded.file), legacy: loaded.legacy, gates: loaded.config.gates.map(g => g.id), ignored: loaded.ignored });
    }
    catch (error) {
        const found = configFile(repo).file;
        Object.assign(cfg, { file: found && relative(repo, found), error: errorMessage(error) });
    }
    const ledgerFile = [LEDGER_FILE, LEGACY_LEDGER_FILE].find(f => existsSync(join(repo, f))) ?? null;
    const ledger = { file: ledgerFile, decisions: null, hash: null, issues: 0 };
    if (ledgerFile) {
        try {
            const raw = JSON.parse(readFileSync(join(repo, ledgerFile), 'utf8'));
            const issues = decisionLedgerIssues(raw);
            ledger.issues = issues.length;
            if (!issues.length) {
                const parsed = decisionLedgerSchema.parse(raw);
                ledger.decisions = parsed.decisions.length;
                ledger.hash = ledgerHash(parsed);
            }
        }
        catch {
            ledger.issues = 1;
        }
    }
    const specs = files(join(repo, '.apv', 'specs')).filter(f => f.endsWith('.json')).map(f => {
        try {
            const doc = parseSpecDocument(JSON.parse(readFileSync(f, 'utf8')));
            const title = doc.spec !== null && typeof doc.spec === 'object' && typeof doc.spec['title'] === 'string' ? doc.spec['title'] : null;
            return { file: relative(repo, f), title, error: null };
        }
        catch (error) {
            return { file: relative(repo, f), title: null, error: errorMessage(error) };
        }
    });
    const state = files(join(repo, '.apv', 'state')).map(f => { const st = statSync(f); return { file: relative(repo, f), bytes: st.size, modifiedAt: st.mtime.toISOString() }; });
    const runs = readRunSummaries(repo);
    return { repo, config: cfg, models, ledger, specs, state, runs: runs.entries, runsUnread: runs.unread, quota: lastQuotaReading(join(repo, QUOTA_LOG)),
        freshness: freshnessReport(repo, freshnessSettings, options), metrics: measures(repo) };
}
/** The last three measures, reduced to what the line shows; a repository the measure cannot read gives none. */
function measures(repo) {
    try {
        return recentMeasures(repo).map(m => ({ specId: m.specId, totalMs: m.totalMs, end: m.end, criticalPath: m.criticalPath, finished: m.finished }));
    }
    catch {
        return [];
    }
}
const END_SHORT = { merge: 'jusqu\'à la fusion', delivery: 'jusqu\'à la livraison', 'last-event': 'en cours' };
/** « Mesure (apv metrics run) : a 7 h 59 min jusqu'à la fusion, chemin critique 1 h 59 min ; … ». */
export function metricsLine(list) {
    if (!list.length)
        return null;
    return cleanLine(`Mesure (apv metrics run) : ${list.map(m => `${m.specId} ${duration(m.totalMs)} ${END_SHORT[m.end.kind]}, chemin critique ${duration(m.criticalPath.workMs)}`).join(' ; ')}`, 600);
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, { repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        if (positionals.length)
            throw new UsageError(`argument inattendu : ${positionals.join(' ')}`);
        const status = apvStatus(repoPath(io, values.repo), { ...(io.env['HOME'] ? { home: io.env['HOME'] } : {}) });
        const anchor = await anchorStatus(status.repo, processGh(io.env['APV_GH'] || 'gh', io.env, status.repo)).catch(() => null);
        let plugin = null;
        try {
            plugin = pluginStatus(status.repo, io.env);
        }
        catch {
            plugin = null;
        }
        const operatorOrders = operatorOrdersStatus(status.repo);
        if (values.json) {
            json(io, { ...status, plugin, anchor, operatorOrders });
            return EXIT.ok;
        }
        const c = status.config;
        const q = status.quota;
        const active = status.runs.filter(isActiveRun);
        const lines = [
            `Projet : ${status.repo}`,
            `Configuration : ${c.file ? `${c.file}${c.legacy ? ' (format V2)' : ''}` : 'aucune'}${c.error ? ` ; invalide : ${c.error.split('\n')[0]}` : c.file ? ` ; contrôles : ${c.gates.join(', ') || 'aucun'}` : ''}`,
            modelsLine(status.models),
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
            ...(metricsLine(status.metrics) ? [metricsLine(status.metrics)] : []),
            cleanLine(operatorOrders.line, 2000),
            ...freshnessLines(status.freshness, value => cleanLine(value, 400), localTime),
        ];
        if (plugin)
            lines.push(...pluginLines(plugin));
        if (anchor)
            lines.push(...anchorLines(anchor));
        io.stdout(`${lines.map(l => l.trimEnd()).join('\n')}\n`);
        return EXIT.ok;
    });
}
//# sourceMappingURL=status.js.map