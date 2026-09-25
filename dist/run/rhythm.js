import { lstatSync, realpathSync } from 'node:fs';
import { errorMessage, PipelineError } from '../domain/errors.js';
import { fullSuiteMode, loadConfig } from '../config/load.js';
import { gitProbe, gitRead, gitRoot } from './git-probe.js';
import { RUN_ID, STEP_LABEL, computeNext, readRunState, runStateFile } from './state.js';
const exists = (file) => { try {
    lstatSync(file);
    return true;
}
catch {
    return false;
} };
/**
 * `run.fullSuite` of the configuration of `repo`; an unreadable configuration falls back on `final`, said in
 * `problem`. Shared by `apv run next` and the rhythm check of `apv gates run`: one computation, one answer.
 */
export function suiteMode(repo) {
    try {
        return { mode: fullSuiteMode(loadConfig(repo).config), problem: null };
    }
    catch (error) {
        return { mode: 'final', problem: errorMessage(error).split(/\r?\n/)[0] ?? 'configuration illisible' };
    }
}
/**
 * The checkouts of the repository that contains `path`, the main one first (bare entries left out). The root of
 * `path` alone when Git lists none.
 */
export function listWorktrees(path) {
    const root = gitRoot(path);
    const text = gitRead(root, ['worktree', 'list', '--porcelain']) ?? '';
    const found = [];
    text.split(/\r?\n\r?\n/).forEach((block, index) => {
        const lines = block.split(/\r?\n/);
        if (!lines[0]?.startsWith('worktree ') || lines.includes('bare'))
            return;
        let dir = lines[0].slice('worktree '.length);
        try {
            dir = realpathSync(dir);
        }
        catch {
            return;
        } // pruned or unreachable: no state to read there
        const ref = lines.find(l => l.startsWith('branch '))?.slice('branch '.length) ?? null;
        found.push({ path: dir, branch: ref ? ref.replace(/^refs\/heads\//, '') : null, main: index === 0 });
    });
    return found.length ? found : [{ path: root, branch: gitRead(root, ['symbolic-ref', '--short', '-q', 'HEAD']) || null, main: true }];
}
/**
 * The main checkout of the repository that contains `path`: the first entry of `git worktree list`. The root of
 * `path` itself when Git names no main checkout (bare repository).
 */
export function mainCheckout(path) {
    const first = listWorktrees(path)[0];
    return first.main ? first.path : gitRoot(path);
}
/**
 * The checkout that holds the state `.apv/state/run-<specId>.json` of an execution, looked for in every worktree of
 * the repository that contains `repo`: executions run side by side, each from its own checkout (the one on
 * `apv/<id>` where `apv run start` wrote the state), and a task or integration worktree may hold a stale copy
 * that came with a commit. One copy: its checkout. Several: the checkout on `apv/<specId>`, else the main
 * checkout, else refused (`RUN_AMBIGUOUS`, every location listed). Null when no checkout has it.
 */
export function locateRunState(repo, specId) {
    const holders = listWorktrees(repo).filter(w => exists(runStateFile(w.path, specId)));
    if (holders.length <= 1)
        return holders[0] ?? null;
    const own = holders.filter(w => w.branch === `apv/${specId}`);
    if (own.length === 1)
        return own[0];
    const main = holders.find(w => w.main);
    if (own.length === 0 && main)
        return main;
    throw new PipelineError('RUN_AMBIGUOUS', `Exécution ${specId} : plusieurs états .apv/state/run-${specId}.json, aucun dans un checkout sur apv/${specId} ni dans le checkout principal : ` +
        `${holders.map(w => `${w.path} (${w.branch ?? 'tête détachée'})`).join(', ')}. ` +
        `Retire les copies périmées (état versionné venu avec un commit), ou lance apv run depuis le checkout de l'exécution (--repo <chemin>).`);
}
/**
 * Spec ids a branch may belong to under `/apv:run`: `apv/<id>` or `apv/<id>-<suffixe>` (task, integration, fix
 * branches). Every prefix of what follows `apv/` cut at a hyphen, the longest first, when it is a valid id.
 */
export function branchSpecIds(branch) {
    if (!branch.startsWith('apv/'))
        return [];
    const rest = branch.slice('apv/'.length);
    const ids = [];
    for (let end = rest.length; end > 0; end = rest.lastIndexOf('-', end - 1)) {
        const id = rest.slice(0, end);
        if (RUN_ID.test(id) && id.length <= 80)
            ids.push(id);
    }
    return ids;
}
/**
 * The execution `apv gates run` works for: `explicit` (`--run <id>`), whose state must exist; otherwise the
 * current branch of `repo` (`apv/<id>` or `apv/<id>-<suffixe>`) when a checkout of the repository has the state
 * `.apv/state/run-<id>.json` (the longest id wins). The state is looked for in every worktree (`locateRunState`).
 * Null outside any execution: detached head, another branch, no state.
 */
export function findRun(repo, explicit) {
    const branch = gitRead(gitRoot(repo), ['symbolic-ref', '--short', '-q', 'HEAD']) || null;
    if (explicit !== undefined) {
        const holder = locateRunState(repo, explicit);
        if (!holder)
            throw new PipelineError('RUN_MISSING', `Aucune exécution ${explicit} : .apv/state/run-${explicit}.json n'existe dans aucun worktree du dépôt (git worktree list)`);
        return { specId: explicit, checkout: holder.path, file: runStateFile(holder.path, explicit), source: 'option', branch };
    }
    if (!branch)
        return null;
    for (const specId of branchSpecIds(branch)) {
        const holder = locateRunState(repo, specId);
        if (holder)
            return { specId, checkout: holder.path, file: runStateFile(holder.path, specId), source: 'branch', branch };
    }
    return null;
}
/** The level `apv run next` expects at the current step of the execution, computed the same way. */
export function expectedLevel(context) {
    const state = readRunState(context.file, { shown: `.apv/state/run-${context.specId}.json`, specId: context.specId });
    const { mode } = suiteMode(context.checkout);
    const plan = computeNext(state, gitProbe(context.checkout), { fullSuite: mode });
    const where = plan.finished ? 'terminée' : plan.step === 'waves' ? `vagues (vague ${plan.wave}, intégration intermédiaire)` : STEP_LABEL[plan.step];
    return { state, plan, mode, where };
}
//# sourceMappingURL=rhythm.js.map