import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { matches } from '../policy/policy.js';
import { resolveCommit } from '../run/git-probe.js';
import { ALWAYS_REVIEWED, PATH_CLASSES, REVIEW_DOMAINS } from './config.js';
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
        const patch = { binary: false, removed: [], added: [] };
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
                else if (line.startsWith('@@'))
                    inHunk = true;
                continue;
            }
            if (line.startsWith('@@'))
                continue;
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
};
function classify(path, input) {
    const { paths } = input.settings;
    const found = PATH_CLASSES.filter(c => paths[c].some(p => matches(path, p)) || (c === 'migrations' && input.migrations.some(p => matches(path, p))));
    return found;
}
function termIn(lines, terms) {
    for (const line of lines) {
        const low = line.toLowerCase();
        const term = terms.find(t => low.includes(t));
        if (term)
            return term;
    }
    return null;
}
function fileKeeps(file, patch, input) {
    const keeps = [];
    const add = (domain, why) => { if (!keeps.some(k => k.domain === domain))
        keeps.push({ domain, why }); };
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
    const meaningful = file.classes.filter(c => c !== 'neutral');
    if (!meaningful.length && !inDesign) {
        if (classes.has('neutral'))
            return keeps;
        for (const domain of ['fidelite', 'donnees', 'rgpd'])
            add(domain, WHY.unclassified);
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
    // The words of the changed lines: a query written in a page, a tracker or a personal field added to a component.
    const lines = patch ? [...patch.added, ...patch.removed] : [];
    if (patch?.binary !== true) {
        const data = termIn(lines, input.settings.terms.data);
        if (data)
            add('donnees', `terme de données « ${data} » dans les lignes changées`);
        const personal = termIn(lines, input.settings.terms.personal);
        if (personal)
            add('rgpd', `terme RGPD « ${personal} » dans les lignes changées`);
    }
    return keeps;
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
        counts.neutral ? count(counts.neutral, 'fichier de tests, documentation ou outillage', 'fichiers de tests, documentation ou outillage') : '',
    ].filter(Boolean).join(', ');
    if (!counts.files)
        return 'rien à relire : diff vide';
    return `rien à relire : ${scope}, aucun fichier non classé au contenu changé (${count(counts.files, 'fichier', 'fichiers')}${detail ? ` : ${detail}` : ''})`;
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
    const files = statuses.map(entry => {
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
        const base = { path: entry.path, ...(entry.from !== undefined ? { from: entry.from } : {}), status: entry.status, change, classes };
        return { ...base, keeps: fileKeeps(base, patch, input) };
    });
    const counts = {
        files: files.length,
        renames: files.filter(f => f.change === 'none' && f.from !== undefined).length,
        paths: files.filter(f => f.change === 'paths').length,
        content: files.filter(f => f.change === 'content').length,
        neutral: files.filter(f => f.change === 'content' && f.classes.length === 1 && f.classes[0] === 'neutral').length,
        unclassified: files.filter(f => f.change === 'content' && !f.classes.length).length,
    };
    const sensitive = files.filter(f => [f.path, f.from].some(p => p !== undefined && input.sensitive.some(g => matches(p, g)))).map(f => f.path);
    const domains = REVIEW_DOMAINS.map(domain => {
        if (domain === ALWAYS_REVIEWED) {
            return { domain, decision: 'retained', forced: null, fileCount: sensitive.length, files: sensitive.slice(0, FILES_SHOWN),
                reason: `toujours relue, sans exception${sensitive.length ? ` ; ${count(sensitive.length, 'fichier sensible', 'fichiers sensibles')} (chemins de la voie high)` : ''}` };
        }
        const deciding = files.filter(f => f.keeps.some(k => k.domain === domain));
        const forced = input.force.includes(domain) ? 'operator' : input.settings.always.includes(domain) ? 'config' : null;
        if (deciding.length) {
            const whys = new Map();
            for (const f of deciding) {
                const why = f.keeps.find(k => k.domain === domain).why;
                whys.set(why, (whys.get(why) ?? 0) + 1);
            }
            const reason = [...whys].map(([why, n]) => `${why} (${n})`).join(' ; ');
            return { domain, decision: 'retained', forced, reason: forced ? `${reason} ; forcée aussi par ${forced === 'operator' ? 'l\'opérateur (--force)' : 'la configuration (review.always)'}` : reason,
                fileCount: deciding.length, files: deciding.slice(0, FILES_SHOWN).map(f => f.path) };
        }
        if (forced) {
            return { domain, decision: 'retained', forced, fileCount: 0, files: [],
                reason: `forcée par ${forced === 'operator' ? 'l\'opérateur (--force)' : 'la configuration (review.always)'} ; le diff seul ne la demandait pas` };
        }
        return { domain, decision: 'skipped', forced: null, fileCount: 0, files: [], reason: skipReason(domain, counts) };
    });
    return {
        tool: 'apv review plan', base: { ref: input.base, sha: baseSha }, head: { ref: input.head, sha: headSha }, mergeBase, counts, domains,
        retained: domains.filter(d => d.decision === 'retained').map(d => d.domain),
        skipped: domains.filter(d => d.decision === 'skipped').map(d => ({ domain: d.domain, reason: d.reason })),
        files,
    };
}
//# sourceMappingURL=plan.js.map