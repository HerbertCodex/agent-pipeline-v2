import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { parseJson } from '../domain/schema.js';
import { decisionLedgerSchema, LEDGER_FILE } from '../lifecycle/decisions.js';
import { matches } from '../policy/policy.js';
import { resolveCommit } from '../run/git-probe.js';
import { ALWAYS_REVIEWED, PATH_CLASSES, REVIEW_DOMAINS } from './config.js';
import { pureRename, renameKind, renamedNames } from './rename.js';
import { AGENT_INSTRUCTIONS, CONFIG_FILES, LEDGER_FILES, LOCK_FILES, MANIFEST_FILES, PILOT_NOTES, PILOT_NOTE_EXTENSIONS, ROUTING_DIR, ROUTING_TEST_DIR, SERVED_DIR, SPEC_NOTES, TEST_DIRS, TEST_NAME, diffRisk, realAddress, } from './risk.js';
const FILES_SHOWN = 50;
const MAX_DIFF_BYTES = 512 * 1024 * 1024;
function git(repo, args) {
    try {
        return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args], {
            cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000, maxBuffer: MAX_DIFF_BYTES,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
    }
    catch (error) {
        const stderr = error.stderr?.trim();
        throw new PipelineError('REVIEW_GIT', `git ${args.slice(0, 2).join(' ')} a échoué dans ${repo} : ${stderr || errorMessage(error)}`);
    }
}
/** `git diff --name-status -z -M`: one entry per changed file, the former path of a rename kept. */
export function parseNameStatus(raw) {
    const parts = raw.split('\0');
    const out = [];
    for (let i = 0; i < parts.length;) {
        const status = parts[i++];
        if (!status)
            continue;
        if (status.startsWith('R') || status.startsWith('C')) {
            const from = parts[i++];
            const path = parts[i++];
            out.push({ status, path, from });
        }
        else
            out.push({ status, path: parts[i++] });
    }
    return out;
}
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const hunkOf = (line) => {
    const m = HUNK.exec(line);
    return m ? { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) } : null;
};
/** Unquotes a path that Git wrote in C style (`"a\tb"`); a plain path is returned as is. */
function unquote(text) {
    if (!text.startsWith('"'))
        return text;
    const body = text.slice(1, -1);
    const bytes = [];
    const map = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c !== '\\') {
            bytes.push(...Buffer.from(c, 'utf8'));
            continue;
        }
        const next = body[i + 1];
        if (/[0-7]/.test(next)) {
            bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
            i += 3;
        }
        else {
            bytes.push(map[next] ?? next.charCodeAt(0));
            i += 1;
        }
    }
    return Buffer.from(bytes).toString('utf8');
}
/** Changed lines of each file of a `--unified=0` patch, keyed by the new path (the old one for a deletion). */
export function parsePatch(raw) {
    const files = new Map();
    for (const block of raw.split(/^diff --git /m).slice(1)) {
        const lines = block.split('\n');
        let oldPath = null;
        let newPath = null;
        let renameFrom = null;
        let renameTo = null;
        const patch = { binary: false, removed: [], added: [], hunks: [] };
        let inHunk = false;
        for (const line of lines.slice(1)) {
            if (!inHunk) {
                if (line.startsWith('rename from '))
                    renameFrom = unquote(line.slice(12));
                else if (line.startsWith('rename to '))
                    renameTo = unquote(line.slice(10));
                else if (line.startsWith('--- '))
                    oldPath = line.slice(4) === '/dev/null' ? null : unquote(line.slice(4)).replace(/^a\//, '');
                else if (line.startsWith('+++ '))
                    newPath = line.slice(4) === '/dev/null' ? null : unquote(line.slice(4)).replace(/^b\//, '');
                else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))
                    patch.binary = true;
                else if (line.startsWith('@@')) {
                    inHunk = true;
                    const h = hunkOf(line);
                    if (h)
                        patch.hunks.push(h);
                }
                continue;
            }
            if (line.startsWith('@@')) {
                const h = hunkOf(line);
                if (h)
                    patch.hunks.push(h);
                continue;
            }
            if (line.startsWith('+'))
                patch.added.push(line.slice(1));
            else if (line.startsWith('-'))
                patch.removed.push(line.slice(1));
        }
        let key = renameTo ?? newPath ?? oldPath ?? renameFrom;
        if (!key) {
            // No ---/+++ lines (binary file, mode change): the header names the same path twice, `a/<p> b/<p>`.
            const header = unquote(lines[0] ?? '');
            const half = (header.length - 1) / 2;
            if (Number.isInteger(half) && header.startsWith('a/') && header.slice(half + 1).startsWith('b/') && header.slice(2, half) === header.slice(half + 3))
                key = header.slice(2, half);
        }
        if (key)
            files.set(key, patch);
    }
    return files;
}
const EXTENSIONS = /\.(?:svelte|vue|astro|ts|tsx|js|jsx|mjs|cjs|mts|cts|json|css|scss|sass|less|html|md|sql)$/;
function stripExtensions(path) {
    let out = path;
    while (EXTENSIONS.test(out))
        out = out.replace(EXTENSIONS, '');
    return out.replace(/\/index$/, '');
}
/** A path or specifier without its leading `/`, its relative prefix and its alias (`$lib/`, `@/`, `~/`, `#x/`). */
function tail(ref) {
    const parts = ref.split('/').filter(p => p !== '.' && p !== '..' && p !== '');
    if (parts.length > 1 && (/^[$~#]/.test(parts[0]) || parts[0] === '@'))
        parts.shift();
    return stripExtensions(parts.join('/'));
}
const endsWithPath = (path, suffix) => !!suffix && (path === suffix || path.endsWith(`/${suffix}`));
/**
 * Path-like tokens: at least one `/`, with the characters of file names and route folders (`(app)`, `[id]`,
 * `+page`), or a bare file name with a source extension (`applications-repository.ts` in a comment).
 */
const PATH_TOKEN = /[A-Za-z0-9_$@~.\-/[\]()+]*\/[A-Za-z0-9_$@~.\-/[\]()+]*|[A-Za-z0-9_$@~.\-+]+\.(?:svelte|vue|astro|ts|tsx|js|jsx|mjs|cjs|mts|cts|json|css|scss|sass|less|html|md|sql)\b/g;
/**
 * The same name for a reference on both sides of a change. A relative specifier is resolved from the file that
 * holds it (its former place on the old side): it becomes the renamed file it names, or the file it resolves to.
 * Any other path or specifier that names exactly one renamed file of the diff (its former location on the old side,
 * its new one on the new side; aliases such as `$lib/` or `@/` dropped) becomes that rename. Every other token
 * stays as written, so that any other change remains a change.
 */
function canonicalToken(raw, context) {
    let core = raw;
    let before = '';
    let after = '';
    const count = (text, c) => text.split(c).length - 1;
    for (;;) {
        if (core.length > 2 && core.startsWith('(') && core.indexOf(')') === core.length - 1) {
            before += '(';
            after = `)${after}`;
            core = core.slice(1, -1);
            continue;
        }
        if (/[.,;:]$/.test(core)) {
            after = core.slice(-1) + after;
            core = core.slice(0, -1);
            continue;
        }
        if (core.endsWith(')') && count(core, ')') > count(core, '(')) {
            after = `)${after}`;
            core = core.slice(0, -1);
            continue;
        }
        if (core.startsWith('(') && count(core, '(') > count(core, ')')) {
            before += '(';
            core = core.slice(1);
            continue;
        }
        break;
    }
    const at = (r) => stripExtensions(context.side === 'from' ? r.from : r.path);
    // Named by the new location of what it names: files moved together (`x.ts` and `x.svelte.ts`) stay one name.
    // The extension written in the reference stays part of its name: `./x` and `./x.svelte` are two modules.
    const written = /(?:\.(?:svelte|vue|astro|ts|tsx|js|jsx|mjs|cjs|mts|cts|json|css|scss|sass|less|html|md|sql))+$/.exec(core)?.[0] ?? '';
    const named = (found) => {
        const targets = new Set(found.map(r => stripExtensions(r.path)));
        return targets.size === 1 ? `${before}\u0001${[...targets][0]}${written}\u0001${after}` : null;
    };
    if (/^\.\.?\//.test(core)) {
        const resolved = posix.normalize(posix.join(posix.dirname(context.file), core));
        if (resolved.startsWith('../'))
            return raw;
        const target = stripExtensions(resolved);
        return named(context.renames.filter(r => at(r) === target)) ?? `${before}\u0002${target}${written}\u0002${after}`;
    }
    const t = tail(core);
    if (!t)
        return raw;
    return named(context.renames.filter(r => endsWithPath(at(r), t))) ?? raw;
}
const canonicalLine = (line, context) => line.replace(PATH_TOKEN, token => canonicalToken(token, context));
/**
 * Whitespace outside string literals normalized, and a trailing comma before a closing bracket dropped: what a
 * formatter changes when it rewraps an import, and nothing else. `full` (code and styles, where whitespace outside
 * strings means nothing) keeps a space only between two word characters; `soft` (markup: components, templates,
 * where a space between two elements shows) turns each run of whitespace into one space, never into none.
 */
function compact(text, mode) {
    let out = '';
    let quote = null;
    let space = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            out += c;
            if (c === '\\' && i + 1 < text.length) {
                out += text[++i];
                continue;
            }
            if (c === quote)
                quote = null;
            continue;
        }
        if (/\s/.test(c)) {
            space = true;
            continue;
        }
        if (/[}\])]/.test(c) && /, ?$/.test(out)) {
            out = out.replace(/, ?$/, '');
            if (mode === 'soft')
                space = true;
        }
        if (space && out && (mode === 'soft' ? !out.endsWith(' ') : /[\w$\u0001\u0002]$/.test(out) && /[\w$\u0001\u0002]/.test(c)))
            out += ' ';
        space = false;
        if (c === '"' || c === '\'' || c === '`')
            quote = c;
        out += c;
    }
    return out;
}
/** Module statements, compared as a sorted list: a move reorders the sorted imports of a file. */
const MODULE_STATEMENT = /(?:\bimport\b[^;'"`]*?\bfrom ?(['"])[^'"]*\1|\bimport ?(['"])[^'"]*\2|\bexport\b[^;'"`]*?\bfrom ?(['"])[^'"]*\3);?/g;
/** Languages where a formatter only moves insignificant whitespace (outside strings): whitespace fully compacted. */
const CODE_LANGUAGES = /\.(?:ts|js|mjs|cjs|mts|cts|css|scss|less|json)$/;
function normalized(lines, context) {
    const canonical = lines.map(l => canonicalLine(l, context)).join('\n');
    const stream = compact(canonical, CODE_LANGUAGES.test(context.file) ? 'full' : 'soft').trim();
    const statements = [];
    // Each statement leaves a mark: the rest keeps its order, the statements are compared as a sorted list.
    const rest = stream.replace(MODULE_STATEMENT, statement => { statements.push(statement.replace(/;$/, '')); return '\u0003'; })
        .replace(/ ?\u0003 ?/g, '\u0003').replace(/\u0003+/g, '\u0003');
    return [...statements.sort(), '\u0000', rest];
}
/**
 * True when the changed lines of a file only rewrite references to moved files (imports, paths in comments or
 * texts), reorder its imports or rewrap them: once each such reference is named the same way before and after,
 * the removed and added lines are identical. Any other change is a content change.
 */
export function referencesOnly(patch, file, renames) {
    if (!patch.removed.some(l => l.trim()) && !patch.added.some(l => l.trim()))
        return false;
    const a = normalized(patch.removed, { renames, file: file.from ?? file.path, side: 'from' });
    const b = normalized(patch.added, { renames, file: file.path, side: 'path' });
    return a.length === b.length && a.every((x, i) => x === b[i]);
}
const WHY = {
    migration: 'migration ou schéma touché',
    migrationRename: 'migration renommée (l\'outil de migration suit les noms de fichiers)',
    ui: 'interface au contenu changé',
    design: 'maquette validée touchée',
    data: 'données (requêtes, dépôts, modèles) au contenu changé',
    personal: 'données personnelles, export ou traceurs au contenu changé',
    legal: 'texte légal au contenu changé',
    unclassified: 'fichier non classé au contenu changé (prudence)',
    ledgerMockup: 'décision de maquette ajoutée ou modifiée au registre',
    strong: 'code serveur, chemin sensible ou configuration au contenu changé (prudence, plus fort que tests et outillage)',
};
/** Classes that keep no domain of their own: a file matching only these is not described by a domain class. */
const NO_DOMAIN = ['neutral', 'tooling', 'server'];
const sides = (file) => [file.path, ...(file.from !== undefined ? [file.from] : [])];
/** Named as a test (`*.test.*`, `*.spec.*`, `*.e2e.*`) on every side of the change. */
const testNamed = (file) => sides(file).every(p => TEST_NAME.test(p));
const isConfig = (file) => sides(file).some(p => CONFIG_FILES.some(g => matches(p, g)));
/** Sensitive paths of the high lane, and the instructions of the agents (`agents/**`, `workflows/**`, `.apv/brief.md`...). */
const isSensitive = (file, input) => sides(file).some(p => input.sensitive.some(g => matches(p, g)) || AGENT_INSTRUCTIONS.some(g => matches(p, g)));
/**
 * Under a test folder (`test/`, `tests/`), outside a routing folder (`routes/`, `pages/`, `app/`): a `tests/` folder
 * under `src/routes/` is a route, served, never a test.
 */
const inTestDir = (p) => TEST_DIRS.some(g => matches(p, g)) && !ROUTING_TEST_DIR.test(p);
/** A test by its name, or every side under a test folder. */
const testLike = (file) => testNamed(file) || sides(file).every(inTestDir);
/**
 * Server code, a sensitive path of the high lane, the instructions of the agents or a configuration: stronger than the
 * neutral and tooling classes (`src/lib/server/fixtures/admin.ts`, `.apv/config.json`, `vitest.config.ts`,
 * `src/routes/tests/+server.ts`). Only a file named as a test escapes the server and sensitive paths; nothing escapes
 * the configuration. Tooling (`fixtures/`, `__mocks__/`) outside a test folder may be imported by the product: it keeps
 * every domain too (`src/lib/fixtures/demo.ts`), and so does a neutral file under a routing folder.
 */
function strongPath(file, input) {
    if (isConfig(file))
        return true;
    if (testNamed(file))
        return false;
    if (file.classes.includes('server') || isSensitive(file, input))
        return true;
    if (testLike(file))
        return false;
    if (file.classes.includes('tooling') && !file.classes.includes('neutral'))
        return true;
    return sides(file).some(p => ROUTING_DIR.test(p));
}
function classify(path, input) {
    const { paths } = input.settings;
    const found = PATH_CLASSES.filter(c => paths[c].some(p => matches(path, p)) || (c === 'migrations' && input.migrations.some(p => matches(path, p))));
    return found;
}
/** The first term of the list found in the lines, and how many lines hold a term of the list. */
function termIn(lines, terms) {
    let first = null;
    let count = 0;
    for (const line of lines) {
        const low = line.toLowerCase();
        const term = terms.find(t => low.includes(t));
        if (!term)
            continue;
        first ??= term;
        count += 1;
    }
    return first === null ? null : { term: first, lines: count };
}
/** The names of `data-*` attributes (`data-tab`, `data-phone`): names of the markup, never a word of data or GDPR. */
const DATA_ATTRIBUTE = /(?<![\w-])data-[\w-]+/gi;
/**
 * Every side a note of the pipeline (the state, the journal, a spec ADDED; text or JSON). A spec of the base modified or
 * renamed keeps the classification of 3.0.0-alpha.20 (security review of PR #128: a security requirement removed from a
 * spec was read by the security review alone).
 */
const pilotNote = (file) => sides(file).every(p => PILOT_NOTE_EXTENSIONS.test(p) && PILOT_NOTES.some(g => matches(p, g)) && (!matches(p, SPEC_NOTES) || file.status.startsWith('A')));
/** The registry of the decisions (`.apv/DECISIONS.json` or `.md`) on every side, unless the project declares it a sensitive path. */
const ledgerFile = (file, input) => sides(file).every(p => LEDGER_FILES.includes(p)) && !isSensitive(file, input) && !isConfig(file);
/** A lockfile of npm, pnpm or Yarn on every side. */
const lockFile = (file) => sides(file).every(p => LOCK_FILES.some(g => matches(p, g)));
/** The host of a download URL in a lockfile line (`"resolved": "https://…"`, `resolved "https://…"`, `tarball: https://…`). */
const DOWNLOAD_HOST = /(?:resolved|tarball)\W+(?:https?:\/\/)([^/"'\s:]+)/gi;
function fileKeeps(file, patch, input, context) {
    const keeps = [];
    const add = (domain, why, basis = 'diff') => { if (!keeps.some(k => k.domain === domain))
        keeps.push({ domain, why, basis }); };
    const classes = new Set(file.classes);
    const inDesign = [file.path, file.from].some(p => p !== undefined && (p === input.designDir || p.startsWith(`${input.designDir}/`)));
    if (classes.has('migrations')) {
        const why = file.change === 'none' ? WHY.migrationRename : WHY.migration;
        add('donnees', why);
        add('rgpd', why);
    }
    // A mockup is the reference of the fidelity review: a renamed one is touched too.
    if (inDesign)
        add('fidelite', WHY.design);
    if (file.change !== 'content')
        return keeps;
    const meaningful = file.classes.filter(c => !NO_DOMAIN.includes(c));
    const lines = patch && !patch.binary ? [...patch.added, ...patch.removed].map(l => l.replace(DATA_ATTRIBUTE, '')) : [];
    const address = () => {
        if (realAddress(patch?.added ?? []))
            add('rgpd', 'adresse e-mail réelle (domaine non réservé aux exemples) dans les lignes ajoutées');
    };
    // The words of the changed lines: a query written in a page, a tracker, a personal field, a real address in a fixture.
    // In server, data or interface code, one line is enough: required by the diff (security review of PR #128: a query
    // deleting every profile, on one line, said « par prudence »). Only in a test, a document or tooling is a term on one
    // line alone isolated: prudence. The Markdown under `.apv/` is prose of the pipeline: its words never count.
    const terms = (isolated) => {
        if (!sides(file).every(p => p.startsWith('.apv/') && p.endsWith('.md'))) {
            const data = termIn(lines, input.settings.terms.data);
            if (data) {
                if (data.lines > 1 || !isolated)
                    add('donnees', `terme de données « ${data.term} » dans les lignes changées`);
                else
                    add('donnees', `terme de données « ${data.term} » isolé (une seule ligne changée : par prudence)`, 'prudence');
            }
            const personal = termIn(lines, input.settings.terms.personal);
            if (personal) {
                if (personal.lines > 1 || !isolated)
                    add('rgpd', `terme RGPD « ${personal.term} » dans les lignes changées`);
                else
                    add('rgpd', `terme RGPD « ${personal.term} » isolé (une seule ligne changée : par prudence)`, 'prudence');
            }
        }
        address();
    };
    if (!meaningful.length && !inDesign) {
        // The registry of the decisions: the security review, data and GDPR on their terms only (the Markdown rendering holds none).
        if (ledgerFile(file, input)) {
            if (context.ledgerMockups.length)
                add('fidelite', WHY.ledgerMockup);
            terms(false);
            return keeps;
        }
        // Notes of the pipeline: never a configuration; the security review reads them, a real address still counts.
        if (pilotNote(file) && !isSensitive(file, input) && !isConfig(file)) {
            address();
            return keeps;
        }
        // A lockfile without its package.json: the security review alone, with the audit of the dependencies.
        if (lockFile(file) && !context.manifest)
            return keeps;
        if (strongPath(file, input)) {
            // Its words first (a query in server code is required by the diff), then prudence for the rest.
            terms(false);
            for (const domain of ['fidelite', 'donnees', 'rgpd'])
                add(domain, WHY.strong, 'prudence');
            return keeps;
        }
        // Tests, documentation, tooling: no domain of their own, but their words still count (a fixture with personal data).
        if (classes.has('neutral') || classes.has('tooling')) {
            terms(true);
            return keeps;
        }
        for (const domain of ['fidelite', 'donnees', 'rgpd'])
            add(domain, WHY.unclassified, 'prudence');
        return keeps;
    }
    if (classes.has('ui'))
        add('fidelite', WHY.ui);
    if (classes.has('data'))
        add('donnees', WHY.data);
    if (classes.has('personal'))
        add('rgpd', WHY.personal);
    if (classes.has('legal'))
        add('rgpd', WHY.legal);
    terms(false);
    return keeps;
}
/**
 * A decision that tells what a screen must look like: a registered mockup (`maquette-<nom>-validee`), a decision naming
 * screens (`Écrans :`) or a perimeter of paths, or one that names the folder of the mockups.
 */
function mockupLike(decision, designDir) {
    const text = `${decision.subject}\n${decision.value}`;
    return /^maquette-/.test(decision.id) || /Écrans\s*:/.test(text) || (decision.scope?.paths?.length ?? 0) > 0 || text.includes(`${designDir}/`);
}
/**
 * Ids of the mockup decisions the change adds, removes or alters (a screen added to a validated mockup, a status, a
 * perimeter): read from the registry at both sides of the diff, never from its words. A registry that cannot be read is
 * said as such: the fidelity review is kept (review of PR #129: a registry alone retargeting a mockup kept security only).
 */
function ledgerMockupChanges(repo, mergeBase, head, designDir) {
    const read = (sha) => {
        let text;
        try {
            text = git(repo, ['show', `${sha}:${LEDGER_FILE}`]);
        }
        catch {
            return new Map();
        }
        try {
            return new Map(decisionLedgerSchema.parse(parseJson(text)).decisions.map(d => [d.id, d]));
        }
        catch {
            return null;
        }
    };
    const before = read(mergeBase);
    const after = read(head);
    if (!before || !after)
        return ['(registre illisible)'];
    const changed = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
        const a = before.get(id);
        const b = after.get(id);
        if (JSON.stringify(a) === JSON.stringify(b))
            continue;
        if ((a && mockupLike(a, designDir)) || (b && mockupLike(b, designDir)))
            changed.push(id);
    }
    return changed;
}
const SENSITIVE_WHY = 'chemin sensible (authentification, session, permissions, dépendances, configuration de sécurité, CI ou instructions des agents)';
const LEDGER_WHY = 'registre des décisions : la relecture sécurité lit chaque décision, données et RGPD seulement sur leurs termes';
const NOTES_WHY = 'notes de pilotage (.apv/state, journal du pipeline, specs) : jamais une configuration';
const LOCK_WHY = 'verrou de dépendances sans son package.json : audit des dépendances par la relecture sécurité';
/**
 * The risk of one changed file (src/review/risk.ts), by its path only: low for a test, documentation or a mockup
 * without a word of data or GDPR; high for everything else (the plan of 3.0.0-alpha.14). The notes of the pipeline and a
 * lockfile without its package.json stay of high risk (a lockfile can break the build), under their own name.
 */
function fileRisk(file, input, context) {
    const high = (riskWhy) => ({ risk: 'eleve', riskWhy });
    const low = (riskWhy) => ({ risk: 'faible', riskWhy });
    const classes = new Set(file.classes);
    if (classes.has('migrations'))
        return high('migration ou schéma');
    const plain = !file.classes.some(c => !NO_DOMAIN.includes(c));
    if (plain && lockFile(file) && !context.manifest)
        return high(LOCK_WHY);
    if (isConfig(file))
        return high('configuration (outil, exécuteurs de tests, lint, format, dépendances, CI)');
    const named = testNamed(file);
    if (!named && isSensitive(file, input))
        return high(SENSITIVE_WHY);
    if (plain && pilotNote(file))
        return high(NOTES_WHY);
    if (plain && ledgerFile(file, input))
        return high(LEDGER_WHY);
    if (!named && classes.has('server'))
        return high('code serveur ou configuration');
    // A word of data or GDPR, or a real address, in the changed lines: stronger than a test or a document.
    const word = file.keeps.find(k => (k.domain === 'donnees' || k.domain === 'rgpd') && (k.why.startsWith('terme ') || k.why.startsWith('adresse ')));
    if (word)
        return high(word.why);
    // Every domain a low file keeps is the fidelity of a mockup: any other kept domain makes the file high, so that a
    // plan of low risk never retains more (REVIEW_RISK can never fire on a valid diff).
    const other = file.keeps.find(k => k.domain !== 'fidelite' || k.why !== WHY.design);
    if (other)
        return high(other.why);
    if (testLike(file))
        return low('tests');
    // A validated mockup (never served): its fidelity review is kept by fileKeeps.
    const design = (p) => p === input.designDir || p.startsWith(`${input.designDir}/`);
    if (sides(file).every(design) && !classes.has('legal') && !classes.has('personal') && !classes.has('data'))
        return low('maquette');
    if (classes.has('legal') || classes.has('personal') || classes.has('data') || classes.has('ui')) {
        return high(classes.has('ui') ? 'interface (le contenu n\'est jamais lu comme du texte seul)' : 'données, données personnelles ou texte légal');
    }
    // Documentation: Markdown the project classes neutral (docs/, README, CHANGELOG), outside the served folders.
    if (classes.has('neutral') && sides(file).every(p => p.endsWith('.md') && !SERVED_DIR.test(p)))
        return low('documentation');
    return high(classes.has('tooling') || classes.has('neutral')
        ? 'outillage ou fichier neutre hors tests nommés, dossiers de tests, documentation et maquettes'
        : 'fichier non classé (prudence)');
}
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function skipReason(domain, counts) {
    const scope = {
        fidelite: 'aucun fichier d\'interface ni maquette validée touché au contenu changé',
        donnees: 'aucune migration ni schéma touché, aucun fichier de données au contenu changé, aucun terme de données dans les lignes changées',
        rgpd: 'aucune migration touchée, aucun fichier de données personnelles, d\'export, de traceur ni texte légal au contenu changé, aucun terme RGPD dans les lignes changées',
        securite: '',
    }[domain];
    const detail = [
        counts.renames ? count(counts.renames, 'renommage pur', 'renommages purs') : '',
        counts.paths ? count(counts.paths, 'fichier aux seuls chemins réécrits', 'fichiers aux seuls chemins réécrits') : '',
        counts.names ? count(counts.names, 'fichier aux seuls noms de classes ou d\'identifiants renommés', 'fichiers aux seuls noms de classes ou d\'identifiants renommés') : '',
        counts.neutral ? count(counts.neutral, 'fichier de tests, documentation ou outillage', 'fichiers de tests, documentation ou outillage') : '',
        counts.notes ? count(counts.notes, 'note de pilotage', 'notes de pilotage') : '',
        counts.ledger ? count(counts.ledger, 'fichier du registre des décisions', 'fichiers du registre des décisions') : '',
        counts.locks ? count(counts.locks, 'verrou de dépendances', 'verrous de dépendances') : '',
    ].filter(Boolean).join(', ');
    if (!counts.files)
        return 'rien à relire : diff vide';
    const rename = domain === 'fidelite' && counts.names ? 'renommage pur : diff normalisé vide (noms de classes et d\'identifiants renommés partout, styles compris) ; ' : '';
    return `${rename || 'rien à relire : '}${scope}, aucun fichier non classé au contenu changé (${count(counts.files, 'fichier', 'fichiers')}${detail ? ` : ${detail}` : ''})`;
}
export function planReviews(input) {
    const { repo } = input;
    const baseSha = resolveCommit(repo, input.base);
    if (!baseSha)
        throw new PipelineError('REVIEW_REF', `--base : commit introuvable dans ${repo} : ${input.base}`);
    const headSha = resolveCommit(repo, input.head);
    if (!headSha)
        throw new PipelineError('REVIEW_REF', `--head : commit introuvable dans ${repo} : ${input.head}`);
    const mergeBase = git(repo, ['merge-base', baseSha, headSha]).trim();
    // Explicit options: a user's diff settings (no prefix, relative paths, colors, external tools) never change the reading.
    const common = ['-M', '--no-relative', '--no-ext-diff', '--no-textconv', '--no-color'];
    const statuses = parseNameStatus(git(repo, ['diff', ...common, '--name-status', '-z', mergeBase, headSha]));
    const patches = parsePatch(git(repo, ['diff', ...common, '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', mergeBase, headSha]));
    const renames = statuses.filter(s => s.from !== undefined).map(s => ({ from: s.from, path: s.path }));
    const changes = statuses.map((entry) => {
        const patch = patches.get(entry.path);
        let change;
        if (/^R100$/.test(entry.status))
            change = 'none';
        else if (!patch)
            change = 'content';
        else if (patch.binary)
            change = 'content';
        // A mode change only (no line changed) of a file that stays: nothing to read beyond the security review.
        else if (!patch.added.length && !patch.removed.length)
            change = /^[MT]/.test(entry.status) || /^R/.test(entry.status) ? 'none' : 'content';
        else
            change = referencesOnly(patch, entry, renames) ? 'paths' : 'content';
        const classes = [...new Set([...classify(entry.path, input), ...(entry.from ? classify(entry.from, input) : [])])]
            .sort((a, b) => PATH_CLASSES.indexOf(a) - PATH_CLASSES.indexOf(b));
        return { entry, patch, change, classes };
    });
    // Class and id names renamed: a pure rename only when the whole diff renames them one to one (src/review/rename.ts),
    // in files of interface, style or tests, and when nothing but documentation and notes of the pipeline changes beside.
    const shapes = changes.map(c => ({ path: c.entry.path, ...(c.entry.from !== undefined ? { from: c.entry.from } : {}), status: c.entry.status, change: c.change, classes: c.classes }));
    const renameable = shapes.map(f => sides(f).every(p => renameKind(p) || TEST_NAME.test(p) || inTestDir(p))
        && !isConfig(f) && !isSensitive(f, input) && !f.classes.some(c => c !== 'ui' && c !== 'neutral' && c !== 'tooling'));
    const harmless = (f, i) => f.change === 'none' || renameable[i]
        || (pilotNote(f) && !isSensitive(f, input) && !isConfig(f))
        || (f.classes.length > 0 && f.classes.every(c => c === 'neutral' || c === 'tooling') && !strongPath(f, input));
    const candidates = changes.map((c, i) => (renameable[i] && c.change === 'content' && c.patch && !c.patch.binary && /^[MR]/.test(c.entry.status) ? renamedNames(c.patch, c.entry.path) : null));
    const named = candidates.filter((c) => c !== null);
    if (named.length && shapes.every(harmless) && pureRename(named, { repo, base: mergeBase, head: headSha, designDir: input.designDir })) {
        candidates.forEach((c, i) => { if (c)
            changes[i].change = 'names'; });
    }
    const ledgerTouched = statuses.some(s => s.path === LEDGER_FILE || s.from === LEDGER_FILE);
    const context = {
        manifest: statuses.some(s => sides(s).some(p => MANIFEST_FILES.some(g => matches(p, g)))),
        ledgerMockups: ledgerTouched ? ledgerMockupChanges(repo, mergeBase, headSha, input.designDir) : [],
    };
    const files = changes.map(({ entry, patch, change, classes }) => {
        const base = { path: entry.path, ...(entry.from !== undefined ? { from: entry.from } : {}), status: entry.status, change, classes };
        const keeping = { ...base, keeps: fileKeeps(base, patch, input, context) };
        return { ...keeping, ...fileRisk(keeping, input, context) };
    });
    const counts = {
        files: files.length,
        renames: files.filter(f => f.change === 'none' && f.from !== undefined).length,
        paths: files.filter(f => f.change === 'paths').length,
        names: files.filter(f => f.change === 'names').length,
        content: files.filter(f => f.change === 'content').length,
        neutral: files.filter(f => f.change === 'content' && f.classes.every(c => NO_DOMAIN.includes(c)) && (f.classes.includes('neutral') || f.classes.includes('tooling'))
            && !f.keeps.some(k => k.why === WHY.strong) && f.riskWhy !== NOTES_WHY && f.riskWhy !== LEDGER_WHY && f.riskWhy !== LOCK_WHY).length,
        notes: files.filter(f => f.change === 'content' && f.riskWhy === NOTES_WHY).length,
        ledger: files.filter(f => f.change === 'content' && f.riskWhy === LEDGER_WHY).length,
        locks: files.filter(f => f.change === 'content' && f.riskWhy === LOCK_WHY).length,
        unclassified: files.filter(f => f.change === 'content' && f.keeps.some(k => k.why === WHY.unclassified || k.why === WHY.strong)).length,
    };
    const risk = diffRisk(files, FILES_SHOWN);
    const sensitive = files.filter(f => [f.path, f.from].some(p => p !== undefined && input.sensitive.some(g => matches(p, g)))).map(f => f.path);
    const locks = files.filter(f => f.riskWhy === LOCK_WHY).map(f => f.path);
    // A download host that a lockfile names now and did not name at the base (security review of PR #128: a lockfile alone
    // whose `resolved` points elsewhere). Said to the security review; nothing is skipped or kept for it.
    const hostsOf = (lines) => new Set(lines.flatMap(l => [...l.matchAll(DOWNLOAD_HOST)].map(m => m[1].toLowerCase())));
    const newHosts = [...new Set(files.filter(f => lockFile(f) && f.change === 'content').flatMap(f => {
            let before = [];
            try {
                before = git(repo, ['show', `${mergeBase}:${f.from ?? f.path}`]).split('\n');
            }
            catch {
                before = [];
            }
            const known = hostsOf(before);
            return [...hostsOf(patches.get(f.path)?.added ?? [])].filter(h => !known.has(h));
        }))];
    const domains = REVIEW_DOMAINS.map(domain => {
        if (domain === ALWAYS_REVIEWED) {
            return { domain, decision: 'retained', forced: null, basis: 'diff', fileCount: sensitive.length, files: sensitive.slice(0, FILES_SHOWN),
                reason: `toujours relue, sans exception${sensitive.length ? ` ; ${count(sensitive.length, 'fichier sensible', 'fichiers sensibles')} (chemins de la voie high)` : ''}`
                    + `${locks.length ? ` ; verrou de dépendances sans son package.json (${locks.slice(0, 3).join(', ')}) : audit des dépendances (npm audit ou équivalent)` : ''}`
                    + `${newHosts.length ? ` ; hôte de téléchargement nouveau dans le verrou : ${newHosts.slice(0, 5).join(', ')} (vérifier la provenance)` : ''}` };
        }
        const deciding = files.filter(f => f.keeps.some(k => k.domain === domain));
        const forced = input.force.includes(domain) ? 'operator' : input.settings.always.includes(domain) ? 'config' : null;
        if (deciding.length) {
            const whys = new Map();
            const kept = deciding.map(f => f.keeps.find(k => k.domain === domain));
            for (const k of kept)
                whys.set(k.why, (whys.get(k.why) ?? 0) + 1);
            const reason = [...whys].map(([why, n]) => `${why} (${n})`).join(' ; ');
            return { domain, decision: 'retained', forced, basis: forced || kept.some(k => k.basis === 'diff') ? 'diff' : 'prudence',
                reason: forced ? `${reason} ; forcée aussi par ${forced === 'operator' ? 'l\'opérateur (--force)' : 'la configuration (review.always)'}` : reason,
                fileCount: deciding.length, files: deciding.slice(0, FILES_SHOWN).map(f => f.path) };
        }
        if (forced) {
            return { domain, decision: 'retained', forced, basis: 'diff', fileCount: 0, files: [],
                reason: `forcée par ${forced === 'operator' ? 'l\'opérateur (--force)' : 'la configuration (review.always)'} ; le diff seul ne la demandait pas` };
        }
        return { domain, decision: 'skipped', forced: null, basis: null, fileCount: 0, files: [], reason: skipReason(domain, counts) };
    });
    // A low risk keeps at most the security and fidelity reviews, besides what is forced: never a weaker plan elsewhere.
    if (risk.level === 'faible') {
        const extra = domains.filter(d => d.decision === 'retained' && d.domain !== ALWAYS_REVIEWED && d.domain !== 'fidelite' && !d.forced);
        if (extra.length)
            throw new PipelineError('REVIEW_RISK', `risque faible incohérent : ${extra.map(d => d.domain).join(', ')} retenu(s) (${extra.map(d => d.reason).join(' ; ')})`);
    }
    return {
        tool: 'apv review plan', base: { ref: input.base, sha: baseSha }, head: { ref: input.head, sha: headSha }, mergeBase, counts, ledgerMockups: context.ledgerMockups, risk, domains,
        retained: domains.filter(d => d.decision === 'retained').map(d => d.domain),
        skipped: domains.filter(d => d.decision === 'skipped').map(d => ({ domain: d.domain, reason: d.reason })),
        files,
    };
}
//# sourceMappingURL=plan.js.map