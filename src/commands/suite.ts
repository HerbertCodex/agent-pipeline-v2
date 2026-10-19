import { spawn } from 'node:child_process';
import { loadConfig, suiteSettings } from '../config/load.js';
import { Git } from '../execution/git.js';
import { commonPath, withShare } from '../gates/suite.js';
import { LOCK_WAIT_TIMEOUT_EXIT, signalExitCode } from '../lock/run.js';
import { gitRoot } from '../run/git-probe.js';
import { commonDir, resolveStacks, type ResolvedStack } from '../stacks/idle.js';
import { UsageError, parse } from './common.js';
import type { CommandIO } from './io.js';

export const suiteHelp = `apv suite : la file des suites complètes (suite.queue), vue des autres charges lourdes

apv suite share [--wait-ms <n>] -- <commande> [args...]
    Prend une part PARTAGÉE de la file : attend tant qu'une suite complète la tient ou l'attend (« suite
    complète en cours (exécution X), attente... »), puis lance la commande et rend son code de sortie.
    Plusieurs « share » tournent ensemble ; une suite complète (suite.queue.slots à 1) attend qu'ils aient
    fini avant de démarrer ses contrôles, les nouveaux attendent derrière elle. Sans effet dans une suite
    complète (APV_SUITE_RUN) ou dans un autre « share ». File désactivée ou hors dépôt : commande lancée telle quelle.
    --wait-ms : attente maximale (défaut : suite.queue.waitMs) ; dépassée : code ${LOCK_WAIT_TIMEOUT_EXIT}, rien n'est lancé.
    Usage dans un script e2e de projet : apv suite share -- npm run test:e2e ...
`;

/** The queue of the repository around `cwd`: its file, the wait, the declared stacks; null outside a repository or with the queue disabled. */
export async function queueOf(cwd: string): Promise<{ lockFile: string; waitMs: number; stacks: ResolvedStack[] } | null> {
  try {
    const repo = gitRoot(cwd);
    const config = loadConfig(repo).config;
    const { queue } = suiteSettings(config);
    if (!queue.enabled) return null;
    return { lockFile: await commonPath(new Git(), repo, queue.lockFile), waitMs: queue.waitMs, stacks: resolveStacks(config, commonDir(repo)) };
  } catch { return null; }
}

/** Runs the command with the terminal of apv, the signals of apv forwarded to it; its exit code (128 + signal when it was killed). */
export function runChild(command: string[], io: CommandIO, env: NodeJS.ProcessEnv): Promise<number> {
  const [file, ...args] = command;
  return new Promise(done => {
    const child = spawn(file!, args, { cwd: io.cwd, env, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => [signal, forward(signal)] as const);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const end = (code: number): void => { for (const [signal, handler] of handlers) process.off(signal, handler); done(code); };
    child.once('error', error => { io.stderr(`Impossible de lancer « ${file} » : ${error.message}\n`); end(127); });
    child.once('exit', (code, signal) => end(code ?? signalExitCode(signal ?? 'SIGTERM')));
  });
}

/** `command` under a shared part of the queue of the repository around `io.cwd` (as is when there is none). */
export async function runShared(command: string[], io: CommandIO, label: string, waitMs?: number): Promise<number> {
  const queue = await queueOf(io.cwd);
  if (!queue) return runChild(command, io, io.env);
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, stop);
  try {
    return await withShare({ lockFile: queue.lockFile, waitMs: waitMs ?? queue.waitMs, label, purpose: command.join(' ').slice(0, 200), env: io.env, source: io.env,
      signal: abort.signal, log: line => io.stderr(`${line}\n`) },
    env => runChild(command, io, env),
    reason => { io.stderr(`Part partagée de la file non obtenue : ${reason}. La commande n'a pas été lancée.\n`); return LOCK_WAIT_TIMEOUT_EXIT; });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, stop);
  }
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') { io.stdout(suiteHelp); return sub === undefined ? 2 : 0; }
  try {
    if (sub !== 'share') throw new UsageError(`sous-commande inconnue : « ${sub} »`);
    const separator = rest.indexOf('--');
    if (separator < 0 || separator === rest.length - 1) throw new UsageError('« share » attend « -- » suivi de la commande à lancer');
    const { values, positionals } = parse(rest.slice(0, separator), { 'wait-ms': { type: 'string' } });
    if (positionals.length) throw new UsageError(`argument inattendu avant « -- » : ${positionals[0]}`);
    let waitMs: number | undefined;
    if (values['wait-ms'] !== undefined) {
      waitMs = Number(values['wait-ms']);
      if (!Number.isFinite(waitMs) || waitMs < 0) throw new UsageError('--wait-ms attend un nombre de millisecondes');
    }
    return await runShared(rest.slice(separator + 1), io, `apv suite share (${io.cwd})`, waitMs);
  } catch (error) {
    if (error instanceof UsageError) { io.stderr(`apv suite : ${error.message}\n\n${suiteHelp}`); return 2; }
    throw error;
  }
}
