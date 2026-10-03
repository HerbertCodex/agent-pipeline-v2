import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { configFile, loadConfig } from '../config/load.js';
import { decisionLedgerIssues, decisionLedgerSchema, ledgerHash, LEDGER_FILE, LEGACY_LEDGER_FILE } from '../lifecycle/decisions.js';
import { lastQuotaReading, QUOTA_LOG } from '../quota/usage.js';
import { parseSpecDocument } from '../spec/check.js';
import { cleanLine, isActiveRun, readRunSummaries, runSummaryLine, unreadRunsLine } from '../run/summary.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import { localTime } from '../domain/time.js';
import { anchorLines, anchorStatus } from '../rules/anchor-status.js';
import { pluginLines, pluginStatus } from '../rules/plugin-status.js';
import { processGh } from '../stack/github.js';
export const usage = `Utilisation :
  apv status [--repo <chemin>] [--json]

Résume l'état de .apv/ : configuration, registre des décisions (empreinte), specs de .apv/specs/,
état de reprise de .apv/state/, une ligne par exécution en cours (apv run) et dernier relevé de quota ; le plugin
de Claude Code (installé, activé, sa version face à celle de l'outil), les règles de fusion que le plugin installé
ne connaît pas encore et celles qu'apporte la prochaine version de l'outil (branche suivie, telle que récupérée) ;
puis les ancrages des règles avant fusion : journal de l'opérateur (messages reçus, ou pourquoi aucun), protection
de la branche par défaut sur GitHub (gh api ; indisponible en plan gratuit pour un dépôt privé, dit une fois),
audit des fusions faites hors de apv stack merge (apv audit merges).`;
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
export function apvStatus(repo) {
    const cfg = { file: null, legacy: false, gates: [], ignored: [], error: null };
    try {
        const loaded = loadConfig(repo);
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
    return { repo, config: cfg, ledger, specs, state, runs: runs.entries, runsUnread: runs.unread, quota: lastQuotaReading(join(repo, QUOTA_LOG)) };
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
        const status = apvStatus(repoPath(io, values.repo));
        const anchor = await anchorStatus(status.repo, processGh(io.env['APV_GH'] || 'gh', io.env, status.repo)).catch(() => null);
        let plugin = null;
        try {
            plugin = pluginStatus(status.repo, io.env);
        }
        catch {
            plugin = null;
        }
        if (values.json) {
            json(io, { ...status, plugin, anchor });
            return EXIT.ok;
        }
        const c = status.config;
        const q = status.quota;
        const active = status.runs.filter(isActiveRun);
        const lines = [
            `Projet : ${status.repo}`,
            `Configuration : ${c.file ? `${c.file}${c.legacy ? ' (format V2)' : ''}` : 'aucune'}${c.error ? ` ; invalide : ${c.error.split('\n')[0]}` : c.file ? ` ; contrôles : ${c.gates.join(', ') || 'aucun'}` : ''}`,
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