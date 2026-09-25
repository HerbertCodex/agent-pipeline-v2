import { resolve } from 'node:path';
import { loadConfig } from '../config/load.js';
import { PipelineError } from '../domain/errors.js';
import { LockStore, defaultLockDir, parseDuration, type LockOwner } from '../lock/store.js';
import { DAST_LOG, DAST_SUMMARY, defaultReportDir, runDast } from '../review/dast.js';
import { gitRead, gitRoot, resolveCommit } from '../run/git-probe.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv dast run [--repo <copie>] [--out <dossier>] [--commit <ref>] [--wait <durée>] [--json]

Scan dynamique de sécurité (ZAP ou un autre) déclaré par le projet dans review.dast de
.apv/config.json, lancé par le chef de projet avant les revues : les agents de revue n'ont pas
le droit de lancer Docker, la revue sécurité lit le rapport.
--repo     copie détachée du commit revu (défaut : le dossier courant) ; la configuration y est lue.
--out      dossier des rapports, hors de la copie (défaut : <dossier temporaire>/apv-dast/
           <copie>-<sha court>-<horodatage>) ; il reçoit dast.log (sortie de la commande), les
           rapports de la commande ({{reportDir}}, APV_DAST_REPORT_DIR) et summary.json, écrit en
           dernier : apv wait --file <dossier>/summary.json attend la fin d'un scan lancé en arrière-plan.
--commit   vérifie que la copie est bien sur ce commit (sha, abrégé ou branche).
--wait     attente du verrou review.dast.resource (défaut 30m), comme apv lock run.
La commande tourne dans la copie, sous le verrou (défaut « dast »), bornée par review.dast.timeoutMs ;
elle reçoit les variables de DEFAULT_PASS_ENV et de review.dast.passEnv, APV_DAST_REPORT_DIR,
APV_DAST_COMMIT, APV_DAST_REPO, et les jokers {{reportDir}}, {{commit}}, {{repo}} (arguments entiers).
Sortie : 0 scan terminé à 0, 1 scan en échec, délai dépassé, verrou non obtenu ou scan non déclaré,
2 appel incorrect.`;

const options = {
  repo: { type: 'string' }, out: { type: 'string' }, commit: { type: 'string' }, wait: { type: 'string' },
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} as const;

const STATUS_TEXT = {
  passed: 'terminé à 0', failed: 'en échec', timed_out: 'arrêté au délai (review.dast.timeoutMs)', lock_timeout: 'non lancé : verrou non obtenu',
} as const;

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, options);
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (!action) throw new UsageError('sous-commande manquante (run)');
    if (action !== 'run') throw new UsageError(`sous-commande inconnue : dast ${action}`);
    if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
    let waitSeconds = 1800;
    if (values.wait !== undefined) {
      try { waitSeconds = parseDuration(values.wait, '--wait'); } catch (error) { throw new UsageError((error as Error).message); }
    }
    const repo = gitRoot(repoPath(io, values.repo));
    const settings = loadConfig(repo).config.review?.dast;
    if (!settings) {
      throw new PipelineError('DAST_NONE', `Aucun scan dynamique déclaré (review.dast de .apv/config.json dans ${repo}) : la revue sécurité note le scan dynamique « non vérifié : non déclaré par le projet »`);
    }
    const head = resolveCommit(repo, 'HEAD');
    if (!head) throw new PipelineError('DAST_COMMIT', `Aucun commit dans ${repo}`);
    if (values.commit !== undefined) {
      const wanted = resolveCommit(repo, values.commit);
      if (!wanted) throw new PipelineError('DAST_COMMIT', `--commit : commit introuvable dans ${repo} : ${values.commit}`);
      if (wanted !== head) throw new PipelineError('DAST_COMMIT', `La copie ${repo} est sur ${head}, pas sur ${wanted} (--commit ${values.commit}) : le scan porte sur le commit revu`);
    }
    const clean = gitRead(repo, ['status', '--porcelain', '--untracked-files=no']) === '';
    const reportDir = values.out !== undefined ? resolve(io.cwd, values.out) : defaultReportDir(repo, head, new Date());
    const poll = io.env['APV_LOCK_POLL_MS'] ? Number(io.env['APV_LOCK_POLL_MS']) : undefined;
    const store = new LockStore(defaultLockDir(io.env), poll && Number.isFinite(poll) ? { pollMs: poll } : {});
    const owner: LockOwner = { pid: process.pid, host: store.host, label: io.env['APV_LOCK_LABEL'] || io.env['USER'] || 'apv dast' };
    if (!values.json) io.stdout(`Scan dynamique du commit ${head} dans ${repo}, sous le verrou « ${settings.resource} » ; rapports : ${reportDir}\n`);
    const summary = await runDast({ repo, commit: head, clean, reportDir, settings, env: io.env, stderr: io.stderr, store, owner, waitSeconds });
    if (values.json) json(io, { reportDir, summary: `${reportDir}/${DAST_SUMMARY}`, ...summary });
    else {
      io.stdout([
        `Scan dynamique ${STATUS_TEXT[summary.status]} (code ${summary.exitCode}) en ${duration(summary.durationMs)}${clean ? '' : ' ; attention : la copie avait des fichiers suivis modifiés'}`,
        `Rapports : ${reportDir} (${summary.files.length ? summary.files.join(', ') : 'aucun fichier'})`,
        `Journal : ${reportDir}/${DAST_LOG} ; résumé : ${reportDir}/${DAST_SUMMARY}`,
        'À donner à la revue sécurité (dossier des rapports), qui les lit sans relancer le scan.',
      ].join('\n') + '\n');
    }
    return summary.status === 'passed' ? EXIT.ok : EXIT.failed;
  });
}
