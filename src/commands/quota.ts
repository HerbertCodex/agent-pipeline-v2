import { join } from 'node:path';
import { appendQuotaLog, processRunner, readQuota, QUOTA_LOG, QUOTA_THRESHOLDS, type QuotaLevel, type UsageRunner } from '../quota/usage.js';
import { ensureApvGitignore } from '../config/apv-files.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv quota [--repo <chemin>] [--no-log] [--json]

Relève les fenêtres d'usage (session de 5 h, semaine tous modèles) avec claude -p "/usage",
nomme la plus contraignante (binding), classe le relevé (${QUOTA_THRESHOLDS.slow_down} % ralentir, ${QUOTA_THRESHOLDS.finish_only} % finir sans lancer, ${QUOTA_THRESHOLDS.save_now} % sauvegarder) et l'ajoute à ${QUOTA_LOG}.
Exécutions /apv:run simultanées : autant que de piles de test libres au niveau ok, une de plus au
maximum à ${QUOTA_THRESHOLDS.slow_down} %, aucune nouvelle au-delà (celles en cours se terminent).
La variable APV_CLAUDE_BIN remplace l'exécutable claude. Sortie : 0 relevé lu, 1 relevé illisible.`;

export const levelText: Record<QuotaLevel, string> = {
  ok: 'normal : continuer',
  slow_down: 'ralentir : doser les vagues',
  finish_only: 'finir les tâches en cours sans en lancer de nouvelles',
  save_now: 'sauvegarder maintenant (commits wip, push, notes de reprise) et prévenir l\'opérateur',
  unknown: 'inconnu : relevé illisible',
};

/**
 * How many executions (`/apv:run`) may run side by side at each level: as many as free test stacks below the
 * first threshold, one more at most from it, none beyond (the running ones finish).
 */
export const runsText: Record<QuotaLevel, string> = {
  ok: 'autant que de piles de test libres',
  slow_down: 'une de plus au maximum',
  finish_only: 'aucune nouvelle, finir celles en cours',
  save_now: 'aucune nouvelle, sauvegarder celles en cours',
  unknown: 'aucune nouvelle sans relevé lisible',
};

/** Entry point with an injectable runner, so tests never call `claude`. */
export async function runQuota(args: string[], io: CommandIO, runner?: UsageRunner): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      repo: { type: 'string' }, 'no-log': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    if (positionals.length) throw new UsageError(`argument inattendu : ${positionals.join(' ')}`);
    const repo = repoPath(io, values.repo);
    const executable = io.env['APV_CLAUDE_BIN'] || 'claude';
    const { reading, command } = await readQuota(runner ?? processRunner(io.env, repo), executable);
    const log = join(repo, QUOTA_LOG);
    if (!values['no-log']) { appendQuotaLog(log, reading); ensureApvGitignore(repo); }
    const ok = reading.level !== 'unknown';
    if (values.json) {
      json(io, { ...reading, logged: values['no-log'] ? null : log, ...(ok ? {} : { command: { status: command.status, output: `${command.stdout}\n${command.stderr}`.trim().slice(-2000) } }) });
    } else {
      const describe = (w: typeof reading.session): string => w ? `${w.percent} % utilisés${w.resets ? `, remise à zéro ${w.resets}` : ''}` : 'non lu';
      const binding = reading.binding === 'week' ? 'semaine' : reading.binding === 'session' ? 'session' : null;
      const lines = [`Session (5 h) : ${describe(reading.session)}`, `Semaine (tous modèles) : ${describe(reading.week)}`,
        ...(binding ? [`Fenêtre la plus contraignante : ${binding} (${reading.percent} %)`] : []),
        `Niveau : ${reading.level} (${levelText[reading.level]})`, `Exécutions /apv:run simultanées : ${runsText[reading.level]}`];
      if (!ok) lines.push(`Commande ${executable} : ${command.status}. ${`${command.stdout}\n${command.stderr}`.trim().slice(-500)}`);
      io.stdout(`${lines.join('\n')}\n`);
    }
    return ok ? EXIT.ok : EXIT.failed;
  });
}

export async function run(args: string[], io: CommandIO): Promise<number> { return runQuota(args, io); }
