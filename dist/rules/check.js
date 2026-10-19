import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { CONFIG_FILE, LEGACY_CONFIG_FILE, loadConfigAtCommit } from '../config/load.js';
import { loadDbConfigAtCommit } from '../db/config.js';
import { designDir } from '../design/config.js';
import { applyBaseGates, enforceBaseGates } from '../gates/base-gates.js';
import { verifyGates } from '../gates/verify.js';
import { planScope } from '../gates/proof-scope.js';
import { stageGates } from '../gates/run.js';
import { Git } from '../execution/git.js';
import { loadDecisionLedger } from '../lifecycle/decisions.js';
import { sensitivePaths } from '../policy/policy.js';
import { ALWAYS_REVIEWED, reviewPlanSettings } from '../review/config.js';
import { planReviews } from '../review/plan.js';
import { LEDGER_FILES } from '../review/risk.js';
import { DEFAULT_REUSE_IGNORE, UI_EXTENSIONS, extensionOf, globMatcher } from '../reuse/config.js';
import { WEB_DEPENDENCIES } from '../reuse/detect.js';
import { DELTA_DIFF, DELTA_GIT, gitRead, gitRoot, resolveCommit } from '../run/git-probe.js';
import { commonDir } from '../stacks/idle.js';
import { MERGE_RULES, RULE_TITLES, rulesSettings } from './config.js';
import { TEMPLATE_WAIVER_NOTE, anchorKey, readOperatorMessages, templateWaiver, waiverFor, waiverSentence } from './operator.js';
import { REQUIRED_WEB_GATES, missingRequiredGates } from './required.js';
import { DOMAIN_REVIEWERS, latestReviews } from './reviews.js';
import { NEVER_CARRIED, reviewChain } from './delta.js';
import { computedLoads } from './loads.js';
import { deltaFiles } from './carry.js';
import { LANE_NAME, docsOnlyLane, laneLines } from './docs-only.js';
import { isScreen, mockupsOf, screenCoverage, screenMatchers } from './screens.js';
import { ciProofLines, verifyCiProof } from './ci-proof.js';
import { githubRepository } from './protection.js';
import { targetsBranch } from '../release/config.js';
import { gateStage } from '../domain/contracts.js';
import { declarationVerdict, laneWouldFit, reducedLane } from './reduced-proof.js';
/** Whether the commit is a web interface: web dependencies in its package.json, or tracked interface files. */
export function isWebAt(repo, sha) {
    const pkg = gitRead(repo, ['show', `${sha}:package.json`]);
    if (pkg) {
        try {
            const value = JSON.parse(pkg);
            const deps = Object.keys({ ...(value['dependencies'] ?? {}), ...(value['devDependencies'] ?? {}) });
            if (deps.some(d => WEB_DEPENDENCIES.test(d)))
                return true;
        }
        catch { /* not JSON: the files decide */ }
    }
    const ignored = globMatcher([...DEFAULT_REUSE_IGNORE]);
    const files = gitRead(repo, ['ls-tree', '-r', '-z', '--name-only', sha])?.split('\0').filter(Boolean) ?? [];
    return files.some(f => !ignored(f) && UI_EXTENSIONS.has(extensionOf(f)));
}
/** Pages written in Markdown (mdsvex, MDX) under the routes or the pages of a project: screens the tool reads as files. */
const ROUTE_CONTENT = /(^|\/)(routes|pages)\/.*\.(md|svx|mdx)$/;
/**
 * Whether a file is, or brings, a screen: a screen of the routes or of rules.screens, a page in Markdown under the
 * routes, or an interface file of the web detection (UI_EXTENSIONS: an HTML page, a component, a server template).
 */
function screenLike(path, screens) {
    return isScreen(path, screens) || ROUTE_CONTENT.test(path) || UI_EXTENSIONS.has(extensionOf(path));
}
/** Whether the project has screens at `sha`: a web project (isWebAt), or a file the tool reads as a screen. */
function hasScreensAt(repo, sha, screens) {
    if (isWebAt(repo, sha))
        return true;
    const ignored = globMatcher([...DEFAULT_REUSE_IGNORE]);
    const files = gitRead(repo, ['ls-tree', '-r', '-z', '--name-only', sha])?.split('\0').filter(Boolean) ?? [];
    return files.some(f => !ignored(f) && screenLike(f, screens));
}
/**
 * Files that cannot change what a screen shows, by their path alone: the configuration of the tools (.apv, the CI, the
 * agents, the editor), the tests (a test folder at the root, a folder of the test runners, a file named as a test) and
 * their configuration, the documentation (Markdown under docs/ or at the root, when no documentation site serves it).
 * Never a file under a served folder (static, public, assets...) nor an interface file. Everything else counts as an
 * interface file: in doubt, captures are required.
 */
// The workflows and actions of .github may change what is deployed: interface files (review of #134).
const TOOLING_PATH = /^(?:\.apv|\.github(?!\/(?:workflows|actions)\/)|\.claude|\.vscode|\.husky)\//;
/** Configuration files that may declare aliases (Vite, SvelteKit, Astro, Nuxt, Next, webpack, TypeScript, JavaScript). */
const ALIAS_CONFIG = /(?:^|\/)(?:(?:vite|vitest|svelte|astro|nuxt|next|webpack|rollup)\.config\.[cm]?[jt]s|[jt]sconfig[\w.-]*\.json)$/;
/**
 * The search for loads by a pattern or a computed path (src/rules/loads.ts) reads the tracked files of the application:
 * neither node_modules nor a build output (dist/, build/ at the root only: `src/routes/build/` is a route served,
 * `src/lib/dist/` a module, third security review of #141, M3), nor a binary file by its extension, nor a file outside
 * the interface (tests, tooling, documentation). A file with a NUL byte is read all the same (Node and esbuild run a
 * script with one in a comment, M4). Beyond MAX_LOAD_BYTES to read, the tool does not judge: captures required.
 */
const NOT_APPLICATION = /^(?:dist|build)\/|(?:^|\/)node_modules\//;
const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|heic|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|mp[34]|m4a|aac|flac|wav|ogg|oga|webm|mov|avi|mkv|wasm|node|so|dylib|dll|exe|bin|sqlite3?|db)$/i;
const MAX_LOAD_BYTES = 16 * 1024 * 1024;
/**
 * A file read by a computed path (readFile, readFileSync, createReadStream) in a tooling script (`scripts/`) or a module
 * of the tests named as such (`*.fixture.*`, `*.mock.*`, `__mocks__/`) is no load of the application: such scripts read
 * the files they are given. Their computed import or require still counts.
 */
const READS_OUTSIDE_APPLICATION = /^scripts\/|(?:^|\/)__mocks__\/|(?:^|\/)[^/]+\.(?:fixtures?|mocks?)\.[^/]+$/;
const TOOLING_FILE = /^(?:\.gitignore|\.gitattributes|\.editorconfig|\.nvmrc|\.node-version)$/;
const TEST_PATH = /^(?:tests?|e2e)\/|(?:^|\/)(?:__tests__|__snapshots__)\/|\.(?:test|spec)\.[cm]?[jt]s$|^(?:playwright|vitest)\.config\.[cm]?[jt]s$/;
const DOC_PATH = /^(?:docs\/.+|[^/]+)\.md$/;
const SERVED_PATH = /(?:^|\/)(?:static|public|assets|www|dist|build|out)\//;
/** A documentation site: its pages are served screens. */
const DOCS_SITE = /^(?:mkdocs\.ya?ml|book\.toml|docusaurus\.config\.[cm]?[jt]s|docs\/\.vitepress\/|docs\/package\.json|docs\/astro\.config\.)/;
/** Beyond this number of files, the tool does not judge: captures required. */
const MAX_FILES_WITHOUT_SCREEN = 500;
function withoutScreenByPath(path, docsSite, screens) {
    if (screenLike(path, screens) || SERVED_PATH.test(path))
        return false;
    return TOOLING_PATH.test(path) || TOOLING_FILE.test(path) || TEST_PATH.test(path) || (!docsSite && DOC_PATH.test(path));
}
/**
 * What another file of the head would hold if it used `file`: an import path (`/<name>`, `/<name without its script
 * extension>`); for a document, its bare name (read by a path built in code) and its folder (`docs/`).
 */
function referenceTokens(file) {
    const name = file.split('/').pop() ?? file;
    const stem = name.replace(/\.[cm]?[jt]s$/, '');
    const tokens = [`/${name}`, ...(stem !== name && stem ? [`/${stem}`] : [])];
    if (DOC_PATH.test(file))
        tokens.push(name, ...(file.startsWith('docs/') ? ['docs/'] : []));
    return tokens;
}
/**
 * The paths the alias sections of a configuration point to: the strings inside `alias: {...}`, `alias: [...]` (Vite,
 * SvelteKit `kit.alias`) and `"paths": {...}` (TypeScript), `./` and trailing `/*` removed. Keys come out too; they name no
 * folder of the change.
 */
function aliasTargets(text) {
    const out = [];
    for (const m of text.matchAll(/\b(?:alias|paths)["']?\s*:\s*([[{])/g)) {
        const open = m[1];
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < text.length; end += 1) {
            if (text[end] === open)
                depth += 1;
            else if (text[end] === close && (depth -= 1) === 0)
                break;
        }
        for (const literal of text.slice(m.index, end + 1).matchAll(/(['"`])((?:(?!\1).)+)\1/g)) {
            const value = literal[2].replace(/^\.\//, '').replace(/\/\*+$/, '').replace(/\/$/, '');
            out.push(value === '' ? '.' : value);
        }
    }
    return out;
}
/** Why a file of the change may change a screen, by its path alone; null when it cannot. */
function screenReasonByPath(path, docsSite, screens) {
    if (screenLike(path, screens))
        return 'fichier d\'interface (écran, composant, page, gabarit)';
    if (SERVED_PATH.test(path))
        return 'dossier servi';
    if (docsSite && DOC_PATH.test(path))
        return 'documentation servie par un site de documentation';
    if (withoutScreenByPath(path, docsSite, screens))
        return null;
    if (/^\.github\//.test(path))
        return 'workflow ou action : peut changer ce qui est déployé';
    return 'peut changer un écran (ni configuration des outils, ni test, ni documentation non servie)';
}
/** Extensions whose lines a comment marker opens: `#` (YAML, shell, Python, Ruby, TOML), `//` `/*` `*` (scripts), `<!--` (pages). */
const HASH_COMMENTS = /\.(?:ya?ml|sh|bash|zsh|py|rb|toml|conf|ini)$/;
const SLASH_COMMENTS = /\.(?:[cm]?[jt]sx?|svelte|vue|astro)$/;
const MARKUP_COMMENTS = /\.(?:html?|svelte|vue|astro|xml|svg)$/;
/**
 * The lines (numbered from 1) that start inside a block comment (slash-star to star-slash) of a script, strings and line comments followed
 * from the start of the file. A text the scan cannot follow leaves a line outside: in doubt, not a comment.
 */
export function blockCommentLines(text) {
    const inside = new Set();
    let state = 'code';
    let line = 1;
    for (let k = 0; k < text.length; k += 1) {
        const c = text[k];
        if (c === '\n') {
            line += 1;
            if (state === 'line')
                state = 'code';
            if (state === 'block')
                inside.add(line);
            continue;
        }
        if (state === 'code') {
            if (c === '/' && text[k + 1] === '/') {
                state = 'line';
                k += 1;
            }
            else if (c === '/' && text[k + 1] === '*') {
                state = 'block';
                k += 1;
            }
            else if (c === '"' || c === "'" || c === '`')
                state = c;
        }
        else if (state === 'block') {
            if (c === '*' && text[k + 1] === '/') {
                state = 'code';
                k += 1;
            }
        }
        else if (state === '"' || state === "'" || state === '`') {
            if (c === '\\')
                k += 1;
            else if (c === state)
                state = 'code';
        }
    }
    return inside;
}
/**
 * Whether a line of `path` is only a comment: a reference in a comment loads nothing. Never for a style sheet or a text.
 * A line that starts with `*` counts only inside a block comment opened above (`inBlock`, review of #135): elsewhere it
 * may continue an expression (`  * (await import(…))`).
 */
function commentLine(path, line, inBlock) {
    const l = line.trim();
    if (HASH_COMMENTS.test(path) && l.startsWith('#'))
        return true;
    if (MARKUP_COMMENTS.test(path) && l.startsWith('<!--') && !/-->\s*\S/.test(l))
        return true;
    if (!SLASH_COMMENTS.test(path))
        return false;
    if (l.startsWith('//'))
        return true;
    if (l.startsWith('/*'))
        return !/\*\/\s*\S/.test(l);
    if (l.startsWith('*') && !l.startsWith('*/'))
        return inBlock() && !/\*\/\s*\S/.test(l);
    return false;
}
/**
 * Whether a file of the head that names a file of the change may bring it to a screen: not when it is itself outside the
 * interface (a test, its configuration, the code map, the documentation...), nor a document under docs/ without a
 * documentation site, whatever its extension (a plan in HTML is not served).
 */
function referencerMayShow(path, docsSite, screens) {
    if (withoutScreenByPath(path, docsSite, screens))
        return false;
    return docsSite || !path.startsWith('docs/');
}
/**
 * The files of the application at a commit that load by a pattern or a computed path (src/rules/loads.ts); a sentence
 * when the tool cannot tell (too much to read, objects unreadable).
 */
function loadersAt(repo, entries, docsSite, screens) {
    const read = entries.filter(e => (e.mode === '100644' || e.mode === '100755') && !NOT_APPLICATION.test(e.path) && !BINARY_FILE.test(e.path)
        && !withoutScreenByPath(e.path, docsSite, screens));
    const bytes = read.reduce((n, e) => n + e.size, 0);
    const mib = (n) => `${Math.ceil(n / (1024 * 1024))} Mio`;
    if (bytes > MAX_LOAD_BYTES)
        return `recherche des chargements par motif : ${mib(bytes)} de fichiers de l'application à lire, plus de ${mib(MAX_LOAD_BYTES)} : impossible de juger`;
    if (!read.length)
        return [];
    const batch = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'cat-file', '--batch'], { cwd: repo, input: `${read.map(e => e.sha).join('\n')}\n`, timeout: 60_000, maxBuffer: MAX_LOAD_BYTES + read.length * 128 + 1024 });
    if (batch.status !== 0 || batch.error)
        return 'recherche des chargements par motif illisible : impossible de juger';
    const out = [];
    let at = 0;
    for (const entry of read) {
        const end = batch.stdout.indexOf(10, at);
        const header = end < 0 ? null : /^[0-9a-f]+ blob (\d+)$/.exec(batch.stdout.subarray(at, end).toString('latin1'));
        if (!header)
            return 'recherche des chargements par motif illisible : impossible de juger';
        const size = Number(header[1]);
        const body = batch.stdout.subarray(end + 1, end + 1 + size);
        at = end + 1 + size + 1;
        const kinds = computedLoads(entry.path, body.toString('utf8'));
        if (kinds.has('load') || (kinds.has('read') && !READS_OUTSIDE_APPLICATION.test(entry.path)))
            out.push(entry.path);
    }
    return out;
}
const MAX_REASONS = 20;
/**
 * Whether a change touches no screen, for the rule captures. Every file it adds, modifies, removes or renames (a rename is
 * a removal and an addition: both sides judged) must be, by its path, outside the interface (withoutScreenByPath), and
 * none may be brought to a screen another way: named by a file of the head that may show it (referenceTokens, a mention
 * in a comment, a test, the documentation or the code map aside), reached by a symbolic link, loaded by a pattern or a
 * computed path (a test or a document, when the application loads that way), or aimed at by an alias. Every cause found is
 * said, file by file; the tool also says when it cannot tell (diff, tree or search unreadable, a link that leaves the
 * repository, too many files or too much to read): captures are then required.
 */
export function touchesNoScreen(repo, base, head, screens) {
    const reasons = [];
    // Every submodule seen, a changed link or trees that differ with no file listed refused (deltaFiles, review of #141, A1).
    const read = deltaFiles(repo, base, head);
    if (read.cause !== null)
        return { files: 0, reasons: [`diff illisible : ${read.cause} : impossible de juger`] };
    const files = read.files;
    const verdict = () => ({ files: files.length, reasons: [...new Set(reasons)].slice(0, MAX_REASONS) });
    if (files.length > MAX_FILES_WITHOUT_SCREEN) {
        reasons.push(`${files.length} fichiers, plus de ${MAX_FILES_WITHOUT_SCREEN} : impossible de juger`);
        return verdict();
    }
    const tree = gitRead(repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', head]);
    if (tree === null) {
        reasons.push(`arbre de ${short(head)} illisible : impossible de juger`);
        return verdict();
    }
    const entries = tree.split('\0').filter(Boolean).map(e => {
        const tab = e.indexOf('\t');
        const [mode, , sha, size] = e.slice(0, tab).split(/ +/);
        return { mode: mode ?? '', sha: sha ?? '', size: Number(size) || 0, path: e.slice(tab + 1) };
    });
    const docsSite = entries.some(e => DOCS_SITE.test(e.path));
    for (const f of files) {
        const why = screenReasonByPath(f, docsSite, screens);
        if (why)
            reasons.push(`${f} : ${why}`);
    }
    if (reasons.length)
        return verdict();
    // Symbolic links of the head: one that leads to a file of the change or to a folder that holds one.
    const links = entries.filter(e => e.mode === '120000');
    if (links.length) {
        const read = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'cat-file', '--batch'], { cwd: repo, input: `${links.map(l => l.sha).join('\n')}\n`, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
        if (read.status !== 0 || read.error) {
            reasons.push('liens symboliques illisibles : impossible de juger');
            return verdict();
        }
        const out = read.stdout;
        let at = 0;
        for (const link of links) {
            const header = /^([0-9a-f]+) blob (\d+)\n/.exec(out.slice(at));
            if (!header) {
                reasons.push('liens symboliques illisibles : impossible de juger');
                return verdict();
            }
            const start = at + header[0].length;
            const target = out.slice(start, start + Number(header[2]));
            at = start + Number(header[2]) + 1;
            const resolved = posix.normalize(posix.join(posix.dirname(link.path), target)).replace(/\/$/, '');
            if (target.startsWith('/') || resolved.startsWith('..')) {
                reasons.push(`${link.path} : lien symbolique hors du dépôt, impossible de juger`);
                continue;
            }
            for (const f of files)
                if (f === resolved || f.startsWith(`${resolved}/`))
                    reasons.push(`${f} : atteint par le lien symbolique ${link.path}`);
        }
    }
    // A test or a document, when a file of the application loads by a pattern or a computed path: what it loads cannot be
    // read from the text, wherever the file lies (second review of #134: tests/fixtures at the root, apps/*/src).
    const loaded = files.filter(f => TEST_PATH.test(f) || DOC_PATH.test(f));
    if (loaded.length) {
        const loaders = loadersAt(repo, entries, docsSite, screens);
        if (typeof loaders === 'string') {
            reasons.push(loaders);
            return verdict();
        }
        if (loaders.length)
            for (const f of loaded)
                reasons.push(`${f} : chargement par motif ou chemin calculé dans ${loaders.slice(0, 3).join(', ')}`);
    }
    // An alias toward a folder of the change (Vite, SvelteKit, tsconfig paths...): a page imports it by a name the text of
    // the file does not hold (second review of #134).
    for (const config of entries.filter(e => ALIAS_CONFIG.test(e.path))) {
        const text = gitRead(repo, ['show', `${head}:${config.path}`]);
        if (text === null) {
            reasons.push(`${config.path} illisible : impossible de juger ses alias`);
            continue;
        }
        for (const target of aliasTargets(text)) {
            const resolved = posix.normalize(posix.join(posix.dirname(config.path), target)).replace(/\/$/, '');
            if (resolved.startsWith('..'))
                continue;
            for (const f of files)
                if (resolved === '.' || f === resolved || f.startsWith(`${resolved}/`))
                    reasons.push(`${f} : visé par l'alias de ${config.path}`);
        }
    }
    // Named by another file of the head that may show it (a mention in a comment loads nothing).
    const byToken = new Map();
    for (const f of files)
        for (const t of referenceTokens(f))
            byToken.set(t, [...(byToken.get(t) ?? []), f]);
    if (byToken.size) {
        const found = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'grep', '-z', '-n', '-F', ...[...byToken.keys()].flatMap(t => ['-e', t]), head, '--'], { cwd: repo, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        if (found.error || (found.status !== 0 && found.status !== 1)) {
            reasons.push('recherche des fichiers qui les nomment illisible : impossible de juger');
            return verdict();
        }
        const blocks = new Map();
        const inBlock = (path, line) => {
            if (!blocks.has(path)) {
                const text = gitRead(repo, ['show', `${head}:${path}`]);
                blocks.set(path, text === null ? null : blockCommentLines(text));
            }
            return blocks.get(path)?.has(line) ?? false;
        };
        for (const hit of found.status === 0 ? found.stdout.split('\n').filter(Boolean) : []) {
            // `<head>:<path>\0<line>\0<text>`; anything else (a binary file that matches) is not read: it may show the file.
            const [where = '', lineNumber = '', text = ''] = hit.split('\0');
            if (!where.startsWith(`${head}:`)) {
                reasons.push(`${where.slice(0, 120)} : fichier binaire qui nomme un fichier du changement`);
                continue;
            }
            const path = where.slice(head.length + 1);
            if (!referencerMayShow(path, docsSite, screens) || commentLine(path, text, () => inBlock(path, Number(lineNumber))))
                continue;
            for (const [token, named] of byToken)
                if (text.includes(token))
                    for (const f of named)
                        if (f !== path)
                            reasons.push(`${f} : nommé par ${path}`);
        }
    }
    return verdict();
}
/** Files the change adds or modifies since the base (renames counted as an addition: a moved screen is a new address). */
function changedFiles(repo, base, head) {
    const raw = gitRead(repo, [...DELTA_GIT, 'diff', ...DELTA_DIFF, '--name-status', '-z', base, head]);
    if (raw === null)
        throw new PipelineError('RULES', `diff illisible entre ${base.slice(0, 12)} et ${head.slice(0, 12)}`);
    const parts = raw.split('\0').filter(Boolean);
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2)
        if (/^[AMT]/.test(parts[i]))
            out.push(parts[i + 1]);
    return out;
}
const short = (sha) => sha.slice(0, 12);
/** Every file the change adds, modifies or removes since the base (both sides of a rename); empty when unreadable. */
function touchedFiles(repo, base, head) {
    return (gitRead(repo, [...DELTA_GIT, 'diff', ...DELTA_DIFF, '--name-only', '-z', base, head, '--']) ?? '').split('\0').filter(Boolean);
}
function outcome(rule, status, detail, problems = [], todo = []) {
    return { rule, title: RULE_TITLES[rule], status, detail, problems, todo, waiver: null };
}
/**
 * The rules checked before any merge (docs/REGLES.md). Each one says what it checked, why it refuses and what to do. A
 * refusal is lifted by the correction it asks for, or by the operator himself: « dérogation <règle> <commit> : <raison> »
 * typed in the session (operator journal); no option of the tool lifts it.
 */
export async function checkMergeRules(input) {
    const repo = gitRoot(input.repo);
    const common = commonDir(repo);
    const sha = resolveCommit(repo, input.commit);
    if (!sha)
        throw new PipelineError('RULES', `Commit ${input.commit} absent de ce dépôt : récupérez la branche (git fetch origin <branche>) puis relancez.`);
    const skip = new Set(input.skip ?? []);
    const candidate = loadConfigAtCommit(repo, sha).config;
    const applied = applyBaseGates(repo, candidate, sha, input.target, input.remote ?? { strict: true });
    const base = applied.base;
    const effective = applied.config;
    const mergeBase = base.mergeBase;
    if (!mergeBase)
        throw new PipelineError('RULES', `Aucune base commune entre ${input.target} et ${short(sha)}.`);
    // What the rules read comes from the base: a change never sets its own rules.
    const atBase = loadConfigAtCommit(repo, mergeBase).config;
    const settings = rulesSettings(atBase.rules, REQUIRED_WEB_GATES);
    const anchor = anchorKey(common);
    const messages = readOperatorMessages(common, anchor.key);
    const rules = [];
    // The reduced proof lifts checks (docs/PREUVE-REDUITE.md, 4.3): added or widened by the change, the rule preuve
    // refuses without an anchored decision of the operator, whatever proves the checks (a batch too).
    const baseRp = atBase.rules?.operatorOrders?.reducedProof;
    const headRp = candidate.rules?.operatorOrders?.reducedProof;
    const workflowBlob = (at, path) => path ? gitRead(repo, ['rev-parse', '--verify', '--quiet', `${at}:${path}`]) : null;
    const declaration = await declarationVerdict(baseRp, headRp, { base: workflowBlob(mergeBase, baseRp?.workflow), head: workflowBlob(sha, headRp?.workflow) }, async () => ({ atBase: (await loadDecisionLedger(repo, mergeBase)).decisions, atHead: (await loadDecisionLedger(repo, sha)).decisions }), messages, anchor.key);
    // The plan of the reviews, and the lane without code (docs/REGLES.md): both read at the base, from the diff since it.
    // The migrations as the base declares them, and as the change declares them: a change that moves db.migrations
    // never takes its migrations out of the data review (both sets of paths count, never the working tree).
    const migrations = [...new Set([...loadDbConfigAtCommit(repo, mergeBase).config.migrations, ...loadDbConfigAtCommit(repo, sha).config.migrations])];
    const reviewSettings = reviewPlanSettings(atBase.review);
    const sensitive = [...sensitivePaths, ...atBase.risk.highPaths];
    const baseDesign = designDir(atBase.design);
    const light = settings.mode === 'leger';
    // Release decoupled from the merge (`release` at the base): the full suite is asked at `apv release`, not here.
    const releaseLane = light && atBase.release && targetsBranch(input.target, atBase.release.from) ? atBase.release : null;
    const taskProof = releaseLane && atBase.gates.some(g => gateStage(g) === 'task') ? releaseLane : null;
    const plan = planReviews({ repo, base: mergeBase, head: sha, settings: reviewSettings, migrations, designDir: baseDesign, sensitive, force: [], mode: settings.mode });
    const lane = await docsOnlyLane({ repo, mergeBase, head: sha, plan, settings: settings.docsOnly, designDir: baseDesign, sensitive, messages, key: anchor.key });
    // In the lane, only the domains the configuration forces (review.always) are required.
    const retained = lane.eligible ? plan.retained.filter(d => reviewSettings.always.includes(d)) : plan.retained;
    // preuve, instable: the full suite at this exact commit, with the checks of the base kept. In the lane without code,
    // when every check of the full suite declares skipWhenOnly and none is required by its scope (recomputed here from the
    // commit, the base and the reference, as apv gates verify does), there is nothing to prove: no receipt is asked for.
    let unscoped = null;
    if (lane.eligible && (!skip.has('preuve') || !skip.has('instable'))) {
        try {
            const full = stageGates(effective.gates, 'full').run;
            if (full.length && full.every(g => g.skipWhenOnly)) {
                const decisions = await planScope(new Git(), repo, effective, { base: mergeBase, head: sha });
                if (full.every(g => decisions.get(g.id)?.required === false))
                    unscoped = full.map(g => g.id).join(', ');
            }
        }
        catch {
            unscoped = null;
        }
    }
    let proof = null;
    let proofError = null;
    if (!unscoped && (!skip.has('preuve') || !skip.has('instable'))) {
        try {
            proof = await verifyGates({ repo, config: effective, commit: sha, stage: taskProof ? 'task' : 'full', ...(taskProof ? { base: mergeBase } : {}), configFile: null, reuseReference: mergeBase });
        }
        catch (error) {
            proofError = errorMessage(error);
        }
    }
    const proveTodo = taskProof ? [
        `Dans une copie à ${short(sha)} : apv gates run --stage task --base ${short(mergeBase)}`,
        `puis apv gates verify --commit ${short(sha)} --stage task --base ${short(mergeBase)} doit sortir en 0.`,
    ] : [
        `Dans une copie à ${short(sha)} : apv gates run --stage full --base ${input.target}`,
        `puis apv gates verify --commit ${short(sha)} --against ${input.target} doit sortir en 0.`,
    ];
    const proofWhat = taskProof ? 'contrôles de tâche et tests ciblés au commit exact' : 'suite complète au commit exact';
    // The proof by the CI, declared at the base (never by the change), for the checks without a clean local receipt: the
    // local receipts stay first, the API is read only when they leave a check unproven.
    let ci = null;
    const ciNotes = [];
    const offline = input.remote?.offline === true;
    const ciGh = offline ? null : input.ci?.gh ?? null;
    const ciRepository = input.ci && input.ci.repository !== undefined ? input.ci.repository : githubRepository(repo);
    // The reduced proof (docs/PREUVE-REDUITE.md): only in the context mergeOnOrder builds, only for the checks the local
    // receipts leave unproven. Retained, it lifts `waives` and proves the pending checks of `gates`; the others stay
    // required as before (local receipts, then rules.ciProof).
    let reduced = null;
    if (input.orderLane && !skip.has('preuve') && !unscoped && proof && !proof.ok) {
        reduced = await reducedLane({ repo, commit: sha, target: resolveCommit(repo, input.target) ?? input.target, mergeBase, lane: input.orderLane, proof, config: effective, gh: ciGh, repository: ciRepository });
    }
    const waived = new Set(reduced?.retained ? reduced.waived : []);
    const provenByReduced = reduced?.retained ? reduced.proven : [];
    if (!skip.has('preuve') && !unscoped && proof && !proof.ok) {
        const pending = proof.gates.filter(g => (g.state === 'missing' || g.state === 'dirty') && !waived.has(g.gateId) && !provenByReduced.includes(g.gateId)).map(g => g.gateId);
        if (settings.ciProof && pending.length) {
            ci = await verifyCiProof({ repo, mergeBase, head: sha, settings: settings.ciProof, pending, config: effective, gh: ciGh, repository: ciRepository });
        }
        else if (!settings.ciProof && candidate.rules?.ciProof) {
            ciNotes.push(`rules.ciProof déclarée par la PR, ignorée : seule la base commune compte (${short(mergeBase)}) ; la preuve CI vaudra après la fusion de cette déclaration`);
        }
    }
    const viaCi = new Set(ci?.state === 'accepted' ? ci.gates : []);
    const provenByCi = proof ? proof.gates.filter(g => viaCi.has(g.gateId) && (g.state === 'missing' || g.state === 'dirty')).map(g => g.gateId) : [];
    const laneNotes = reduced && !reduced.retained ? [...reduced.reasons.slice(0, 10).map(r => `voie réduite non retenue : ${r}`),
        ...(reduced.reasons.length > 10 ? [`voie réduite non retenue : et ${reduced.reasons.length - 10} autre(s) raison(s)`] : [])] : [];
    if (skip.has('preuve'))
        rules.push(outcome('preuve', 'not_applicable', 'prouvée par le lot (une suite complète sur la tête du lot)'));
    else if (unscoped)
        rules.push(outcome('preuve', 'not_applicable', `${LANE_NAME} : aucun contrôle ne s'applique, chacun non requis par sa portée (skipWhenOnly, recalculée depuis le commit) : ${unscoped}`));
    else if (proofError)
        rules.push(outcome('preuve', 'refused', proofWhat, [proofError], proveTodo));
    else if (proof.ok)
        rules.push(outcome('preuve', 'ok', `${proof.required.length} contrôle(s)${taskProof ? ' de tâche' : ''} prouvé(s) à ${short(sha)}, contrôles de la base compris`));
    else {
        const missing = proof.gates.filter(g => g.state !== 'passed' && !provenByCi.includes(g.gateId) && !provenByReduced.includes(g.gateId) && !waived.has(g.gateId)).map(g => `${g.gateId} (${g.state})`);
        if (!missing.length && reduced?.retained) {
            const run = reduced.outcome.checkRun;
            const required = proof.required.filter(g => !waived.has(g)).length;
            rules.push(outcome('preuve', 'ok', `voie réduite sur ordre ${reduced.nonce}, étape ${reduced.step} : ${required} contrôle(s) prouvé(s) à ${short(sha)} `
                + `(${required - provenByReduced.length - provenByCi.length} par reçus locaux, ${provenByReduced.length} par le check run « ${reduced.outcome.name} » ${run.id}, exécution ${run.runId} (${run.event})`
                + `${provenByCi.length ? `, ${provenByCi.length} par la CI (${provenByCi.join(', ')})` : ''}) ; levés : ${reduced.waived.join(', ')} ; couvert : ${reduced.covers}`
                + `${reduced.content.length ? ` ; contenu régénéré exécuté par la preuve réduite : ${reduced.content.join(', ')}` : ''}`));
        }
        else if (!missing.length) {
            const run = ci.checkRun;
            rules.push(outcome('preuve', 'ok', `${proof.required.length} contrôle(s) prouvé(s) à ${short(sha)}, contrôles de la base compris : `
                + `${proof.required.length - provenByCi.length} par les reçus locaux, ${provenByCi.length} par la CI (${provenByCi.join(', ')}) : `
                + `check run « ${ci.name} » ${run.id} de GitHub Actions, workflow ${run.workflow} inchangé depuis la base, exécution ${run.runId} (${run.event}), conclusion success`
                + `${ci.artifact ? ` ; reçus de l'artefact ${ci.artifact} : mesure seulement` : ''}`));
        }
        else {
            const laneSaid = reduced?.retained ? [`voie réduite sur ordre ${reduced.nonce} retenue : levés ${reduced.waived.join(', ')}${provenByReduced.length ? ` ; prouvés par le check run « ${reduced.outcome.name} » : ${provenByReduced.join(', ')}` : ''}`] : [];
            rules.push(outcome('preuve', 'refused', proofWhat, [`contrôle(s) non prouvé(s) à ${short(sha)} : ${missing.join(', ')}`, ...(ci ? ciProofLines(ci) : []), ...ciNotes, ...laneSaid, ...laneNotes], ci && ci.state !== 'out_of_lane' && ci.gates.length && ci.state !== 'accepted'
                ? [...proveTodo, `Ou, pour ${ci.gates.join(', ')}, le check run « ${ci.name} » de GitHub Actions conclu en succès à ${short(sha)} (workflow ${ci.workflow}), puis relancer apv rules check.`]
                : proveTodo));
        }
    }
    const preuveOutcome = rules.find(r => r.rule === 'preuve');
    if (taskProof && !skip.has('preuve'))
        preuveOutcome.title = 'preuve de tâche au commit exact (suite complète à la mise en ligne)';
    if (preuveOutcome.status === 'ok' && laneNotes.length)
        preuveOutcome.detail += ` ; ${laneNotes[0]}`;
    // Outside the merge on order (5.1): the reduced lane is only said possible, never taken.
    const baseDeclaration = atBase.rules?.operatorOrders?.reducedProof;
    if (!input.orderLane && baseDeclaration && preuveOutcome.status === 'refused') {
        const fits = laneWouldFit(baseDeclaration, touchedFiles(repo, mergeBase, sha));
        if (fits)
            preuveOutcome.problems.push(`information : voie réduite possible sur ordre signé seulement (apv stack merge --order) : le diff tient dans rules.operatorOrders.reducedProof.paths.${fits}`);
    }
    if (declaration.kind !== 'unchanged') {
        const preuve = rules.find(r => r.rule === 'preuve');
        if (declaration.kind === 'anchored')
            preuve.detail += ` ; ${declaration.note}`;
        else {
            preuve.status = 'refused';
            preuve.problems.unshift(declaration.problem);
            preuve.todo = [...declaration.todo, ...preuve.todo];
        }
    }
    // A job of the CI relaunched (run_attempt above 1) passed only after a relaunch, as a receipt passed_after_retry.
    const ciRelaunched = provenByCi.length > 0 && (ci?.checkRun?.runAttempt ?? 0) > 1;
    const reducedRun = reduced?.retained ? reduced.outcome?.checkRun ?? null : null;
    const reducedRelaunched = reducedRun !== null && reducedRun.runAttempt > 1;
    if (skip.has('instable'))
        rules.push(outcome('instable', 'not_applicable', 'jugée sur la suite du lot'));
    else if (unscoped)
        rules.push(outcome('instable', 'not_applicable', `${LANE_NAME} : aucun contrôle à lancer`));
    else if (!proof)
        rules.push(outcome('instable', 'refused', 'contrôles réussis au premier passage', ['preuve illisible : rien ne montre que les contrôles ont réussi sans relance'], proveTodo));
    else if (proof.flaky.length || ciRelaunched || reducedRelaunched) {
        const flaky = [...proof.flaky, ...(ciRelaunched ? [`${provenByCi.join(', ')} (job de la CI relancé : tentative ${ci.checkRun.runAttempt} de l'exécution ${ci.checkRun.runId})`] : []),
            ...(reducedRelaunched ? [`${[...provenByReduced, ...waived].join(', ')} (job de la preuve réduite relancé : tentative ${reducedRun.runAttempt} de l'exécution ${reducedRun.runId})`] : [])];
        rules.push(outcome('instable', 'refused', 'contrôles réussis au premier passage', [`réussi(s) seulement après relance : ${flaky.join(', ')}`], [
            'Examine chaque test instable comme un bug possible du produit (course, attente d\'un fait non observé, données partagées entre tests), pas seulement du test.',
            'Corrige la cause, pousse, puis relance la suite complète sur le nouveau commit : aucune fusion sur un vert obtenu par relance.',
        ]));
    }
    else
        rules.push(outcome('instable', 'ok', `aucun contrôle réussi seulement après relance${provenByCi.length ? ` ; ${provenByCi.join(', ')} prouvé(s) par la CI à la première tentative du job (relances des tests réglées par les fichiers protégés de la base)` : ''}`));
    // relecture, captures: the domains `apv review plan` retains for the change, each recorded at this commit, or waived
    // for that domain alone by the operator (« dérogation relecture:<domaine> <commit> : <raison> », issue #126).
    const reviews = latestReviews(common, sha, undefined, !light);
    const screenMatch = screenMatchers(settings.screens);
    // A head that only brings its base up to date (a merge of the target, the diff identical byte for byte) keeps the
    // reviews of the head before, said domain by domain (carry.ts, pilot project #230); its own reviews come first. A head
    // without a review of donnees or rgpd keeps the review of an earlier commit of the branch when the delta since it
    // leaves the perimeter of the domain (never securite nor fidelite, NEVER_REPORTED; fidelite comes back with the
    // fingerprint of the build output), and a review of the delta counts on a usable review where it starts
    // (delta.ts, docs/ACCELERATION-LOTS.md, part B). The perimeter is the plan of the reviews of each step, read with the
    // settings of the base, as for the change itself.
    const deltaPlans = new Map();
    const touches = (perimeter, span) => {
        if (perimeter === 'maquette' || perimeter === 'controles')
            return pathReasons(perimeter, touchedFiles(repo, span.from, span.to));
        const domain = perimeter;
        const key = `${span.from}..${span.to}`;
        if (!deltaPlans.has(key)) {
            try {
                deltaPlans.set(key, planReviews({ repo, base: span.from, head: span.to, settings: reviewSettings, migrations, designDir: baseDesign, sensitive, force: [], renames: false, mode: settings.mode }));
            }
            catch (error) {
                deltaPlans.set(key, errorMessage(error));
            }
        }
        const delta = deltaPlans.get(key);
        if (typeof delta === 'string')
            return [`plan des revues du delta illisible (${delta.slice(0, 160)})`];
        const decision = delta.domains.find(d => d.domain === domain);
        if (decision?.decision === 'retained')
            return [`${domain} retenue par le plan des revues : ${decision.reason.slice(0, 160)}${decision.files.length ? ` (${decision.files.slice(0, 3).join(', ')}${decision.fileCount > 3 ? ', ...' : ''})` : ''}`];
        return [];
    };
    // The perimeters of paths of the waivers carried (delta.ts, WAIVER_PERIMETERS), read with the settings of the base.
    const pathReasons = (perimeter, files) => files.flatMap(f => {
        if (perimeter === 'controles')
            return f === CONFIG_FILE || f === LEGACY_CONFIG_FILE || f === 'package.json' ? [`${f} : configuration des contrôles ou dépendances du projet`] : [];
        if (isScreen(f, screenMatch))
            return [`${f} : écran`];
        if (f === baseDesign || f.startsWith(`${baseDesign}/`))
            return [`${f} : dossier des maquettes`];
        return LEDGER_FILES.includes(f) ? [`${f} : registre des décisions`] : [];
    });
    const targetSha = resolveCommit(repo, input.target);
    const chainReviews = reviewChain({ repo, common, target: targetSha, touches, light }, sha);
    const pick = (domain) => {
        const own = chainReviews.resolve(sha, domain);
        return own.found ? own : chainReviews.reported(domain) ?? own;
    };
    const carriedNote = (from) => (from ? `relecture reportée de ${short(from)} (diff identique)` : '');
    const fileList = (files) => `${files.length} fichier${files.length > 1 ? 's' : ''}${files.length ? ` : ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}` : ''}`;
    const howNote = (domain, p) => [
        p.how === 'carried' ? carriedNote(p.from) : '',
        p.how === 'reported' && p.reported ? `relecture ${domain} reportée de ${short(p.from)} (delta sans fichier de son périmètre : ${fileList(p.reported.files)})` : '',
        p.delta ? `relecture du delta depuis ${short(p.delta.from)} (${p.delta.files} fichier${p.delta.files > 1 ? 's' : ''})` : '',
    ].filter(Boolean).join(', ');
    // A waiver of the operator for this commit, or one he typed for an earlier commit of the branch, carried over a delta
    // outside its perimeter (closed list: never securite, the whole rule relecture, preuve, instable, captures nor
    // relecture:fidelite). His words, their
    // date, their commit and why are said. `notCarried` keeps why one was not carried, for the refusal.
    const notCarried = new Map();
    const waiverOf = (rule) => {
        const own = waiverFor(messages, rule, sha);
        if (own)
            return { at: own.message.at, reason: own.reason };
        if (NEVER_CARRIED.includes(rule)) {
            // captures, relecture:fidelite (third security review of #141): the waiver of an earlier commit is said, never carried.
            const earlier = chainReviews.chain().find(node => waiverFor(messages, rule, node.commit));
            if (earlier)
                notCarried.set(rule, `la dérogation ${rule} de ${short(earlier.commit)} n'est jamais reportée (elle reviendra avec l'empreinte du build)`);
            return null;
        }
        const carried = chainReviews.carriedWaiver(rule, commit => waiverFor(messages, rule, commit));
        if (!carried)
            return null;
        if (!carried.waiver) {
            notCarried.set(rule, `la dérogation ${rule} de ${short(carried.from)} n'est pas reportée, le delta touche son périmètre : ${carried.reasons.slice(0, 3).join(' ; ')}`);
            return null;
        }
        const differ = rule === 'controles' ? refusedGatesDiffer(carried.from) : null;
        if (differ) {
            notCarried.set(rule, `la dérogation controles de ${short(carried.from)} n'est pas reportée, les contrôles refusés ne sont pas ceux qu'elle levait : ${differ}`);
            return null;
        }
        return { at: carried.waiver.message.at, reason: carried.waiver.reason,
            carried: { from: carried.from, words: carried.waiver.line, why: `delta sans fichier de son périmètre : ${fileList(carried.files)}` } };
    };
    // controles is carried only when the checks refused at the head are among those refused at C, with the same web
    // detection (security review of #142, A2): the rule reads isWebAt (an interface file anywhere, a web dependency) and
    // the configuration of the checks at each commit, not only the paths of its perimeter. C is read as the rule reads the
    // head: its own configuration with the mandatory checks of its base kept (enforceBaseGates), the settings of the base.
    const refusedGatesAt = (commit) => {
        const web = isWebAt(repo, commit);
        const needed = web ? settings.requiredGates : settings.requiredGates.filter(g => g.source === 'config');
        let config = effective;
        if (commit !== sha) {
            const own = loadConfigAtCommit(repo, commit).config;
            const fork = targetSha ? gitRead(repo, ['merge-base', targetSha, commit]) : null;
            const atFork = fork ? loadConfigAtCommit(repo, fork) : null;
            config = atFork?.file ? enforceBaseGates(own, atFork.config).config : own;
        }
        return { web, missing: new Set(missingRequiredGates(config, needed).map(m => `${m.id} (${m.problem === 'absent' ? 'absent' : 'non obligatoire'})`)) };
    };
    const refusedGatesDiffer = (from) => {
        let atC;
        let atHead;
        try {
            atC = refusedGatesAt(from);
            atHead = refusedGatesAt(sha);
        }
        catch (error) {
            return `configuration des contrôles illisible (${errorMessage(error).slice(0, 160)})`;
        }
        const causes = [];
        if (atC.web !== atHead.web)
            causes.push(atHead.web ? `projet web à ${short(sha)}, pas à ${short(from)}` : `projet web à ${short(from)}, plus à ${short(sha)}`);
        const added = [...atHead.missing].filter(m => !atC.missing.has(m));
        if (added.length)
            causes.push(`refusés à ${short(sha)} et pas à ${short(from)} : ${added.join(', ')}`);
        return causes.length ? causes.join(' ; ') : null;
    };
    const carriedSaid = (rule, w) => (w.carried ? ` ; dérogation ${rule} reportée de ${short(w.carried.from)} : « ${w.carried.words} » (${w.at}, ${w.carried.why})` : '');
    const reviewProblems = [];
    const reviewTodo = [];
    const domainStates = [];
    for (const domain of retained) {
        const agent = `apv:${DOMAIN_REVIEWERS[domain]}`;
        const picked = pick(domain);
        const { found, from } = picked;
        const ask = `Relecture ${domain} par ${agent} sur une copie détachée à ${short(sha)} ; l'agent l'enregistre lui-même (apv review record --commit ${short(sha)} --domain ${domain} ...).`;
        const f = found?.record?.findings;
        const broken = picked.broken ? ` ; celle de ${short(picked.broken.from)} n'est pas reportée, le delta touche son périmètre : ${picked.broken.reasons.slice(0, 3).join(' ; ')}` : '';
        // fidelite below the head: said never reported (third security review of #141, M3, M4), the review of the delta offered.
        const never = !found && !light && domain === 'fidelite' ? chainReviews.deltaStart(domain) : null;
        const neverNote = never ? ` ; relecture ${domain} : jamais reportée sans relire (elle reviendra avec l'empreinte du build) ; relecture du delta possible : apv review record --delta-from ${short(never)}` : '';
        const problem = !found ? `aucune relecture enregistrée à ${short(sha)}${broken}${neverNote}`
            : found.problem || !found.record ? `relecture inutilisable (${found.problem ?? 'illisible'})`
                : f.critical > 0 || f.high > 0 ? `${f.critical} constat(s) critique(s) et ${f.high} haut(s) à ${short(from ?? sha)}` : null;
        if (!problem) {
            const note = howNote(domain, picked);
            domainStates.push({ domain, status: 'recorded', detail: `${found.record.reviewer}, critique 0, haut 0, moyen ${f.medium}, bas ${f.low}${note ? `, ${note}` : ''}`, waiver: null });
            continue;
        }
        const waiver = waiverOf(`relecture:${domain}`);
        if (waiver) {
            domainStates.push({ domain, status: 'waived', detail: `${problem}${carriedSaid(`relecture:${domain}`, waiver)}`, waiver });
            continue;
        }
        const kept = notCarried.get(`relecture:${domain}`);
        if (kept)
            reviewTodo.push(`${domain} : ${kept}.`);
        domainStates.push({ domain, status: 'missing', detail: problem, waiver: null });
        reviewProblems.push(`${domain} : ${problem}`);
        // Where a review of the delta alone may start: the review not reported, or the nearest usable one of the branch.
        const start = found && !found.problem && found.record ? null : picked.broken?.from ?? chainReviews.deltaStart(domain);
        if (start) {
            const files = touchedFiles(repo, start, sha);
            reviewTodo.push(`Relecture du delta seul ${short(start)}..${short(sha)} (${fileList(files)}) par ${agent} sur une copie détachée à ${short(sha)} : apv review record --commit ${short(sha)} --domain ${domain} --delta-from ${short(start)} ... (le rapport cite les deux commits${domain === 'fidelite' ? ` ; captures à ${short(sha)} des écrans touchés` : ''}).`);
        }
        reviewTodo.push(found && !found.problem && found.record ? `Corrige chaque constat critique ou haut de la relecture ${domain}, avec le test qui le prouve, puis fais relire le nouveau commit (${agent}).` : start ? `Ou ${ask[0].toLowerCase()}${ask.slice(1)}` : ask);
        if (templateWaiver(messages, `relecture:${domain}`, sha))
            reviewTodo.push(`${domain} : ${TEMPLATE_WAIVER_NOTE}`);
        reviewTodo.push(`Ou, pour ce domaine seul, l'opérateur tape lui-même : « ${waiverSentence(`relecture:${domain}`, sha)} »${domain === ALWAYS_REVIEWED ? ' (dérogation sur la sécurité)' : ''}.`);
    }
    const forcedNote = lane.eligible ? ` (${LANE_NAME}, domaines forcés par review.always)` : '';
    const waivedDomains = domainStates.filter(d => d.status === 'waived');
    if (lane.eligible && !retained.length)
        rules.push(outcome('relecture', 'not_applicable', `${LANE_NAME} : ${lane.reason} ; aucune relecture d'agent exigée`));
    else if (light && !retained.length)
        rules.push(outcome('relecture', 'not_applicable', `niveau ${plan.level} : ${plan.levelReason} ; aucune relecture d'agent exigée`));
    else if (reviewProblems.length)
        rules.push(outcome('relecture', 'refused', `relectures demandées par le diff${forcedNote} : ${retained.join(', ')}`, reviewProblems, reviewTodo));
    else if (waivedDomains.length) {
        const r = outcome('relecture', 'waived', `relectures enregistrées ou levées domaine par domaine par l'opérateur à ${short(sha)}${forcedNote} : ${retained.join(', ')}`
            + `${waivedDomains.some(d => d.domain === ALWAYS_REVIEWED) ? ' ; dérogation sur la sécurité' : ''}`);
        const latest = waivedDomains.map(d => d.waiver.at).sort().at(-1);
        r.waiver = { at: latest, reason: waivedDomains.map(d => `${d.domain} : ${d.waiver.reason}`).join(' ; ') };
        rules.push(r);
    }
    else
        rules.push(outcome('relecture', 'ok', `relectures enregistrées à ${short(sha)} sans constat critique ni haut${forcedNote} : ${retained.join(', ')} (${light ? `niveau ${plan.level} : ${plan.levelReason.slice(0, 200)}` : `risque ${plan.risk.level === 'faible' ? 'faible' : 'élevé'} : ${plan.risk.reason.slice(0, 200)}`})`));
    rules.at(-1).domains = domainStates;
    // captures: in a project with screens at the base, required as soon as the plan retains fidelite (a component, a
    // style, a message shown, a configuration of the styles change what a screen shows). Not applicable only to a project
    // without screens at the base (not a web project, no route the tool knows, nothing in rules.screens, no interface
    // file) that adds none: a command-line tool has nothing to capture, a first page or template added asks for them.
    // The fidelity review lifted by the operator (« dérogation relecture:fidelite » or the whole rule « dérogation relecture »)
    // with no fidelity review stored at this commit: its captures have no object. Any stored review (even with a high finding,
    // or unsealed) keeps them required: someone looked, and the captures are what proves it. They are those of the fidelity
    // review at this commit (its own, a review of the delta recorded here, or carried over a merge of the target with an
    // identical diff), never those of an earlier commit of the branch (third security review of #141, M3, M4).
    const fidelity = domainStates.find(d => d.domain === 'fidelite');
    const fidelityWaiver = !fidelity || fidelity.status === 'recorded' || reviews.has('fidelite') ? null
        : fidelity.status === 'waived' ? fidelity.waiver.reason : waiverFor(messages, 'relecture', sha)?.reason ?? null;
    const changed = changedFiles(repo, mergeBase, sha);
    const screens = changed.filter(f => isScreen(f, screenMatch));
    const addedScreens = changed.filter(f => screenLike(f, screenMatch));
    // Read only when the plan retains fidelite: a change that touches no screen has nothing to capture (#228).
    const screenVerdict = retained.includes('fidelite') ? touchesNoScreen(repo, mergeBase, sha, screenMatch) : null;
    const noScreen = screenVerdict && !screenVerdict.reasons.length ? screenVerdict : null;
    if (!addedScreens.length && !hasScreensAt(repo, mergeBase, screenMatch))
        rules.push(outcome('captures', 'not_applicable', 'projet sans écran à la base (pas un projet web, aucune route reconnue ni rules.screens, aucun fichier d\'interface) et aucun écran ajouté : rien à capturer'));
    else if (lane.eligible && !retained.includes('fidelite'))
        rules.push(outcome('captures', 'not_applicable', `${LANE_NAME} : aucun écran ni fichier d'interface, relecture de fidélité non exigée`));
    else if (!retained.includes('fidelite'))
        rules.push(outcome('captures', 'not_applicable', light ? 'fidelite non exigée : aucun écran couvert par une maquette validée' : 'relecture de fidélité non retenue par le plan des revues'));
    else if (noScreen)
        rules.push(outcome('captures', 'not_applicable', `aucun écran touché : ${noScreen.files} fichier${noScreen.files > 1 ? 's' : ''}, aucun d'interface (configuration des outils, tests, documentation non servie, aucun importé par le code)`));
    else if (fidelityWaiver)
        rules.push(outcome('captures', 'not_applicable', `fidélité levée par dérogation (${fidelityWaiver})`));
    else {
        const fidelity = pick('fidelite');
        const record = fidelity.found?.record ?? null;
        const needed = settings.captures.viewports.flatMap(v => settings.captures.themes.map(t => `${v}:${t}`));
        const have = new Set((fidelity.found?.problem ? [] : record?.captures ?? []).map(c => `${c.viewport}:${c.theme}`));
        const missing = needed.filter(n => !have.has(n));
        rules.push(missing.length
            ? outcome('captures', 'refused', `relecture de fidélité retenue${addedScreens.length ? ` (écran(s) ou fichier(s) d'interface : ${addedScreens.slice(0, 5).join(', ')}${addedScreens.length > 5 ? ', ...' : ''})` : ''}${screenVerdict?.reasons.length ? ` ; captures nécessaires : ${screenVerdict.reasons.slice(0, 5).join(' ; ')}${screenVerdict.reasons.length > 5 ? ' ; ...' : ''}` : ''}, captures attendues : ${needed.join(', ')}`, [`capture(s) absente(s) de la relecture fidelite à ${short(sha)} : ${missing.join(', ')}`], [
                `apv:qa-fidelite capture chaque écran changé ou qui utilise un fichier changé (${missing.join(', ')}), les regarde à côté de la maquette validée et les joint à sa relecture : apv review record --commit ${short(sha)} --domain fidelite --capture <largeur>:<thème>:<fichier> ...`,
            ])
            : outcome('captures', 'ok', `captures jointes à ${short(fidelity.from ?? sha)}${fidelity.from ? ` (${carriedNote(fidelity.from)})` : ''} : ${needed.join(', ')}`));
    }
    // controles: the base checks of a web project, in the configuration the proof uses (the base's, kept, and the change's).
    const required = isWebAt(repo, sha) ? settings.requiredGates : settings.requiredGates.filter(g => g.source === 'config');
    const missingGates = missingRequiredGates(effective, required);
    if (!required.length)
        rules.push(outcome('controles', 'not_applicable', 'projet sans interface web et sans contrôle requis par rules.requiredGates'));
    else if (missingGates.length) {
        rules.push(outcome('controles', 'refused', `contrôles requis : ${required.map(g => g.id).join(', ')}`, missingGates.map(m => `${m.id} (${m.command.join(' ')}) ${m.problem === 'absent' ? 'absent de .apv/config.json' : 'déclaré sans "mandatory": true'}`), [
            'Ajoute ces contrôles à .apv/config.json, obligatoires ("mandatory": true) : apv onboard --dry-run les propose ; exemple : {"id": "structure", "command": ["apv", "structure", "check"], "stage": "task", "mandatory": true}.',
            'Commite, relance la suite complète : la PR qui les ajoute se prouve avec eux.',
        ]));
    }
    else
        rules.push(outcome('controles', 'ok', `contrôles requis présents et obligatoires : ${required.map(g => g.id).join(', ')}`));
    // maquette: every screen added or changed is covered by a mockup the operator validated.
    // Mode leger: only in a project with validated mockups, and a mockup registered in the repository counts without the journal.
    const ledgers = screens.length ? [(await loadDecisionLedger(repo, mergeBase)).decisions, (await loadDecisionLedger(repo, sha)).decisions] : null;
    if (!ledgers)
        rules.push(outcome('maquette', 'not_applicable', 'aucun écran ajouté ni modifié'));
    else if (light && !mockupsOf([...ledgers[0], ...ledgers[1]]).length)
        rules.push(outcome('maquette', 'not_applicable', 'projet sans maquette validée'));
    else {
        const coverage = light ? screenCoverage(screens, [...ledgers[0], ...ledgers[1]], [], messages, anchor.key) : screenCoverage(screens, ledgers[0], ledgers[1], messages, anchor.key);
        const uncovered = coverage.filter(c => !c.mockup);
        rules.push(uncovered.length
            ? outcome('maquette', 'refused', `${screens.length} écran(s) ajouté(s) ou modifié(s)`, uncovered.map(c => c.unanchored.length
                ? `${c.file} : maquette(s) ${c.unanchored.join(', ')} de la PR, dont la validation n'est pas dans les messages de l'opérateur`
                : `${c.file} : aucune maquette validée ne le couvre (portée ou écrans de la décision)`), [
                'Fais valider la maquette de cet écran par l\'opérateur (/apv:design), puis verse-la : apv design register <fichier.html> --name <nom> --quote "<ses mots exacts>" --scope <chemin de l\'écran>.',
                'Elle compte quand ses mots exacts sont dans ses messages de la session (tapés par lui), ou quand elle est déjà sur la branche cible.',
            ])
            : outcome('maquette', 'ok', `écrans couverts : ${coverage.map(c => `${c.file} (${c.mockup.id}${c.mockup.anchor === 'operator' ? ', validée dans la session' : ''})`).join(', ')}`));
    }
    // The only way past a refusal without its correction: the operator's own words.
    for (const r of rules) {
        if (r.status !== 'refused')
            continue;
        const waiver = waiverOf(r.rule);
        if (waiver) {
            r.status = 'waived';
            r.waiver = waiver;
            r.detail += carriedSaid(r.rule, waiver);
        }
        else {
            const kept = notCarried.get(r.rule);
            if (kept)
                r.todo.push(`${kept}.`);
            if (templateWaiver(messages, r.rule, sha))
                r.todo.push(TEMPLATE_WAIVER_NOTE);
            r.todo.push(`Sans correction, seul l'opérateur peut lever ce refus, en tapant lui-même dans la session : « ${waiverSentence(r.rule, sha)} ».`);
        }
    }
    const order = new Map(MERGE_RULES.map((r, i) => [r, i]));
    rules.sort((a, b) => order.get(a.rule) - order.get(b.rule));
    return { commit: sha, target: input.target, mergeBase, ok: rules.every(r => r.status !== 'refused'), rules, lane, mode: settings.mode, level: plan.level, levelReason: plan.levelReason, warnings: [...base.warnings, ...(anchor.problem ? [anchor.problem] : [])], ci,
        ...(reduced ? { reduced } : {}), ...(releaseLane && !skip.has('preuve') ? { release: { branch: releaseLane.branch, from: releaseLane.from, taskProof: taskProof !== null } } : {}) };
}
/** Lines of a report, for the text output of `apv rules check` and of the stack commands. */
export function rulesLines(report, indent = '') {
    const label = report.mode === 'leger'
        ? { ok: 'exigée, ok', refused: 'exigée, REFUSÉ', waived: 'exigée, DÉROGATION', not_applicable: 'non exigée' }
        : { ok: 'ok', refused: 'REFUSÉ', waived: 'DÉROGATION', not_applicable: 'sans objet' };
    const lines = [`${indent}Règles avant fusion à ${short(report.commit)} (cible ${report.target}, base commune ${report.mergeBase ? short(report.mergeBase) : '?'}) :`,
        `${indent}Mode ${report.mode === 'leger' ? 'léger' : 'strict'}, niveau ${report.level} : ${report.levelReason}`,
        ...laneLines(report.lane, indent),
        ...(!report.release ? [] : report.release.taskProof
            ? [`${indent}Preuve de tâche suffit : la suite complète est exigée à la mise en ligne (apv release, ${report.release.from} vers ${report.release.branch}).`]
            : [`${indent}Suite complète exigée avant fusion malgré release : la base ne déclare aucun contrôle de stage task (la preuve de tâche ne prouverait rien).`])];
    for (const r of report.rules) {
        lines.push(`${indent}- ${r.rule} (${r.title}) : ${label[r.status]} : ${r.detail}`);
        for (const d of r.domains ?? []) {
            const said = d.status === 'recorded' ? `relecture enregistrée (${d.detail})`
                : d.status === 'waived' ? `${d.domain === ALWAYS_REVIEWED ? 'dérogation sur la sécurité' : 'dérogation'} (${d.waiver.reason}) ; ${d.detail}`
                    : `manquante : ${d.detail}`;
            lines.push(`${indent}    ${d.domain} : ${said}`);
        }
        // The domains already say the problems of the rule relecture.
        if (!r.domains?.length)
            for (const p of r.problems)
                lines.push(`${indent}    ${p}`);
        if (r.waiver)
            lines.push(`${indent}    dérogation de l'opérateur (${r.waiver.at}) : ${r.waiver.reason}${r.waiver.carried ? ` ; dérogation ${r.rule} reportée de ${short(r.waiver.carried.from)} (${r.waiver.carried.why})` : ''}`);
        if (r.status === 'refused')
            for (const t of r.todo)
                lines.push(`${indent}    à faire : ${t}`);
    }
    for (const w of report.warnings)
        lines.push(`${indent}Attention : ${w}`);
    lines.push(`${indent}${report.ok ? 'Règles respectées.' : 'Fusion refusée : corriger ce qui est REFUSÉ, puis relancer.'}`);
    return lines;
}
//# sourceMappingURL=check.js.map