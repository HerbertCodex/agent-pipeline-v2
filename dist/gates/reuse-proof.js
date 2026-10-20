import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { validateReceipt } from '../domain/contracts.js';
import { errorMessage } from '../domain/errors.js';
import { loadConfigAtCommit } from '../config/load.js';
import { detectReference } from '../reuse/detect.js';
import { runsWebAudit } from '../web/impact.js';
import { resolveReference } from './repeat.js';
import { MANIFEST, RECEIPTS_DIR, RUN_DIR, manifestCommit, readSharedRun, sharedRunIds } from './store.js';
import { DEFAULT_REUSE_MAX_AGE_MS, REUSE_AGE_MARGIN_MS, ignoreDigest, inputsCache, inputsDigest, treesOf } from './reuse.js';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/** Tree state and base of a run, from its summary (null when unknown). */
function summaryOf(text) {
    let dirty = null;
    let baseSha = null;
    if (text === null)
        return { dirty, baseSha };
    try {
        const summary = JSON.parse(text);
        if (typeof summary.dirty === 'boolean')
            dirty = summary.dirty;
        if (typeof summary.baseSha === 'string' && /^[a-f0-9]{40,64}$/.test(summary.baseSha))
            baseSha = summary.baseSha;
    }
    catch { /* No summary: the tree state comes from the receipts or stays unknown, the base stays unknown. */ }
    return { dirty, baseSha };
}
/** Every readable receipt of `.apv/receipts/`, with the tree state from the receipt or, for older ones, its run summary. */
export function readLocal(repo) {
    const root = join(repo, RECEIPTS_DIR);
    const found = [];
    const unreadable = [];
    const runs = new Set();
    if (!existsSync(root))
        return { found, unreadable, runs };
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        runs.add(entry.name);
        const dir = join(root, entry.name);
        let text = null;
        try {
            text = readFileSync(join(dir, 'summary.json'), 'utf8');
        }
        catch { /* Older run without summary. */ }
        const summary = summaryOf(text);
        for (const file of readdirSync(dir)) {
            if (!file.endsWith('.json') || file === 'summary.json')
                continue;
            try {
                const receipt = validateReceipt(JSON.parse(readFileSync(join(dir, file), 'utf8')));
                found.push({ receipt, dirty: receipt.dirty ?? summary.dirty, baseSha: summary.baseSha, source: 'local' });
            }
            catch {
                unreadable.push(join(RECEIPTS_DIR, entry.name, file));
            }
        }
    }
    return { found, unreadable, runs };
}
/**
 * Receipts of the shared store for the runs absent from the worktree (a run present in both is read from the
 * worktree, as before the store existed). A run counts only when intact: its manifest names it and lists exactly
 * its files with their digests, its summary is there, and each receipt belongs to it (same run, same commit as
 * the manifest, file named after its check). Otherwise none of its receipts count, and the run is reported.
 * `keep` says which runs to read from the commit their manifest names (null: no readable manifest, always read).
 */
export function readShared(store, local, keep) {
    const found = [];
    const altered = [];
    for (const runId of sharedRunIds(store)) {
        if (local.has(runId))
            continue;
        // Runs of another commit cannot prove this one: their files are not read (a thousand runs stay cheap). A
        // manifest that names another commit while its receipts claim this one would be refused below anyway.
        if (!keep(manifestCommit(join(store, runId))))
            continue;
        const run = sharedRunReceipts(store, runId);
        if ('reason' in run)
            altered.push({ runId, reason: run.reason });
        else
            found.push(...run.found);
    }
    return { found, altered };
}
/**
 * The receipts of one run of the shared store, when the run is intact: its manifest names it and lists exactly its files
 * with their digests, its summary is there, and each receipt belongs to it (same run, same commit as the manifest, file
 * named after its check). Otherwise the reason, and none of its receipts count.
 */
export function sharedRunReceipts(store, runId) {
    const run = readSharedRun(join(store, runId));
    if (!run.intact)
        return { reason: run.reason };
    const summaryBytes = run.files.get('summary.json');
    if (!summaryBytes)
        return { reason: 'summary.json absent' };
    const summary = summaryOf(summaryBytes.toString('utf8'));
    const found = [];
    for (const [name, bytes] of run.files) {
        if (name === 'summary.json')
            continue;
        let receipt;
        try {
            receipt = validateReceipt(JSON.parse(bytes.toString('utf8')));
        }
        catch {
            return { reason: `${name} n'est pas un reçu valide` };
        }
        if (receipt.runId !== runId || `${receipt.gateId}.json` !== name || receipt.candidateSha !== run.manifest.candidateSha) {
            return { reason: `${name} contredit son exécution (exécution, contrôle ou commit)` };
        }
        found.push({ receipt, dirty: receipt.dirty ?? summary.dirty, baseSha: summary.baseSha, source: 'shared' });
    }
    return { found };
}
/** The later of two receipts: by start, then by run identifier. */
export const latest = (a, b) => b.receipt.startedAt > a.receipt.startedAt || (b.receipt.startedAt === a.receipt.startedAt && b.receipt.runId > a.receipt.runId) ? b : a;
/** The identity of the environment a receipt records for a reuse (5.4): `reuseIdentity`, or `environmentHash` on older ones. */
export const reuseIdentityOf = (receipt) => receipt.reuseIdentity ?? receipt.environmentHash;
/** Whether an argv runs `apv dast` (`dast run`, or `dast` right after the executable of the tool). */
export function runsDast(argv) {
    return argv.some((a, i) => a === 'dast' && (argv[i + 1] === 'run' || /(?:^|[\\/])(?:apv|cli\.m?js)$/.test(argv[i - 1] ?? '')));
}
/** A package manager: its `audit` and `outdated` read the advisories and the versions of the registry, which change with time. */
const PACKAGE_MANAGER = /(?:^|[\\/])(?:npm|pnpm|yarn|bun|cnpm)(?:\.(?:c?js|cmd|exe))?$/;
const NETWORK_SUBCOMMANDS = new Set(['audit', 'outdated']);
/** Tools that read an advisory database or the versions of the registry over the network. */
const NETWORK_TOOL = /(?:^|[\\/])(?:audit-ci|better-npm-audit|osv-scanner|snyk|npm-check-updates|ncu|npm-check)(?:\.(?:c?js|cmd|exe))?$/;
/**
 * Whether an argv runs a dependency audit that reads the network (`npm audit`, `pnpm audit`, `yarn audit`, `yarn npm audit`,
 * `bun audit`, `outdated`, or `audit-ci`, `better-npm-audit`, `osv-scanner`, `snyk`, `npm-check-updates` and `ncu`,
 * `npm-check`): its result changes with the advisory database or the registry, never with the tree alone (relecture
 * sécurité de A1, M3, and of its delta, F-D2).
 */
export function runsNetworkAudit(argv) {
    return argv.some((a, i) => NETWORK_TOOL.test(a) || (PACKAGE_MANAGER.test(a) && argv.slice(i + 1).some(b => NETWORK_SUBCOMMANDS.has(b))));
}
/**
 * Git: the subcommands that read the history, the objects or the references (they differ between two commits of the same
 * tree, or read a commit by its name), or move the copy to another commit. No longer the rule (relecture sécurité du delta de
 * A2, F2-bis: an alias, `git -c alias.h=diff h HEAD~1`, escaped any list of what is refused): only the safety net of the text
 * of a script (TEXT_RULES). What decides is the closed list of what is reused (GIT_REUSABLE).
 */
const GIT = /(?:^|[\\/])git(?:\.exe)?$/;
const GIT_HISTORY = new Set(['log', 'shortlog', 'show', 'rev-list', 'describe', 'reflog', 'whatchanged', 'blame', 'merge-base', 'cherry', 'notes', 'name-rev', 'for-each-ref', 'show-branch',
    'cat-file', 'rev-parse', 'show-ref', 'symbolic-ref', 'ls-tree', 'diff-tree', 'diff-index', 'range-diff', 'format-patch', 'archive', 'bundle', 'fast-export', 'verify-commit',
    'verify-tag', 'branch', 'tag', 'worktree', 'ls-remote', 'fetch', 'pull', 'request-pull', 'replace', 'fsck', 'count-objects', 'stash', 'checkout', 'switch', 'restore', 'reset',
    'bisect', 'cherry-pick', 'revert', 'rebase', 'merge', 'annotate', 'get-tar-commit-id', 'pack-objects']);
/** Global options of git a reused command may carry: none changes what git reads or runs (`-C` and `-c` are judged apart). */
const GIT_SAFE_OPTIONS = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
    '--no-advice', '--version', '-v', '--help', '-h']);
/**
 * Keys of `git -c <key>=<value>` a reused command may carry: display only (colors, pager, quoting of paths, advice), and
 * `core.fsmonitor=false`. Never an alias (`alias.*`: the command it names is not the one written), never a key that runs a
 * program or points git elsewhere (`diff.external`, `core.fsmonitor=<program>`, `core.hooksPath`...): all left out.
 */
const GIT_SAFE_CONFIG = /^(?:color\.[a-z0-9.-]+|core\.pager|core\.quotepath|advice\.[a-z0-9]+)(?:=|$)|^core\.fsmonitor=false$/i;
/** Options of `git grep` that take the next argument as their value (`-e <pattern>`, `-m <n>`...). */
const GREP_OPTION_VALUE = new Set(['-e', '-f', '-m', '--max-count', '-A', '-B', '-C', '--context', '--after-context', '--before-context', '--max-depth', '--threads']);
/** Whether `git grep` names a revision (a positional argument after its pattern, before `--`) or opens a program (`-O`). */
function grepNamesRevision(before) {
    const positional = [];
    let pattern = false;
    for (let i = 0; i < before.length; i++) {
        const a = before[i];
        if (a.startsWith('-O') || a.startsWith('--open-files-in-pager'))
            return true;
        if (GREP_OPTION_VALUE.has(a)) {
            if (a === '-e' || a === '-f')
                pattern = true;
            i += 1;
            continue;
        }
        if (a.startsWith('-')) {
            if (/^(?:-e.|-f.|--regexp=|--file=)/.test(a))
                pattern = true;
            continue;
        }
        positional.push(a);
    }
    return (pattern ? positional : positional.slice(1)).length > 0;
}
/** Arguments of `diff` (and `diff-files`) before `--` that are all options: no revision (a path written without `--` neither, by prudence). */
const optionsOnly = (before) => before.every(a => a.startsWith('-'));
/**
 * The closed list of the subcommands of git a check is reused with (relecture sécurité du delta de A2, F2-bis), each with what
 * its arguments may say (`before`: those before `--`): they read the tree and the working copy only, never the history, an
 * object named by a revision, a reference or the branch. `diff` and `diff-files` with options only before `--` (`diff --check`,
 * `diff --exit-code -- dist`); `grep` without a revision nor `-O`; `status` without the branch nor its upstream (`-b`, `-sb`,
 * `--branch`, `--ahead-behind`) nor the stash; `ls-files` without `--with-tree`; `check-attr` without `--source`;
 * `check-ignore`, `check-ref-format`, `hash-object`, `stripspace`, `version`. Any other subcommand, an alias (global, local
 * or `-c alias.*`) included, is never reused.
 */
const GIT_REUSABLE = new Map([
    ['diff', optionsOnly],
    ['diff-files', optionsOnly],
    ['grep', before => !grepNamesRevision(before)],
    ['status', before => !before.some(a => a === '--branch' || a === '--ahead-behind' || a === '--show-stash' || /^-[A-Za-z]*b[A-Za-z]*$/.test(a))],
    ['ls-files', before => !before.some(a => a.startsWith('--with-tree'))],
    ['check-attr', before => !before.some(a => a.startsWith('--source'))],
    ['check-ignore', () => true],
    ['check-ref-format', () => true],
    ['hash-object', () => true],
    ['stripspace', () => true],
    ['version', () => true],
]);
/** Whether the folder of `git -C <dir>` stays inside the copy: relative, without `..`, not the home folder nor a drive. */
const insideCopy = (dir) => dir !== '' && !/^(?:[\\/~]|[A-Za-z]:)/.test(dir) && !dir.split(/[\\/]/).includes('..');
/**
 * Why one call of git (`args`: what follows `git`) is never reused, or null: a global option outside GIT_SAFE_OPTIONS
 * (`--git-dir`, `--work-tree`, `--exec-path`, `--namespace`, `--config-env`...), `-C` toward a folder outside the copy, `-c`
 * with a key outside GIT_SAFE_CONFIG (an alias first of all); then a subcommand outside GIT_REUSABLE, or one whose arguments
 * name a revision, the branch or a program.
 */
function gitRefusal(args) {
    let j = 0;
    while (j < args.length && args[j].startsWith('-')) {
        const a = args[j];
        const value = args[j + 1] ?? '';
        if (a === '-C') {
            if (!insideCopy(value))
                return `git -C ${value || '(absent)'}, un dossier hors de la copie`;
            j += 2;
            continue;
        }
        if (a === '-c') {
            const key = value.split('=')[0] || '(absent)';
            if (/^alias\./i.test(value))
                return `git -c ${key}, un alias dont la commande n'est pas celle écrite`;
            if (!GIT_SAFE_CONFIG.test(value))
                return `git -c ${key}, un réglage hors de la liste fermée`;
            j += 2;
            continue;
        }
        if (!GIT_SAFE_OPTIONS.has(a))
            return `git ${a.split('=')[0]}, une option globale hors de la liste fermée`;
        j += 1;
    }
    if (j >= args.length)
        return null;
    const sub = args[j];
    const accepts = GIT_REUSABLE.get(sub);
    if (!accepts)
        return `git ${sub}, hors des sous-commandes reprenables (un alias, ou ce qui peut lire l'historique, les objets ou les références)`;
    const rest = args.slice(j + 1);
    const end = rest.indexOf('--');
    return accepts(end < 0 ? rest : rest.slice(0, end)) ? null : `git ${sub} avec une révision, la branche ou un programme`;
}
/**
 * Why an argv runs git in a way that is never reused, or null: gitRefusal on each call of git it holds (F-D2, F2 and F2-bis
 * of the relecture of A2). Only the closed list GIT_REUSABLE is reused: whatever else git does may read the history, an
 * object or a reference, which differ between two commits of the same tree.
 */
export function gitNeverReused(argv) {
    for (let i = 0; i < argv.length; i++) {
        if (!GIT.test(argv[i]))
            continue;
        const refusal = gitRefusal(argv.slice(i + 1));
        if (refusal)
            return refusal;
    }
    return null;
}
/**
 * The same states outside the tree, found in the text of a script (an inline script `node -e`, `sh -c`, or a script of
 * package.json): a network audit, `apv dast`, `apv web audit`, or Git asked for the history, an object or a reference (log,
 * show, rev-parse, cat-file, branch...), which differs between two commits of the same tree. A safety net, never exhaustive: a script file that reads them is not seen,
 * the project declares such a check `reuse: false`.
 */
const TEXT_RULES = [
    [/\b(?:npm|pnpm|yarn|bun|cnpm)\b[^;&|\n]*?\s(?:audit|outdated)(?![\w:.-])/, 'un audit des dépendances qui lit le réseau (npm audit ou équivalent), dont la base d\'avis change avec le temps'],
    [/\b(?:audit-ci|better-npm-audit|osv-scanner|snyk|npm-check-updates|ncu|npm-check)\b/, 'un audit des dépendances qui lit le réseau (npm audit ou équivalent), dont la base d\'avis change avec le temps'],
    [/\bapv\b[^;&|\n]*?\sdast\b/, 'apv dast, qui scanne un état extérieur au dépôt'],
    [/\bapv\b[^;&|\n]*?\sweb\s+audit\b/, 'apv web audit, qui mesure un état extérieur au dépôt'],
    [new RegExp(`\\bgit(?:\\.exe)?['"\`]?[\\s,]*\\[?[\\s'"\`]*(?:${[...GIT_HISTORY].sort((a, b) => b.length - a.length).map(sub => sub.replace(/-/g, '\\-')).join('|')})(?![\\w-])`),
        'git sur l\'historique, les objets ou les références (log, show, rev-parse, cat-file, branch...), qui diffère entre deux commits du même arbre'],
];
const RUN_SUBCOMMANDS = new Set(['run', 'run-script', 'rum', 'urn']);
const LIFECYCLE = new Map([['test', 'test'], ['t', 'test'], ['tst', 'test'], ['start', 'start'], ['stop', 'stop'], ['restart', 'restart']]);
/**
 * Options of the package managers that take the next argument as their value (F-D2): `npm --prefix dir run x`, `pnpm -C dir x`,
 * `pnpm --filter pkg x`, `npm -w pkg run x`. Their value is never the script, nor the subcommand.
 */
const PM_OPTION_VALUE = new Set(['--prefix', '-C', '--dir', '--cwd', '--filter', '-F', '-w', '--workspace', '--loglevel', '--userconfig', '--globalconfig',
    '--registry', '--cache', '--reporter', '--config', '--script-shell']);
const NODE = /(?:^|[\\/])node(?:\.exe)?$/;
/** Depth of the scripts of package.json followed from a command (a script that runs another one...). */
const SCRIPT_DEPTH = 6;
const bodiesOf = (scripts, name) => {
    if (!Object.hasOwn(scripts, name))
        return [];
    const value = scripts[name];
    return typeof value === 'string' ? [value] : value;
};
/**
 * The scripts of package.json an argv runs: through its package manager (`npm run x`, `npm test`, `pnpm x`, `yarn x`, the
 * values of `--prefix`, `-C`, `--filter`, `-w`... skipped), pre and post included; or `node --run x` (F-D2). The name is looked
 * up in every package.json of the commit (a workspace, a prefix: the script of that package is among them).
 */
function scriptsRun(argv, scripts) {
    const names = [];
    const nodeAt = argv.findIndex(a => NODE.test(a));
    if (nodeAt >= 0) {
        for (let i = nodeAt + 1; i < argv.length; i++) {
            const a = argv[i];
            if (a === '--run' && argv[i + 1] !== undefined)
                names.push(argv[i + 1]);
            else if (a.startsWith('--run='))
                names.push(a.slice('--run='.length));
        }
    }
    const at = argv.findIndex(a => PACKAGE_MANAGER.test(a));
    if (at >= 0) {
        const npm = /(?:^|[\\/])npm(?:\.(?:c?js|cmd|exe))?$/.test(argv[at]);
        const rest = [];
        for (let i = at + 1; i < argv.length; i++) {
            const a = argv[i];
            if (PM_OPTION_VALUE.has(a)) {
                i += 1;
                continue;
            }
            if (!a.startsWith('-'))
                rest.push(a);
        }
        let name;
        if (rest[0] !== undefined && RUN_SUBCOMMANDS.has(rest[0]))
            name = rest[1];
        else if (rest[0] !== undefined && LIFECYCLE.has(rest[0]))
            name = LIFECYCLE.get(rest[0]);
        else if (!npm && rest[0] !== undefined && Object.hasOwn(scripts, rest[0]))
            name = rest[0];
        if (name !== undefined)
            names.push(`pre${name}`, name, `post${name}`);
    }
    return [...new Set(names)].filter(n => Object.hasOwn(scripts, n));
}
/** The simple commands of a script text, each as a rough argv (quotes, parentheses, brackets and commas as separators). */
const simpleCommands = (text) => text.split(/&&|\|\||[;|&\n]/)
    .map(part => part.trim().split(/[\s'"`(),[\]]+/).filter(Boolean)).filter(argv => argv.length > 0);
/**
 * Why the commands of a check read a state outside the tree, through their argv, the inline scripts they carry (an argument
 * with a space or a shell operator: `sh -c "npm run x"`, `node -e "..."`) or the scripts of package.json they run (`scripts`,
 * read at the commit judged), or null.
 */
function externalState(argvs, scripts) {
    const seen = new Set();
    const visit = (argv, via, depth) => {
        const where = via ? ` (par le script npm « ${via} »)` : '';
        if (runsNetworkAudit(argv))
            return `il lance un audit des dépendances qui lit le réseau (npm audit ou équivalent)${where}, dont la base d'avis change avec le temps`;
        const git = gitNeverReused(argv);
        if (git)
            return `il lance ${git}${where}`;
        if (via && runsWebAudit(argv))
            return `il lance apv web audit${where}, qui mesure un état extérieur au dépôt`;
        if (via && runsDast(argv))
            return `il lance apv dast${where}, qui scanne un état extérieur au dépôt`;
        const text = argv.join(' ');
        for (const [rule, what] of TEXT_RULES)
            if (rule.test(text))
                return `il lance ${what}${where}`;
        if (depth >= SCRIPT_DEPTH)
            return null;
        // An inline script (an argument that holds a command line): its simple commands, and the scripts they run (F-D2).
        for (const arg of argv) {
            if (!/[\s;&|]/.test(arg))
                continue;
            for (const sub of simpleCommands(arg)) {
                const found = visit(sub, via, depth + 1);
                if (found)
                    return found;
            }
        }
        for (const name of scriptsRun(argv, scripts)) {
            if (seen.has(name))
                continue;
            seen.add(name);
            for (const body of bodiesOf(scripts, name)) {
                for (const sub of simpleCommands(body)) {
                    const found = visit(sub, name, depth + 1);
                    if (found)
                        return found;
                }
            }
        }
        return null;
    };
    for (const argv of argvs) {
        const found = visit(argv, null, 0);
        if (found)
            return found;
    }
    return null;
}
/**
 * Why a check is never reused, whatever its receipts say (docs/ACCELERATION-LOTS.md, 5.2 A3), or null: declared
 * `reuse: false` by the project, or a command that runs `apv web audit` or `apv dast` (they measure a state outside the
 * repository: the preview served, the network, the time), or a command (or its relaunch) that reads the commit itself
 * through `{{candidateSha}}`: two commits of the same tree are still two commits for it. Also, directly, in an inline
 * script or in a script of package.json it runs (`scripts`, read at the commit): a dependency audit that reads the network
 * (`npm audit` and equivalents), `apv dast`, `apv web audit`, Git asked for the history (externalState, a safety net).
 */
export function neverReused(gate, scripts = {}) {
    if (gate.reuse === false)
        return 'reuse: false, le projet le déclare toujours rejoué';
    if (runsWebAudit(gate.command))
        return 'il lance apv web audit, qui mesure un état extérieur au dépôt';
    if (runsDast(gate.command))
        return 'il lance apv dast, qui scanne un état extérieur au dépôt';
    if (commandsOf(gate).some(a => a.includes('{{candidateSha}}')))
        return 'sa commande lit le commit lui-même ({{candidateSha}}), pas seulement son arbre';
    return externalState([gate.command, ...(gate.retryFailed ? [gate.retryFailed.command] : [])], scripts);
}
/** Most package.json files of a commit whose scripts are read, and largest one (beyond, it is left out: said by the root alone). */
const MAX_PACKAGES = 200;
const MAX_PACKAGE_BYTES = 1024 * 1024;
/**
 * The scripts of every package.json of the tree of `commit` (the root first, then each workspace or sub-package, at most
 * MAX_PACKAGES), only the string ones, by name; none when absent or unreadable. A command that runs a script of another
 * package (`npm --prefix dir`, `pnpm -C dir`, `--filter`, `-w`) finds it among them (F-D2).
 */
export async function projectScripts(git, repo, commit) {
    if (!SHA.test(commit))
        return {};
    let listed;
    try {
        listed = (await git.exec(repo, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', '--end-of-options', `${commit}^{tree}`])).split('\0')
            .filter(p => p === 'package.json' || p.endsWith('/package.json'));
    }
    catch {
        listed = ['package.json'];
    }
    const files = [...new Set(['package.json', ...listed.sort()])].filter(p => listed.includes(p)).slice(0, MAX_PACKAGES);
    const scripts = {};
    for (const file of files) {
        let text;
        try {
            text = await git.exec(repo, ['cat-file', 'blob', `${commit}:${file}`]);
        }
        catch {
            continue;
        }
        if (text.length > MAX_PACKAGE_BYTES)
            continue;
        try {
            const value = JSON.parse(text);
            if (!value || typeof value !== 'object' || !value.scripts || typeof value.scripts !== 'object' || Array.isArray(value.scripts))
                continue;
            for (const [name, body] of Object.entries(value.scripts)) {
                if (typeof body !== 'string' || name.length > 200)
                    continue;
                if (!Object.hasOwn(scripts, name))
                    Object.defineProperty(scripts, name, { value: [], enumerable: true, writable: true, configurable: true });
                scripts[name].push(body.slice(0, 20_000));
            }
        }
        catch { /* Not JSON: no script. */ }
    }
    return scripts;
}
const commandsOf = (gate) => [...gate.command, ...(gate.retryFailed?.command ?? [])];
/** Whether the commands of a check read the base of their run (`{{baseSha}}`): its result then depends on that base too. */
export const readsBase = (gate) => commandsOf(gate).some(a => a.includes('{{baseSha}}'));
/** `reuse` of a check as an object (A2), or null (`false`, absent). */
export const reuseSettingsOf = (gate) => gate && typeof gate.reuse === 'object' ? gate.reuse : null;
export function reuseContext(input) {
    return { ...input, scans: new Map(), inputs: inputsCache() };
}
/** The cache of the trees of a context (created on first use for a context built by hand). */
const cacheOf = (ctx) => (ctx.inputs ??= inputsCache());
/**
 * Why a receipt `cached` by inputs (`basis: inputs`) never proves anything (decision of the project lead, 18 October, evening,
 * bis: M1 of the delta review of A2). `reuse.ignore` is a declaration nothing proves: wrong already at the base (a merged PR made
 * the check read a file it declares ignored), it would make a false proof. `apv gates run` never writes one, `verify` refuses
 * it, until a PR A2b proves the declaration (the check replayed in a copy without its ignored files, its receipt required).
 */
export const INPUTS_REUSE_DISABLED = 'reprise par entrées désactivée tant que la déclaration reuse.ignore n\'est pas prouvée (seule la reprise à arbre identique vaut)';
/** The scripts of the package.json files of the commit judged, read once per context. */
function scriptsOf(ctx) {
    ctx.scripts ??= projectScripts(ctx.git, ctx.repo, ctx.commit);
    return ctx.scripts;
}
/** The merge base of the commit with its target (ReuseContext.reference) and the configuration there, once per context. */
export function reuseBase(ctx) {
    ctx.base ??= (async () => {
        const name = ctx.reference ?? detectReference(ctx.repo);
        if (!name)
            return { reason: 'aucune cible pour lire la déclaration à la base (ni --against, ni --base, ni branche distante par défaut)' };
        const resolved = await resolveReference(ctx.git, ctx.repo, name);
        if (!resolved.sha)
            return { reason: `cible ${name} ${resolved.reason}` };
        let mergeBase = '';
        try {
            mergeBase = (await ctx.git.exec(ctx.repo, ['merge-base', resolved.sha, ctx.commit])).trim();
        }
        catch { /* No common history. */ }
        if (!SHA.test(mergeBase))
            return { reason: `aucune base commune entre ${name} et ${ctx.commit.slice(0, 12)}` };
        try {
            const loaded = loadConfigAtCommit(ctx.repo, mergeBase);
            return { mergeBase, reference: name, config: loaded.file ? loaded.config : null };
        }
        catch (error) {
            return { reason: `configuration illisible à la base ${mergeBase.slice(0, 12)} : ${errorMessage(error)}` };
        }
    })();
    return ctx.base;
}
/**
 * The oldest origin a check reuses (5.5.1: `reuse.maxAgeMs` read at the base): 24 h, or less when the check declares less;
 * more only when the check declares it both at the base and in the configuration judged (the smaller of the two).
 */
export async function maxAgeOf(ctx, gate) {
    const current = reuseSettingsOf(gate)?.maxAgeMs;
    if (current === undefined)
        return DEFAULT_REUSE_MAX_AGE_MS;
    const base = await reuseBase(ctx);
    const atBase = 'reason' in base || !gate?.id ? undefined : reuseSettingsOf(base.config?.gates.find(g => g.id === gate.id))?.maxAgeMs;
    return Math.min(current, atBase ?? DEFAULT_REUSE_MAX_AGE_MS);
}
/** Trees of the merge bases of `base` and `commit` (`git merge-base --all`), sorted; none when they have none or Git fails. */
async function forkTrees(ctx, base, commit) {
    let out;
    try {
        out = await ctx.git.exec(ctx.repo, ['merge-base', '--all', base, commit]);
    }
    catch {
        return [];
    }
    const forks = out.split('\n').map(line => line.trim()).filter(line => SHA.test(line));
    const trees = await treesOf(ctx.git, ctx.repo, forks);
    return [...new Set(forks.map(f => trees.get(f)).filter((t) => t !== undefined))].sort();
}
/** Receipt files of a run directory of the store (summary and manifest left out); none when it cannot be listed. */
function receiptFiles(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json') && e.name !== 'summary.json' && e.name !== MANIFEST).map(e => e.name);
    }
    catch {
        return [];
    }
}
/** The commit a receipt file claims (`candidateSha`), read whatever its run says; null when it is not readable as such. */
function claimedCommit(path) {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return typeof value.candidateSha === 'string' && SHA.test(value.candidateSha) ? value.candidateSha : null;
    }
    catch {
        return null;
    }
}
/**
 * The runs of the shared store that may hold a receipt of `tree`. Every run absent from the worktree is looked at: its
 * manifest names a commit (absent or unreadable: blocked, its commit is unknown), and the receipts it holds are read for
 * the commit each one claims, whatever the manifest says. A run whose manifest names a commit of this tree, or one of whose
 * receipts claims a commit of this tree, while the two disagree, blocks: a failure of this tree could hide there behind a
 * manifest of another commit (decision of the project lead, 18 October: the A0 limit closed). A run of this tree is then
 * read in full and must be intact (digests of its manifest), or it blocks too. A disagreement between two other trees
 * cannot hide a failure of this one: not read further.
 */
async function scanTree(ctx, tree) {
    const started = performance.now();
    const commits = new Set(ctx.local.found.map(f => f.receipt.candidateSha));
    const runs = [];
    let files = 0;
    const result = (block, found = [], trees = new Map()) => ({ tree, found, trees, block, runs: runs.length, files, ms: Math.round(performance.now() - started) });
    for (const runId of sharedRunIds(ctx.store)) {
        if (ctx.local.runs.has(runId))
            continue;
        const dir = join(ctx.store, runId);
        const named = manifestCommit(dir);
        if (!named)
            return result(`exécution ${runId} du magasin partagé au manifeste absent ou illisible : son commit est inconnu, un échec plus récent sur le même arbre ne peut pas être exclu`);
        commits.add(named);
        const claimed = new Set();
        for (const name of receiptFiles(dir)) {
            files += 1;
            const sha = claimedCommit(join(dir, name));
            if (sha) {
                claimed.add(sha);
                commits.add(sha);
            }
        }
        runs.push({ runId, named, claimed });
    }
    const trees = await treesOf(ctx.git, ctx.repo, commits);
    const found = [...ctx.local.found];
    for (const run of runs) {
        const ofTree = trees.get(run.named) === tree;
        const hidden = [...run.claimed].find(c => c !== run.named && (ofTree || trees.get(c) === tree));
        if (hidden) {
            return result(`exécution ${run.runId} du magasin partagé : son manifeste nomme le commit ${run.named.slice(0, 12)}, un de ses reçus le commit ${hidden.slice(0, 12)} ; ` +
                'un reçu de cet arbre peut s\'y cacher, un échec plus récent sur le même arbre ne peut pas être exclu');
        }
        if (!ofTree)
            continue;
        const read = sharedRunReceipts(ctx.store, run.runId);
        if ('reason' in read)
            return result(`exécution ${run.runId} du même arbre altérée dans le magasin partagé : un échec plus récent ne peut pas être exclu`);
        found.push(...read.found);
    }
    return result(null, found, trees);
}
/** The scan of the store for `tree`, made once per context. */
export function treeScan(ctx, tree) {
    if (!ctx.scans.has(tree))
        ctx.scans.set(tree, scanTree(ctx, tree));
    return ctx.scans.get(tree);
}
const hours = (ms) => String(Math.round(ms / 360_000) / 10);
const FAILING = (status) => !['passed', 'cached', 'not_required'].includes(status);
/** The reason `verify` and `apv gates run` give for a proven reuse. */
export const reuseReason = (proof) => proof.basis === 'tree' ? 'arbre identique' : `entrées identiques : ${proof.changed} fichier(s) changé(s), tous ignorés par ce contrôle`;
/**
 * Whether a receipt `cached` proves its check at `ctx.commit` (docs/ACCELERATION-LOTS.md, 5.5). Nothing of it is trusted:
 * the check must not be one that is never reused (`gate`, from the configuration judged); its origin is read again (the
 * worktree when it has the run, else the run of the shared store, intact), must be the same check, `passed` at first pass
 * (never `cached`: no chain), complete, on a clean tree, of the current configuration, of the same reuse identity of the
 * environment, younger than the maximum age (`reuse.maxAgeMs` read at the base, maxAgeOf), with the same output digests,
 * without a record of `apv web audit`; a command that reads `{{baseSha}}` needs the same base and a merge base of the same
 * tree on both sides. Only `basis: tree` proves anything: the trees of both commits are recomputed and so is the digest of
 * the inputs; the store is scanned for the tree (TreeScan); no receipt of the check later than the origin on the same tree
 * failed: complete, targeted or of one of its early checks. A receipt `basis: inputs` is refused whatever it says
 * (INPUTS_REUSE_DISABLED). The environment compared includes the local state of the copy (localStateDigest, copyStateDigest).
 * Returns the proof, or why the receipt proves nothing.
 */
export async function checkReuse(ctx, gate, cached) {
    const r = cached.receipt;
    const reuse = r.reuse;
    const refuse = (reason) => ({ reason });
    if (!reuse)
        return refuse('reçu sans relevé reuse (exécution, commit et empreintes de l\'origine) : rien à vérifier');
    if (reuse.basis !== 'tree')
        return refuse(INPUTS_REUSE_DISABLED);
    if (r.targeted === true)
        return refuse('un reçu réutilisé n\'est jamais ciblé');
    const never = gate ? neverReused(gate, await scriptsOf(ctx)) : null;
    if (never)
        return refuse(`contrôle jamais repris (${never})`);
    let origin;
    if (ctx.local.runs.has(reuse.fromRun)) {
        origin = ctx.local.found.find(f => f.receipt.runId === reuse.fromRun && f.receipt.id === r.reusedFrom);
        if (!origin)
            return refuse(`reçu d'origine ${r.reusedFrom} absent de l'exécution ${reuse.fromRun} du worktree`);
    }
    else {
        if (!RUN_DIR.test(reuse.fromRun) || !existsSync(join(ctx.store, reuse.fromRun))) {
            return refuse(`exécution d'origine ${reuse.fromRun} absente du worktree et du magasin partagé (retirée par la rétention ?)`);
        }
        const run = sharedRunReceipts(ctx.store, reuse.fromRun);
        if ('reason' in run)
            return refuse(`exécution d'origine ${reuse.fromRun} refusée, altérée dans le magasin partagé : ${run.reason}`);
        origin = run.found.find(f => f.receipt.id === r.reusedFrom);
        if (!origin)
            return refuse(`reçu d'origine ${r.reusedFrom} absent de l'exécution ${reuse.fromRun} du magasin partagé`);
    }
    const from = origin;
    const o = from.receipt;
    if (o.gateId !== r.gateId)
        return refuse(`reçu d'origine d'un autre contrôle (${o.gateId})`);
    if (o.candidateSha !== reuse.fromCommit)
        return refuse(`reçu d'origine au commit ${o.candidateSha.slice(0, 12)}, pas au commit déclaré ${reuse.fromCommit.slice(0, 12)}`);
    if (o.status !== 'passed')
        return refuse(`origine ${o.status} : seul un reçu exécuté et réussi au premier passage se réutilise`);
    if (o.early || o.targeted === true)
        return refuse('origine ciblée (affected ou contrôle tôt) : jamais la preuve du contrôle entier');
    if (from.dirty !== false)
        return refuse(from.dirty ? 'origine écrite sur un arbre modifié' : 'origine d\'état d\'arbre inconnu');
    if (o.configHash !== ctx.configHash)
        return refuse('origine écrite pour une autre configuration des contrôles');
    if (o.startedAt > r.startedAt || o.startedAt > ctx.now)
        return refuse('origine datée après sa reprise ou dans le futur');
    const maxAge = await maxAgeOf(ctx, gate);
    if (ctx.now - o.startedAt > maxAge) {
        return refuse(`origine trop vieille (${hours(ctx.now - o.startedAt)} h, au plus ${hours(maxAge)} h) : l'âge ne se renouvelle jamais par une reprise`);
    }
    if (r.stdoutHash !== o.stdoutHash || r.stderrHash !== o.stderrHash)
        return refuse('empreintes de sortie différentes de celles de l\'origine');
    if (reuse.environment !== reuseIdentityOf(o))
        return refuse('identité d\'environnement différente de celle de l\'origine');
    if (o.web)
        return refuse('origine qui porte un relevé de apv web audit : jamais reprise, l\'audit mesure un état extérieur au dépôt');
    // A command that reads the base of its run ({{baseSha}}) proves something about that base too: the same base, or nothing.
    if (gate && readsBase(gate) && (from.baseSha === null || cached.baseSha !== from.baseSha)) {
        return refuse(`commande qui lit la base de son exécution ({{baseSha}}) : base ${cached.baseSha?.slice(0, 12) ?? 'inconnue'} à la reprise, ${from.baseSha?.slice(0, 12) ?? 'inconnue'} à l'origine`);
    }
    // The same base is not enough (relecture sécurité de A1, F1): the tools that read it (apv tests check, apv reuse check, a
    // diff since the fork) compare from the merge base of the base and the commit, which must have the same tree on both sides.
    if (gate && readsBase(gate)) {
        const [atOrigin, here] = await Promise.all([forkTrees(ctx, from.baseSha, reuse.fromCommit), forkTrees(ctx, from.baseSha, ctx.commit)]);
        if (!atOrigin.length || !here.length || atOrigin.join(',') !== here.join(',')) {
            return refuse(`commande qui lit la base de son exécution ({{baseSha}}) : la base commune (merge-base) de ${from.baseSha.slice(0, 12)} avec ce commit ` +
                `${here.length && atOrigin.length ? 'n\'a pas l\'arbre de celle avec l\'origine' : 'est introuvable'} ; ce que le contrôle compare depuis elle a changé`);
        }
    }
    const known = await treesOf(ctx.git, ctx.repo, [reuse.fromCommit, ctx.commit]);
    const tree = known.get(ctx.commit);
    const fromTree = known.get(reuse.fromCommit);
    if (!fromTree || !tree)
        return refuse(`commit d'origine ${reuse.fromCommit.slice(0, 12)} introuvable dans le dépôt`);
    if (fromTree !== tree)
        return refuse(`arbre de ${reuse.fromCommit.slice(0, 12)} différent de celui de ${ctx.commit.slice(0, 12)} (basis tree)`);
    if (reuse.changed !== 0 || reuse.files.length)
        return refuse('reprise à arbre identique qui déclare des fichiers changés');
    if (reuse.ignoreDigest !== ignoreDigest([]))
        return refuse('reprise à arbre identique qui déclare des fichiers ignorés');
    if (reuse.inputsDigest !== (await inputsDigest(ctx.git, ctx.repo, ctx.commit, cacheOf(ctx))).digest)
        return refuse('empreinte des entrées différente de celle recalculée au commit');
    // A later failure on the same tree wins, as in `verify`: receipts of the worktree (every commit) and of the runs of the
    // store that may hold one of this tree (TreeScan: a run that cannot be read, or whose manifest contradicts it, blocks).
    const scan = await treeScan(ctx, tree);
    if (scan.block)
        return refuse(scan.block);
    // A targeted receipt (its `affected` command) or one of its early checks (`early.gate`) that failed counts too (relecture
    // sécurité de A1, M1): it ran part of the check on this very tree, and failed; never proof of a pass, always of a failure.
    const later = scan.found.filter(f => (f.receipt.gateId === r.gateId || f.receipt.early?.gate === r.gateId) && f.dirty === false
        && f.receipt.configHash === ctx.configHash && scan.trees.get(f.receipt.candidateSha) === tree && f.receipt !== o && latest(from, f) === f
        && FAILING(f.receipt.status));
    if (later.length) {
        const fail = later.reduce(latest).receipt;
        const kind = fail.early ? `, contrôle tôt ${fail.gateId}` : fail.targeted === true ? ', ciblé' : '';
        return refuse(`échec plus récent sur le même arbre : ${fail.runId}/${fail.gateId}.json (${fail.status}${fail.status === 'passed_after_retry' ? ', test instable' : ''}${kind}) l'emporte`);
    }
    return { origin: from, basis: 'tree', changed: 0, scan };
}
/** The names of the parts that differ between two records of identity parts, as said to the operator (at most 10 variables named). */
export function partsDiffer(a, b) {
    const names = [...new Set([...Object.keys(a.env), ...Object.keys(b.env)])].sort().filter(n => a.env[n] !== b.env[n]);
    return [...(names.length ? [`variable(s) ${names.slice(0, 10).join(', ')}${names.length > 10 ? ` et ${names.length - 10} autre(s)` : ''}`] : []),
        ...(a.executable !== b.executable ? ['exécutable de la commande'] : []), ...(a.local !== b.local ? ['dépendances installées ou fichiers .env* de la copie'] : []),
        ...(a.copy !== b.copy ? ['fichiers ignorés par Git de la copie (fichiers générés, sorties de build)'] : []),
        ...(a.system !== b.system ? ['système (Node, noyau, version de l\'outil)'] : []), ...(a.stack !== b.stack ? ['pile (déclaration, empreinte ou variables)'] : [])];
}
/**
 * The origin `apv gates run` may reuse for `gate` at `ctx.commit` (docs/ACCELERATION-LOTS.md, A1), or why none: the latest
 * receipt of the check on an identical tree (worktree, then shared store, intact), at the same configuration, in one of the
 * environments the check would run in now (`environments`: its variables, executable, stack, compared by their reuse
 * identity), `passed` at first pass, clean, complete, younger than the maximum age minus REUSE_AGE_MARGIN_MS, without a
 * record of `apv web audit`. Never by inputs (INPUTS_REUSE_DISABLED), whatever `reuse.ignore` says. The receipt about to be
 * written is checked by `checkReuse`, the very check `apv gates verify` runs: a receipt it would refuse is never written.
 * `candidate`: false when no receipt was even considered (nothing to say).
 */
export async function findOrigin(ctx, gate, environments, base) {
    const never = neverReused(gate, await scriptsOf(ctx));
    if (never)
        return { reason: `jamais repris : ${never}`, candidate: false };
    const tree = (await treesOf(ctx.git, ctx.repo, [ctx.commit])).get(ctx.commit);
    if (!tree)
        return { reason: `arbre du commit ${ctx.commit.slice(0, 12)} illisible`, candidate: false };
    const scan = await treeScan(ctx, tree);
    const limit = (await maxAgeOf(ctx, gate)) - REUSE_AGE_MARGIN_MS;
    const byIdentity = new Map(environments.map(e => [e.identity, e]));
    const identities = new Set(byIdentity.keys());
    // A check that declares reuse.ignore is always told why it is not reused by inputs (INPUTS_REUSE_DISABLED): at an identical tree only.
    const declares = (reuseSettingsOf(gate)?.ignore?.length ?? 0) > 0;
    const why = (reason, candidate) => (declares ? { reason: `${reason} ; ${INPUTS_REUSE_DISABLED}`, candidate: true } : { reason, candidate });
    if (scan.block)
        return why(scan.block, true);
    const sameTree = scan.found.filter(f => f.receipt.gateId === gate.id && f.receipt.status === 'passed' && !f.receipt.early && f.receipt.targeted !== true
        && f.dirty === false && f.receipt.configHash === ctx.configHash && scan.trees.get(f.receipt.candidateSha) === tree && !f.receipt.web);
    if (!sameTree.length)
        return why('aucun reçu réussi au premier passage sur un arbre identique avec cette configuration', false);
    const young = sameTree.filter(f => f.receipt.startedAt <= ctx.now && ctx.now - f.receipt.startedAt <= limit);
    const sameEnv = young.filter(f => identities.has(reuseIdentityOf(f.receipt)));
    const sameBase = readsBase(gate) ? sameEnv.filter(f => f.baseSha !== null && f.baseSha === base) : sameEnv;
    if (!young.length)
        return why(`reçu(s) réussi(s) sur un arbre identique, mais de plus de ${hours(limit)} h (la reprise doit rester vérifiable ${hours(REUSE_AGE_MARGIN_MS)} h)`, true);
    if (!sameEnv.length) {
        // What differs from the latest of them, when both sides recorded their parts (docs/UNE-SUITE-PAR-PR.md, 2.3).
        const closest = young.reduce(latest).receipt;
        const differ = closest.identityParts ? environments.flatMap(e => e.parts ? [partsDiffer(e.parts, closest.identityParts)] : [])[0] : undefined;
        const said = differ?.length ? ` ; différent de ${closest.runId} (${closest.candidateSha.slice(0, 12)}) : ${differ.join(' ; ')}` : '';
        return why(`reçu(s) réussi(s) sur un arbre identique, mais dans un autre environnement (variables transmises, exécutable, pile, Node, système, version de l'outil, ou état local ignoré par Git : node_modules, fichiers générés, fichiers .env*, worktrees et sous-modules de la copie)${said}`, true);
    }
    if (!sameBase.length)
        return why(`reçu(s) réussi(s) sur un arbre identique, mais depuis une autre base ({{baseSha}} dans la commande : ${base?.slice(0, 12) ?? 'aucune'} ici)`, true);
    const origin = sameBase.reduce(latest);
    const reuse = { fromRun: origin.receipt.runId, fromCommit: origin.receipt.candidateSha, basis: 'tree',
        inputsDigest: (await inputsDigest(ctx.git, ctx.repo, ctx.commit, cacheOf(ctx))).digest, ignoreDigest: ignoreDigest([]), environment: reuseIdentityOf(origin.receipt),
        changed: 0, files: [] };
    // The receipt about to be written is checked as `apv gates verify` will check it.
    const probe = { receipt: { ...origin.receipt, candidateSha: ctx.commit, status: 'cached', reusedFrom: origin.receipt.id, startedAt: ctx.now, durationMs: 0, reuse },
        dirty: false, baseSha: base, source: 'local' };
    const checked = await checkReuse(ctx, gate, probe);
    if ('reason' in checked)
        return why(checked.reason, true);
    const identity = reuseIdentityOf(origin.receipt);
    return { origin, reuse, stack: byIdentity.get(identity).stack, identity, changed: 0 };
}
//# sourceMappingURL=reuse-proof.js.map