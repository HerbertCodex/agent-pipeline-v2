import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MAX_SCOPE_FILES, validateReceipt } from '../domain/contracts.js';
import { errorMessage } from '../domain/errors.js';
import { CONFIG_FILE, LEGACY_CONFIG_FILE, loadConfigAtCommit } from '../config/load.js';
import { designDir } from '../design/config.js';
import { detectReference } from '../reuse/detect.js';
import { runsWebAudit } from '../web/impact.js';
import { commandPaths } from './proof-scope.js';
import { resolveReference } from './repeat.js';
import { MANIFEST, RECEIPTS_DIR, RUN_DIR, manifestCommit, readSharedRun, sharedRunIds } from './store.js';
import { DEFAULT_REUSE_MAX_AGE_MS, NEVER_IGNORED, REUSE_AGE_MARGIN_MS, compareInputs, ignoreDigest, inputsDigest, treesOf } from './reuse.js';
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
/** Git: the subcommands that read the history (they differ between two commits of the same tree). */
const GIT = /(?:^|[\\/])git(?:\.exe)?$/;
const GIT_HISTORY = new Set(['log', 'shortlog', 'show', 'rev-list', 'describe', 'reflog', 'whatchanged', 'blame', 'merge-base', 'cherry', 'notes', 'name-rev', 'for-each-ref', 'show-branch']);
/** Global options of git that take the next argument as their value (`git -C dir log`, `git -c k=v log`). */
const GIT_OPTION_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path', '--list-cmds', '--attr-source']);
/**
 * Whether an argv asks git for the history: the first argument after `git` that is not one of its global options
 * (`--no-pager`, `-P`, `--bare`, `-C <dir>`, `-c <k=v>`, `--git-dir <dir>`...) is a subcommand of GIT_HISTORY (F-D2).
 */
export function runsGitHistory(argv) {
    for (let i = 0; i < argv.length; i++) {
        if (!GIT.test(argv[i]))
            continue;
        let j = i + 1;
        while (j < argv.length && argv[j].startsWith('-'))
            j += GIT_OPTION_VALUE.has(argv[j]) ? 2 : 1;
        if (j < argv.length && GIT_HISTORY.has(argv[j]))
            return true;
    }
    return false;
}
/**
 * The same states outside the tree, found in the text of a script (an inline script `node -e`, `sh -c`, or a script of
 * package.json): a network audit, `apv dast`, `apv web audit`, or Git asked for the history (log, show, describe...), which
 * differs between two commits of the same tree. A safety net, never exhaustive: a script file that reads them is not seen,
 * the project declares such a check `reuse: false`.
 */
const TEXT_RULES = [
    [/\b(?:npm|pnpm|yarn|bun|cnpm)\b[^;&|\n]*?\s(?:audit|outdated)(?![\w:.-])/, 'un audit des dépendances qui lit le réseau (npm audit ou équivalent), dont la base d\'avis change avec le temps'],
    [/\b(?:audit-ci|better-npm-audit|osv-scanner|snyk|npm-check-updates|ncu|npm-check)\b/, 'un audit des dépendances qui lit le réseau (npm audit ou équivalent), dont la base d\'avis change avec le temps'],
    [/\bapv\b[^;&|\n]*?\sdast\b/, 'apv dast, qui scanne un état extérieur au dépôt'],
    [/\bapv\b[^;&|\n]*?\sweb\s+audit\b/, 'apv web audit, qui mesure un état extérieur au dépôt'],
    [/\bgit(?:\.exe)?['"`]?[\s,]*\[?[\s'"`]*(?:log|shortlog|show|rev-list|describe|reflog|whatchanged|blame|merge-base|cherry|notes)\b/,
        'git sur l\'historique (log, show, describe...), qui diffère entre deux commits du même arbre'],
];
const GIT_HISTORY_TEXT = 'git sur l\'historique (log, show, describe...), qui diffère entre deux commits du même arbre';
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
        if (runsGitHistory(argv))
            return `il lance ${GIT_HISTORY_TEXT}${where}`;
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
    return { ...input, scans: new Map() };
}
/** The scripts of the package.json files of the commit judged, read once per context (the origin's are compared through the inputs). */
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
/** JSON with sorted keys and without absent values: two definitions compare by content, whatever the order of their fields. */
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).filter(k => value[k] !== undefined).sort()
            .map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
/** What a check reads and runs, without what never changes its result (`mandatory`, its early checks). */
const definition = (gate) => stable({ ...gate, mandatory: undefined, early: undefined });
/** The configuration file, relative to the repository, when it is inside it. */
function configPath(ctx) {
    const file = ctx.configFile;
    if (!file)
        return null;
    const committed = /^[a-f0-9]{40,64}:(.+)$/.exec(file);
    if (committed)
        return committed[1];
    if (!isAbsolute(file))
        return file;
    const rel = relative(ctx.repo, file).replace(/\\/g, '/');
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
}
/**
 * The files a check does not read, as the merge base with the target declares them (5.2 A2, 5.5.2): the check must declare
 * `reuse.ignore` there, with the very definition judged (command, test paths, reuse...: a PR that changes it, widens its
 * globs or adds the check never uses them for its own proof). Kept inputs whatever the globs: NEVER_IGNORED, the configuration
 * file read, the design folders, the test paths, `repeatChanged.paths` and the files the commands name, at the base and now.
 */
export async function inputsRuleOf(ctx, gate) {
    if (!gate?.id)
        return { reason: 'contrôle absent de la configuration : sa déclaration reuse.ignore ne se lit pas' };
    const base = await reuseBase(ctx);
    if ('reason' in base)
        return { reason: `reuse.ignore se lit à la base commune avec la cible : ${base.reason}` };
    const atBase = base.config?.gates.find(g => g.id === gate.id);
    const ignore = reuseSettingsOf(atBase)?.ignore;
    if (!atBase || !ignore?.length) {
        return { reason: `${gate.id} ne déclare pas reuse.ignore à la base ${base.mergeBase.slice(0, 12)} (${base.reference}) : un reuse.ignore ajouté ou élargi par la PR ne sert jamais à sa propre preuve` };
    }
    if (definition(atBase) !== definition(gate)) {
        return { reason: `définition de ${gate.id} changée depuis la base ${base.mergeBase.slice(0, 12)} (${base.reference}) : la reprise par entrées vaut pour la définition lue à la base` };
    }
    let baseDesign = 'docs/design';
    try {
        baseDesign = designDir(base.config?.design);
    }
    catch { /* The default folder stays an input. */ }
    const config = configPath(ctx);
    const keep = [...NEVER_IGNORED, CONFIG_FILE, LEGACY_CONFIG_FILE, ...(config ? [config] : []), ...new Set([baseDesign, 'docs/design', ...(ctx.design ? [ctx.design] : [])].map(d => `${d}/**`)),
        ...[atBase, gate].flatMap(g => [...(g.testPaths ?? []), ...(g.repeatChanged?.paths ?? []), ...commandPaths(g, ctx.repo)])];
    return { rule: { ignore: [...ignore], keep: [...new Set(keep)] }, mergeBase: base.mergeBase };
}
/** The digest of the inputs of a check at `commit` under `rule`, by tree, once per context; null when the commit is not in the repository. */
async function digestAt(ctx, rule, commit) {
    const tree = (await treesOf(ctx.git, ctx.repo, [commit])).get(commit);
    if (!tree)
        return null;
    ctx.digests ??= new Map();
    const key = `${ignoreDigest(rule.ignore)}\0${ignoreDigest(rule.keep)}\0${tree}`;
    if (!ctx.digests.has(key))
        ctx.digests.set(key, inputsDigest(ctx.git, ctx.repo, commit, rule).then(r => r.digest, () => null));
    return ctx.digests.get(key);
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
function readAll(ctx) {
    ctx.all ??= (async () => {
        const started = performance.now();
        const found = [...ctx.local.found];
        const doubtful = [];
        let runs = 0;
        let files = 0;
        const done = (block) => ({ found, doubtful, block, runs, files, ms: Math.round(performance.now() - started) });
        for (const runId of sharedRunIds(ctx.store)) {
            if (ctx.local.runs.has(runId))
                continue;
            runs += 1;
            const dir = join(ctx.store, runId);
            const named = manifestCommit(dir);
            if (!named)
                return done(`exécution ${runId} du magasin partagé au manifeste absent ou illisible : son commit est inconnu, un échec plus récent sur les mêmes entrées ne peut pas être exclu`);
            const claimed = new Set();
            for (const name of receiptFiles(dir)) {
                files += 1;
                const sha = claimedCommit(join(dir, name));
                if (sha)
                    claimed.add(sha);
            }
            const read = sharedRunReceipts(ctx.store, runId);
            if ('reason' in read || [...claimed].some(c => c !== named)) {
                doubtful.push({ runId, commits: [...new Set([named, ...claimed])] });
                continue;
            }
            found.push(...read.found);
        }
        return done(null);
    })();
    return ctx.all;
}
const hours = (ms) => String(Math.round(ms / 360_000) / 10);
const FAILING = (status) => !['passed', 'cached', 'not_required'].includes(status);
/**
 * Why a reuse by inputs cannot exclude a failure of the check later than its origin on the same inputs (5.5.4), or null: a
 * receipt of the check, of its targeted variant or of one of its early checks (M1), on a clean tree, at the configuration
 * judged, later than the origin, not a success, at a commit whose inputs have the same digest; or a run of the store that
 * cannot be trusted while it names a commit of the same inputs.
 */
async function laterInputsFailure(ctx, gateId, from, rule, digest) {
    const all = await readAll(ctx);
    if (all.block)
        return { reason: all.block };
    const same = async (commit) => (await digestAt(ctx, rule, commit)) === digest;
    for (const run of all.doubtful) {
        for (const commit of run.commits) {
            if (await same(commit))
                return { reason: `exécution ${run.runId} du magasin partagé altérée ou contradictoire, au commit ${commit.slice(0, 12)} des mêmes entrées : un échec plus récent ne peut pas être exclu` };
        }
    }
    const o = from.receipt;
    const later = all.found.filter(f => (f.receipt.gateId === gateId || f.receipt.early?.gate === gateId) && f.dirty === false && f.receipt.configHash === ctx.configHash
        && f.receipt !== o && f.receipt.id !== o.id && latest(from, f) === f && FAILING(f.receipt.status)).sort((a, b) => (latest(a, b) === a ? -1 : 1));
    for (const f of later) {
        if (!(await same(f.receipt.candidateSha)))
            continue;
        const fail = f.receipt;
        const kind = fail.early ? `, contrôle tôt ${fail.gateId}` : fail.targeted === true ? ', ciblé' : '';
        return { reason: `échec plus récent sur les mêmes entrées : ${fail.runId}/${fail.gateId}.json au commit ${fail.candidateSha.slice(0, 12)} (${fail.status}${fail.status === 'passed_after_retry' ? ', test instable' : ''}${kind}) l'emporte` };
    }
    return { cost: all };
}
/** The reason `verify` and `apv gates run` give for a proven reuse. */
export const reuseReason = (proof) => proof.basis === 'tree' ? 'arbre identique' : `entrées identiques : ${proof.changed} fichier(s) changé(s), tous ignorés par ce contrôle`;
/**
 * Whether a receipt `cached` proves its check at `ctx.commit` (docs/ACCELERATION-LOTS.md, 5.5). Nothing of it is trusted:
 * the check must not be one that is never reused (`gate`, from the configuration judged); its origin is read again (the
 * worktree when it has the run, else the run of the shared store, intact), must be the same check, `passed` at first pass
 * (never `cached`: no chain), complete, on a clean tree, of the current configuration, of the same reuse identity of the
 * environment, younger than the maximum age (`reuse.maxAgeMs` read at the base, maxAgeOf), with the same output digests,
 * without a record of `apv web audit`; a command that reads `{{baseSha}}` needs the same base and a merge base of the same
 * tree on both sides. `basis: tree`: the trees of both commits are recomputed and so is the digest of the inputs; the store
 * is scanned for the tree (TreeScan). `basis: inputs` (A2): the check declares `reuse.ignore` at the merge base with the
 * target, with the definition judged (inputsRuleOf); the inputs of both commits, recomputed with those globs, are equal and
 * equal to `inputsDigest`, no symbolic link is among them, the files changed are those declared; the whole store is read.
 * Either way, no receipt of the check later than the origin on the same tree or inputs failed: complete, targeted or of one of
 * its early checks. The environment compared includes the local state of the copy (localStateDigest, copyStateDigest).
 * Returns the proof, or why the receipt proves nothing.
 */
export async function checkReuse(ctx, gate, cached) {
    const r = cached.receipt;
    const reuse = r.reuse;
    const refuse = (reason) => ({ reason });
    if (!reuse)
        return refuse('reçu sans relevé reuse (exécution, commit et empreintes de l\'origine) : rien à vérifier');
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
    if (reuse.basis === 'inputs')
        return checkInputs(ctx, gate, cached, from);
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
    if (reuse.inputsDigest !== (await inputsDigest(ctx.git, ctx.repo, ctx.commit)).digest)
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
/** The part of checkReuse proper to a reuse by inputs (5.5.2 and 5.5.4 for `basis: inputs`). */
async function checkInputs(ctx, gate, cached, from) {
    const reuse = cached.receipt.reuse;
    const refuse = (reason) => ({ reason: `reprise par entrées identiques (basis inputs) : ${reason}` });
    const ruled = await inputsRuleOf(ctx, gate);
    if ('reason' in ruled)
        return refuse(ruled.reason);
    const { rule } = ruled;
    if (reuse.ignoreDigest !== ignoreDigest(rule.ignore))
        return refuse('globs ignorés du reçu différents de reuse.ignore lu à la base');
    let compared;
    try {
        compared = await compareInputs(ctx.repo, reuse.fromCommit, ctx.commit, rule);
    }
    catch {
        return refuse(`commit d'origine ${reuse.fromCommit.slice(0, 12)} introuvable dans le dépôt`);
    }
    if (compared.links.length) {
        return refuse(`lien(s) symbolique(s) parmi les entrées (${compared.links.slice(0, 3).join(', ')}) : sa cible peut être un fichier ignoré ; seule la reprise à arbre identique vaut`);
    }
    if (compared.from !== compared.to) {
        return refuse(`${compared.inputs.length} fichier(s) lu(s) par le contrôle changé(s) depuis ${reuse.fromCommit.slice(0, 12)} (${compared.inputs.slice(0, 5).join(', ')}${compared.inputs.length > 5 ? '...' : ''})`);
    }
    if (reuse.inputsDigest !== compared.to)
        return refuse('empreinte des entrées différente de celle recalculée au commit');
    if (reuse.changed !== compared.changed.length || stable(reuse.files) !== stable(compared.changed.slice(0, MAX_SCOPE_FILES))) {
        return refuse('fichiers changés déclarés différents de ceux recalculés depuis Git');
    }
    const later = await laterInputsFailure(ctx, cached.receipt.gateId, from, rule, compared.to);
    if ('reason' in later)
        return refuse(later.reason);
    return { origin: from, basis: 'inputs', changed: compared.changed.length, scan: { runs: later.cost.runs, files: later.cost.files, ms: later.cost.ms } };
}
/** Whether a found receipt may be the origin of a reuse in `environments` at the configuration judged (status, tree state, age, identity, base). */
function eligible(ctx, gate, f, limit, identities, base) {
    const r = f.receipt;
    return r.gateId === gate.id && r.status === 'passed' && !r.early && r.targeted !== true && f.dirty === false && r.configHash === ctx.configHash && !r.web
        && r.startedAt <= ctx.now && ctx.now - r.startedAt <= limit && identities.has(reuseIdentityOf(r))
        && (!readsBase(gate) || (f.baseSha !== null && f.baseSha === base));
}
/**
 * The origin `apv gates run` may reuse for `gate` at `ctx.commit` (docs/ACCELERATION-LOTS.md, A1 and A2), or why none. First
 * at an identical tree (A1): the latest receipt of the check on an identical tree (worktree, then shared store, intact), at
 * the same configuration, in one of the environments the check would run in now (`environments`: its variables, executable,
 * stack, compared by their reuse identity), `passed` at first pass, clean, complete, younger than the maximum age minus
 * REUSE_AGE_MARGIN_MS, without a record of `apv web audit`. Then, for a check that declares `reuse.ignore` at the base
 * (A2), the latest such receipt at a commit whose inputs have the same digest. The receipt about to be written is checked
 * by `checkReuse`, the very check `apv gates verify` runs: a receipt it would refuse is never written. `candidate`: false
 * when no receipt was even considered (nothing to say).
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
    const probeOf = async (origin, reuse, changed) => {
        const probe = { receipt: { ...origin.receipt, candidateSha: ctx.commit, status: 'cached', reusedFrom: origin.receipt.id, startedAt: ctx.now, durationMs: 0, reuse },
            dirty: false, baseSha: base, source: 'local' };
        const checked = await checkReuse(ctx, gate, probe);
        if ('reason' in checked)
            return { reason: checked.reason, candidate: true };
        const identity = reuseIdentityOf(origin.receipt);
        return { origin, reuse, stack: byIdentity.get(identity).stack, identity, changed };
    };
    // A1: an identical tree.
    const sameTree = scan.found.filter(f => f.receipt.gateId === gate.id && f.receipt.status === 'passed' && !f.receipt.early && f.receipt.targeted !== true
        && f.dirty === false && f.receipt.configHash === ctx.configHash && scan.trees.get(f.receipt.candidateSha) === tree && !f.receipt.web);
    let treeReason = null;
    if (scan.block)
        treeReason = { reason: scan.block, candidate: true };
    else if (!sameTree.length)
        treeReason = { reason: 'aucun reçu réussi au premier passage sur un arbre identique avec cette configuration', candidate: false };
    else {
        const young = sameTree.filter(f => f.receipt.startedAt <= ctx.now && ctx.now - f.receipt.startedAt <= limit);
        const sameEnv = young.filter(f => identities.has(reuseIdentityOf(f.receipt)));
        const sameBase = readsBase(gate) ? sameEnv.filter(f => f.baseSha !== null && f.baseSha === base) : sameEnv;
        if (!young.length)
            treeReason = { reason: `reçu(s) réussi(s) sur un arbre identique, mais de plus de ${hours(limit)} h (la reprise doit rester vérifiable ${hours(REUSE_AGE_MARGIN_MS)} h)`, candidate: true };
        else if (!sameEnv.length)
            treeReason = { reason: 'reçu(s) réussi(s) sur un arbre identique, mais dans un autre environnement (variables transmises, exécutable, pile, Node, système, version de l\'outil, ou état local ignoré par Git : node_modules, fichiers générés, fichiers .env*)', candidate: true };
        else if (!sameBase.length)
            treeReason = { reason: `reçu(s) réussi(s) sur un arbre identique, mais depuis une autre base ({{baseSha}} dans la commande : ${base?.slice(0, 12) ?? "aucune"} ici)`, candidate: true };
        else {
            const origin = sameBase.reduce(latest);
            const reuse = { fromRun: origin.receipt.runId, fromCommit: origin.receipt.candidateSha, basis: 'tree',
                inputsDigest: (await inputsDigest(ctx.git, ctx.repo, ctx.commit)).digest, ignoreDigest: ignoreDigest([]), environment: reuseIdentityOf(origin.receipt), changed: 0, files: [] };
            const chosen = await probeOf(origin, reuse, 0);
            if (!('reason' in chosen))
                return chosen;
            treeReason = chosen;
        }
    }
    // A2: identical inputs, for a check that declares reuse.ignore (in the configuration judged and, verified below, at the base).
    if (!reuseSettingsOf(gate)?.ignore?.length || scan.block)
        return treeReason;
    const ruled = await inputsRuleOf(ctx, gate);
    if ('reason' in ruled)
        return { reason: `${treeReason.reason} ; entrées : ${ruled.reason}`, candidate: true };
    const digest = await digestAt(ctx, ruled.rule, ctx.commit);
    if (!digest)
        return treeReason;
    const all = await readAll(ctx);
    const candidates = all.found.filter(f => eligible(ctx, gate, f, limit, identities, base) && scan.trees.get(f.receipt.candidateSha) !== tree)
        .sort((a, b) => (latest(a, b) === a ? -1 : 1));
    for (const origin of candidates) {
        if ((await digestAt(ctx, ruled.rule, origin.receipt.candidateSha)) !== digest)
            continue;
        let compared;
        try {
            compared = await compareInputs(ctx.repo, origin.receipt.candidateSha, ctx.commit, ruled.rule);
        }
        catch {
            continue;
        }
        const reuse = { fromRun: origin.receipt.runId, fromCommit: origin.receipt.candidateSha, basis: 'inputs',
            inputsDigest: compared.to, ignoreDigest: ignoreDigest(ruled.rule.ignore), environment: reuseIdentityOf(origin.receipt),
            changed: compared.changed.length, files: compared.changed.slice(0, MAX_SCOPE_FILES) };
        // The latest origin of the same inputs decides, as for a tree: refused, the reuse is refused (a later failure wins).
        return probeOf(origin, reuse, compared.changed.length);
    }
    return { reason: `${treeReason.reason} ; aucun reçu réussi sur les mêmes entrées (reuse.ignore lu à la base ${ruled.mergeBase.slice(0, 12)})`, candidate: treeReason.candidate };
}
//# sourceMappingURL=reuse-proof.js.map