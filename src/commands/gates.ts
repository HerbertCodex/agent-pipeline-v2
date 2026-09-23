import { relative } from 'node:path';
import { loadConfig } from '../config/load.js';
import { runGates } from '../gates/run.js';
import { EXIT, UsageError, guard, json, list, parse, repoPath, table } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv gates run [--only a,b] [--config <fichier>] [--base <ref>] [--concurrency N]
                [--keep-going] [--repo <chemin>] [--json]

Exécute les contrôles déclarés (.apv/config.json, sinon pipeline.v2.json) dans le dépôt :
dépendances, ressources, variables transmises, délais et masquage des secrets respectés.
Écrit un reçu JSON par contrôle dans .apv/receipts/<exécution>/ et affiche un tableau.
Sortie : 0 si tous les contrôles passent, 1 sinon, 2 appel incorrect.`;

const STATUS: Record<string, string> = { passed: 'réussi', failed: 'échec', timed_out: 'délai dépassé', cancelled: 'annulé',
  spawn_error: 'non lancé', blocked: 'bloqué', cached: 'réutilisé' };

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      only: { type: 'string' }, config: { type: 'string' }, base: { type: 'string' }, concurrency: { type: 'string' },
      'keep-going': { type: 'boolean' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (action !== 'run') throw new UsageError(action ? `sous-commande inconnue : gates ${action}` : 'sous-commande manquante');
    if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
    const concurrency = values.concurrency === undefined ? 3 : Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new UsageError('--concurrency attend un entier entre 1 et 16');
    const repo = repoPath(io, values.repo);
    const loaded = loadConfig(repo, values.config);
    const result = await runGates({ repo, config: loaded.config, only: list(values.only), concurrency, failFast: !values['keep-going'], env: io.env,
      ...(values.base ? { base: values.base } : {}) });
    const rows = result.receipts.map(r => ({ gate: r.gateId, status: r.status, exitCode: r.exitCode, durationMs: Math.round(r.durationMs), receipt: r.id,
      diagnostic: r.diagnostic }));
    if (values.json) {
      json(io, { ok: result.ok, runId: result.runId, candidateSha: result.candidateSha, baseSha: result.baseSha, dirty: result.dirty,
        config: loaded.file, legacyConfig: loaded.legacy, ignoredSections: loaded.ignored, added: result.added,
        receiptsDirectory: result.directory, gates: rows });
    } else {
      const lines = [`Contrôles à ${result.candidateSha.slice(0, 12)} (configuration : ${loaded.file ? relative(result.repo, loaded.file) || loaded.file : 'aucune'}${loaded.legacy ? ', format V2' : ''})`];
      if (result.added.length) lines.push(`Dépendances ajoutées : ${result.added.join(', ')}`);
      if (result.dirty) lines.push('Attention : modifications non commitées présentes ; les reçus décrivent plus que le commit.');
      lines.push('', table(['contrôle', 'statut', 'code', 'durée'], rows.map(r => [r.gate, STATUS[r.status] ?? r.status, r.exitCode === null ? '-' : String(r.exitCode), `${(r.durationMs / 1000).toFixed(1)} s`])));
      for (const r of rows.filter(r => r.diagnostic && r.status !== 'blocked')) lines.push('', `--- ${r.gate} (${STATUS[r.status] ?? r.status}) ---`, r.diagnostic.trimEnd());
      lines.push('', `${result.ok ? 'Tous les contrôles passent.' : 'Des contrôles échouent.'} Reçus : ${relative(io.cwd, result.directory) || result.directory}`);
      io.stdout(`${lines.join('\n')}\n`);
    }
    return result.ok ? EXIT.ok : EXIT.failed;
  });
}
