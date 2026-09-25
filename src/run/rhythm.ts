import { lstatSync, realpathSync } from 'node:fs';
import { errorMessage, PipelineError } from '../domain/errors.js';
import { fullSuiteMode, loadConfig, type FullSuiteMode } from '../config/load.js';
import { gitProbe, gitRead, gitRoot } from './git-probe.js';
import { RUN_ID, STEP_LABEL, computeNext, readRunState, runStateFile, type NextPlan, type RunState } from './state.js';

/**
 * `run.fullSuite` of the configuration of `repo`; an unreadable configuration falls back on `final`, said in
 * `problem`. Shared by `apv run next` and the rhythm check of `apv gates run`: one computation, one answer.
 */
export function suiteMode(repo: string): { mode: FullSuiteMode; problem: string | null } {
  try { return { mode: fullSuiteMode(loadConfig(repo).config), problem: null }; }
  catch (error) { return { mode: 'final', problem: errorMessage(error).split(/\r?\n/)[0] ?? 'configuration illisible' }; }
}

/**
 * The main checkout of the repository that contains `path`: the first entry of `git worktree list`, where the
 * `apv run` commands write the execution states (an implementer or integrator worktree holds at best a stale
 * copy). The root of `path` itself when Git names no main checkout (bare repository).
 */
export function mainCheckout(path: string): string {
  const root = gitRoot(path);
  const lines = gitRead(root, ['worktree', 'list', '--porcelain'])?.split(/\r?\n/) ?? [];
  const end = lines.indexOf('');
  const block = lines.slice(0, end < 0 ? lines.length : end);
  if (!block[0]?.startsWith('worktree ') || block.includes('bare')) return root;
  try { return realpathSync(block[0].slice('worktree '.length)); } catch { return root; }
}

/**
 * Spec ids a branch may belong to under `/apv:run`: `apv/<id>` or `apv/<id>-<suffixe>` (task, integration, fix
 * branches). Every prefix of what follows `apv/` cut at a hyphen, the longest first, when it is a valid id.
 */
export function branchSpecIds(branch: string): string[] {
  if (!branch.startsWith('apv/')) return [];
  const rest = branch.slice('apv/'.length);
  const ids: string[] = [];
  for (let end = rest.length; end > 0; end = rest.lastIndexOf('-', end - 1)) {
    const id = rest.slice(0, end);
    if (RUN_ID.test(id) && id.length <= 80) ids.push(id);
  }
  return ids;
}

export interface RunContext {
  specId: string;
  /** Main checkout, where the state lives. */
  main: string;
  file: string;
  /** How the execution was found: `--run`, or the current branch. */
  source: 'option' | 'branch';
  branch: string | null;
}

const exists = (file: string): boolean => { try { lstatSync(file); return true; } catch { return false; } };

/**
 * The execution `apv gates run` works for: `explicit` (`--run <id>`), whose state must exist; otherwise the
 * current branch of `repo` (`apv/<id>` or `apv/<id>-<suffixe>`) when the main checkout has the state
 * `.apv/state/run-<id>.json` (the longest id wins). Null outside any execution: detached head, another
 * branch, no state.
 */
export function findRun(repo: string, explicit?: string): RunContext | null {
  const main = mainCheckout(repo);
  if (explicit !== undefined) {
    const file = runStateFile(main, explicit);
    if (!exists(file)) throw new PipelineError('RUN_MISSING', `Aucune exécution ${explicit} : .apv/state/run-${explicit}.json n'existe pas dans le checkout principal ${main}`);
    return { specId: explicit, main, file, source: 'option', branch: gitRead(gitRoot(repo), ['symbolic-ref', '--short', '-q', 'HEAD']) || null };
  }
  const branch = gitRead(gitRoot(repo), ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!branch) return null;
  for (const specId of branchSpecIds(branch)) {
    const file = runStateFile(main, specId);
    if (exists(file)) return { specId, main, file, source: 'branch', branch };
  }
  return null;
}

export interface ExpectedLevel {
  state: RunState;
  plan: NextPlan;
  mode: FullSuiteMode;
  /** Where the execution stands, for a human: `vagues (intégration intermédiaire)`, `corrections`… */
  where: string;
}

/** The level `apv run next` expects at the current step of the execution, computed the same way. */
export function expectedLevel(context: RunContext): ExpectedLevel {
  const state = readRunState(context.file, { shown: `.apv/state/run-${context.specId}.json`, specId: context.specId });
  const { mode } = suiteMode(context.main);
  const plan = computeNext(state, gitProbe(context.main), { fullSuite: mode });
  const where = plan.finished ? 'terminée' : plan.step === 'waves' ? `vagues (vague ${plan.wave}, intégration intermédiaire)` : STEP_LABEL[plan.step!];
  return { state, plan, mode, where };
}
