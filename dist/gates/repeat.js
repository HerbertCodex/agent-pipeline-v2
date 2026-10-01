import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../domain/errors.js';
import { matches } from '../policy/policy.js';
/** Placeholder of the number of repetitions, replaced anywhere in an argument (`--repeat-each={{repeat}}`). */
export const REPEAT_PLACEHOLDER = '{{repeat}}';
/** The refusal of a full run whose reference does not resolve: the changes would be counted from `--base` alone. */
export function referenceMissing(gateId, name, detail = 'introuvable') {
    return `${gateId} : référence ${name} ${detail} (repeatChanged.reference) : une suite complète compte les tests modifiés depuis la branche où va le changement, ` +
        `jamais depuis --base seule. Récupérer la référence (git fetch) ou corriger repeatChanged.reference dans .apv/config.json (par exemple "origin/main").`;
}
/** Most fixed waits listed for one check. */
const MAX_FIXED_WAITS = 100;
/**
 * Waits on a duration rather than on an observable fact: Playwright `waitForTimeout(`, a `sleep(` or `delay(` helper,
 * `await setTimeout(` (`node:timers/promises`), and the `new Promise(r => setTimeout(r, ...))` idiom (type argument
 * and a line break or two included). Lines that are only a comment are ignored.
 */
const FIXED_WAIT = [/\.waitForTimeout\s*\(/, /(?<![.\w$])(?:sleep|delay)\s*\(/, /\bawait\s+(?:[\w$]+\.)?setTimeout\s*\(/];
const PROMISE_TIMEOUT = /new\s+Promise\s*(?:<[^>]*>\s*)?\(\s*(?:\((?:[^()]|\([^()]*\))*\)|[\w$]+)\s*=>\s*\{?\s*(?:[\w$]+\.)?setTimeout\s*\(/;
const isComment = (code) => code.startsWith('//') || code.startsWith('*') || code.startsWith('/*');
export function fixedWaitIn(line) {
    const code = line.trim();
    if (isComment(code))
        return false;
    return FIXED_WAIT.some(re => re.test(code)) || PROMISE_TIMEOUT.test(code);
}
/**
 * The fixed waits of consecutive lines: each line alone, and a `new Promise(` joined with the (at most three)
 * following consecutive lines, so that `new Promise(resolve =>` / `setTimeout(resolve, 100))` is found on its first line.
 */
export function fixedWaitLines(lines) {
    const found = [];
    lines.forEach((l, i) => {
        const code = l.text.trim();
        if (isComment(code))
            return;
        if (fixedWaitIn(code)) {
            found.push(l);
            return;
        }
        if (!/new\s+Promise\b/.test(code))
            return;
        let joined = code;
        for (let k = i + 1; k < Math.min(lines.length, i + 4) && lines[k].line === lines[k - 1].line + 1; k++) {
            const next = lines[k].text.trim();
            if (isComment(next))
                continue;
            joined += ` ${next}`;
            if (PROMISE_TIMEOUT.test(joined)) {
                found.push(l);
                return;
            }
        }
    });
    return found;
}
/**
 * Lines added by a unified diff with no context (`-U0`), with their number in the new file. Only the lines inside
 * a hunk count, so an added line `++i;` (`+++i;` in the diff) is a line, never the `+++ b/<file>` header.
 */
export function addedLines(diff) {
    const out = [];
    let next = 0;
    for (const raw of diff.split('\n')) {
        if (raw.startsWith('diff --git ')) {
            next = 0;
            continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk) {
            next = Number(hunk[1]);
            continue;
        }
        if (next === 0)
            continue;
        if (raw.startsWith('+')) {
            out.push({ line: next, text: raw.slice(1) });
            next += 1;
        }
    }
    return out;
}
/** The canonical form of a module path in an import: every path is the same, only the path may change. */
const PATH = '\u0000chemin\u0000';
const SPECIFIER = String.raw `(?<q>['"])(?:(?!\k<q>)[^\n\\])+\k<q>`;
/** Names of an import clause, whatever the layout (Prettier over several lines, trailing comma). */
const clauseOf = (text) => text.replace(/\s+/g, '').replace(/,(?=[}\]])/g, '');
const IMPORT_FROM = new RegExp(String.raw `\b(import|export)(\s+type\b)?\s*([^;'"\`]*?)\s*\bfrom\s*${SPECIFIER}(\s*(?:with|assert)\s*\{[^}]*\})?\s*;?`, 'g');
const SIDE_EFFECT = new RegExp(String.raw `\bimport\s*${SPECIFIER}\s*;?`, 'g');
const MOCK = new RegExp(String.raw `\b((?:vi|jest)\s*\.\s*(?:mock|doMock|unmock|doUnmock|importActual|importMock|requireActual|requireMock))\s*\(\s*${SPECIFIER}`, 'g');
const DYNAMIC = new RegExp(String.raw `\bimport\s*\(\s*${SPECIFIER}\s*\)`, 'g');
/**
 * A test file with every module path of its imports replaced by the same placeholder, and each import statement put
 * on one line: static `import` (and `import type`), `export ... from`, side-effect `import '...'`, `vi.mock('...')`
 * (`jest.mock`, `importActual`...), `import('...')` with a literal. The names imported, the order of the statements and
 * every other line stay as they are.
 */
export function withoutImportPaths(text) {
    return text
        .replace(IMPORT_FROM, (_m, keyword, type, clause, _q, attributes) => `${keyword}${type ? ' type' : ''} ${clauseOf(clause)} from ${PATH}${attributes ? clauseOf(attributes) : ''};`)
        .replace(SIDE_EFFECT, `import ${PATH};`)
        .replace(MOCK, (_m, call) => `${call.replace(/\s+/g, '')}(${PATH}`)
        .replace(DYNAMIC, `import(${PATH})`);
}
/** Only the paths of the imports differ (a module moved or renamed): the names imported and every other line are the same. */
export function onlyImportPathsChanged(before, after) {
    return before !== after && withoutImportPaths(before) === withoutImportPaths(after);
}
/** A character of a path: a cited path never continues with one (nor starts after one, apart from `./` and `../`). */
const PATH_CHAR = String.raw `[\p{L}\p{N}_\-@$~+%/\\]`;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The forms under which a test cites a renamed file, old -> new: the full path, and each shorter suffix (cut on a `/`)
 * that still begins inside the folder both paths share (`docs/design/x.html` -> `docs/design/produit/x.html`: also
 * `design/x.html` -> `design/produit/x.html`, never `x.html` -> `produit/x.html`, which names no folder). A form
 * without any `/` (a file at the root: a bare name could be an identifier or a word) is never one; a form two renames
 * would replace differently is dropped.
 */
export function renamedPathForms(renames) {
    const forms = new Map();
    for (const { from, to } of renames) {
        if (!from || !to || from === to)
            continue;
        const a = from.split('/');
        const b = to.split('/');
        let common = 0;
        while (common < a.length - 1 && common < b.length - 1 && a[common] === b[common])
            common++;
        for (let cut = 0; cut === 0 || cut < common; cut++) {
            const old = a.slice(cut).join('/');
            const next = b.slice(cut).join('/');
            if (!old.includes('/'))
                continue;
            forms.set(old, forms.has(old) && forms.get(old) !== next ? null : next);
        }
    }
    return new Map([...forms].filter((entry) => entry[1] !== null));
}
/**
 * Where a text is prose rather than code, character by character: inside a string literal (`'…'`, `"…"`, a template
 * `` `…` `` outside its `${…}`) or a comment (`//`, `/* … *\/`, `<!-- … -->`, `#` at the start of a line or after a
 * space). A lexical reading, not a parser: regular expression literals are skipped after an operator or a bracket; a
 * quote left open ends with its line. Only there may a cited path be replaced: never an identifier, never `a/b` in code.
 */
export function textRegions(text) {
    const mask = new Uint8Array(text.length);
    let state = 'code';
    // Template literals and the code of their `${…}`, with the depth of braces inside that code.
    const stack = [];
    let depth = 0;
    let last = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1] ?? '';
        if (state === 'line') {
            if (c === '\n')
                state = 'code';
            else
                mask[i] = 1;
            continue;
        }
        if (state === 'block') {
            if (c === '*' && next === '/') {
                state = 'code';
                i++;
            }
            else
                mask[i] = 1;
            continue;
        }
        if (state === 'html') {
            if (text.startsWith('-->', i)) {
                state = 'code';
                i += 2;
            }
            else
                mask[i] = 1;
            continue;
        }
        if (state === 'single' || state === 'double') {
            if (c === '\n' || c === (state === 'single' ? "'" : '"')) {
                state = 'code';
                last = c;
                continue;
            }
            mask[i] = 1;
            if (c === '\\' && next !== '\n') {
                mask[i + 1] = 1;
                i++;
            }
            continue;
        }
        if (state === 'template') {
            if (c === '`') {
                state = 'code';
                last = c;
                continue;
            }
            if (c === '$' && next === '{') {
                stack.push({ depth });
                depth = 0;
                state = 'code';
                i++;
                last = '{';
                continue;
            }
            mask[i] = 1;
            if (c === '\\') {
                mask[i + 1] = 1;
                i++;
            }
            continue;
        }
        // Code.
        if (c === '/' && next === '/') {
            state = 'line';
            i++;
            continue;
        }
        if (c === '/' && next === '*') {
            state = 'block';
            i++;
            continue;
        }
        if (text.startsWith('<!--', i)) {
            state = 'html';
            i += 3;
            continue;
        }
        if (c === '#' && (next === '' || /[\s!]/.test(next)) && (i === 0 || /\s/.test(text[i - 1]))) {
            state = 'line';
            continue;
        }
        if (c === "'") {
            state = 'single';
            continue;
        }
        if (c === '"') {
            state = 'double';
            continue;
        }
        if (c === '`') {
            state = 'template';
            continue;
        }
        if (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last))) {
            // A regular expression literal: skipped to its closing slash (outside a class), or to the end of the line.
            let inClass = false;
            let j = i + 1;
            for (; j < text.length && text[j] !== '\n'; j++) {
                const r = text[j];
                if (r === '\\') {
                    j++;
                    continue;
                }
                if (r === '[')
                    inClass = true;
                else if (r === ']')
                    inClass = false;
                else if (r === '/' && !inClass)
                    break;
            }
            i = j;
            last = '/';
            continue;
        }
        if (c === '{')
            depth++;
        if (c === '}') {
            if (depth === 0 && stack.length) {
                depth = stack.pop().depth;
                state = 'template';
                continue;
            }
            depth = Math.max(0, depth - 1);
        }
        if (!/\s/.test(c))
            last = c;
    }
    return mask;
}
export function renamedPaths(renames) {
    const forms = renamedPathForms(renames);
    if (!forms.size)
        return { forms, pattern: null };
    const alternatives = [...forms.keys()].sort((x, y) => y.length - x.length).map(escapeRegex).join('|');
    return { forms, pattern: new RegExp(String.raw `(?<!${PATH_CHAR}|\.)((?:\.{1,2}/)*)(${alternatives})(?!${PATH_CHAR}|\.${PATH_CHAR}|\.\.)`, 'gu') };
}
/**
 * A line with each cited form of a renamed file replaced by its new form, in one pass (a chain of renames is never
 * applied twice): a whole path only, optionally after `./` or `../`, never inside a longer path or name, and only where
 * `region` marks the characters as text (a string or a comment; every character when absent).
 */
export function withRenamedPaths(line, paths, region) {
    if (!paths.pattern)
        return line;
    const inText = (from, to) => { if (!region)
        return true; for (let k = from; k < to; k++)
        if (!region[k])
            return false; return true; };
    return line.replace(paths.pattern, (match, prefix, path, offset) => inText(offset, offset + match.length) ? `${prefix}${paths.forms.get(path)}` : match);
}
/**
 * Only cited paths of renamed files (and the paths of imports) differ: the two texts, imports put in their canonical
 * form, have the same number of lines, and each line that differs becomes the new one once the old paths of the
 * renamed files are replaced by the new ones inside its strings and comments (`withRenamedPaths`). Lines are paired
 * in order: a line added, removed or changed in any other way is a change. The content of each renamed file is the
 * same at both paths; which file a cited path resolves to at run time (the folder it is read from) is not known.
 */
export function onlyRenamedPathsChanged(before, after, renames) {
    if (before === after)
        return false;
    const paths = Array.isArray(renames) ? renamedPaths(renames) : renames;
    if (!paths.pattern)
        return false;
    const old = withoutImportPaths(before);
    const regions = textRegions(old);
    const a = old.split('\n');
    const b = withoutImportPaths(after).split('\n');
    if (a.length !== b.length)
        return false;
    let moved = false;
    let start = 0;
    for (let i = 0; i < a.length; start += a[i].length + 1, i++) {
        if (a[i] === b[i])
            continue;
        if (withRenamedPaths(a[i], paths, regions.subarray(start, start + a[i].length)) !== b[i])
            return false;
        moved = true;
    }
    return moved;
}
/** The commit `ref` names, or null when it does not resolve (no remote, reference absent). */
export async function resolveRef(git, repo, ref) {
    try {
        return (await git.exec(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
    }
    catch {
        return null;
    }
}
/**
 * The commit a configured reference names (`repeatChanged.reference`, `skipWhenOnly.reference`), by its full ref only:
 * `refs/remotes/<name>`, `refs/heads/<name>`, `refs/tags/<name>` and `refs/<name>` are listed (`git for-each-ref`), and
 * the name is refused when none or more than one exist (a local branch or a tag `origin/main` never hides the
 * remote-tracking one: both exist, the name is ambiguous). A full ref (`refs/...`) or a full commit id is taken as is.
 */
export async function resolveReference(git, repo, name) {
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(name)) {
        const sha = await resolveRef(git, repo, name);
        return { sha, ref: null, reason: sha ? '' : 'introuvable' };
    }
    const candidates = name.startsWith('refs/') ? [name] : [`refs/remotes/${name}`, `refs/heads/${name}`, `refs/tags/${name}`, `refs/${name}`];
    let listed;
    try {
        listed = (await git.exec(repo, ['for-each-ref', '--format=%(refname)', ...candidates])).split('\n').map(l => l.trim()).filter(Boolean);
    }
    catch {
        return { sha: null, ref: null, reason: 'illisible (git for-each-ref)' };
    }
    const found = [...new Set(listed.filter(r => candidates.includes(r)))];
    if (!found.length)
        return { sha: null, ref: null, reason: 'introuvable' };
    if (found.length > 1)
        return { sha: null, ref: null, reason: `ambiguë (${found.join(', ')} existent : donner la référence complète, par exemple refs/remotes/${name})` };
    const sha = await resolveRef(git, repo, found[0]);
    return { sha, ref: found[0], reason: sha ? '' : 'introuvable' };
}
/** The merge base of `a` and `b`; `a` itself without a common ancestor (unrelated histories: everything counts). */
export async function mergeBase(git, repo, a, b) {
    try {
        return (await git.exec(repo, ['merge-base', a, b])).trim() || a;
    }
    catch {
        return a;
    }
}
/**
 * The test files to repeat: added or modified since the merge base of `base` (and of `reference`, when given) with
 * `head`, those matching one of the globs `paths`, sorted; deleted files never. Without `head`, against the working
 * tree (a task run may have uncommitted tests), untracked files not ignored included; with `head` (a commit), its
 * committed content only (`apv gates verify`, `apv stack batch`). Also the fixed waits in the lines they add (a new
 * file: every line), unless `fixedWaits` is off.
 */
export async function planRepeat(git, repo, bases, settings, head) {
    const tip = head ?? 'HEAD';
    const base = await mergeBase(git, repo, bases.base, tip);
    const reference = bases.reference ? await mergeBase(git, repo, bases.reference, tip) : null;
    const from = [...new Set([base, ...(reference ? [reference] : [])])];
    const diffArgs = (mb) => ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', mb, ...(head ? [head] : [])];
    // File -> the merge bases it changed from, and where it was at each (a rename or a move by Git keeps its old path).
    const changedFrom = new Map();
    // Merge base -> the files renamed since it without any change (same blob, same mode): the paths a test may cite.
    const renamedFrom = new Map();
    for (const mb of from) {
        const renames = new Map();
        const identical = [];
        // `--raw`: modes and blobs of both sides (a new side read from the working tree has no blob: hashed below).
        const raw = (await git.exec(repo, ['diff', '--no-ext-diff', '--no-textconv', '-M', '--raw', '--no-abbrev', '-z', mb, ...(head ? [head] : []), '--'])).split('\0');
        for (let i = 0; i < raw.length;) {
            const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(raw[i] ?? '');
            if (!meta) {
                i++;
                continue;
            }
            const [, oldMode, newMode, oldBlob, newBlob, code] = meta;
            if (code !== 'R' && code !== 'C') {
                i += 2;
                continue;
            }
            const was = raw[i + 1];
            const now = raw[i + 2];
            i += 3;
            if (code !== 'R' || !was || !now)
                continue;
            renames.set(now, was);
            if (oldMode !== newMode || oldMode === '120000' || !/^100(?:644|755)$/.test(oldMode))
                continue;
            let blob = newBlob;
            if (/^0+$/.test(blob)) {
                if (head)
                    continue;
                try {
                    blob = (await git.exec(repo, ['hash-object', '--', now])).trim();
                }
                catch {
                    continue;
                }
            }
            if (blob === oldBlob)
                identical.push({ from: was, to: now });
        }
        renamedFrom.set(mb, renamedPaths(identical));
        for (const path of (await git.exec(repo, [...diffArgs(mb), '--diff-filter=AM', '--name-only', '-z', '--'])).split('\0').filter(Boolean)) {
            changedFrom.set(path, new Map([...(changedFrom.get(path) ?? []), [mb, renames.get(path) ?? path]]));
        }
    }
    const untracked = head ? new Set() : new Set((await git.exec(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
    const wanted = (path) => settings.paths.some(glob => matches(path, glob));
    const changed = [...new Set([...changedFrom.keys(), ...untracked])].filter(wanted).filter(path => {
        if (head)
            return true;
        try {
            return statSync(join(repo, path)).isFile();
        }
        catch {
            return false;
        }
    }).sort();
    // A test file whose only differences with every base it changed from are the paths of its imports, or the cited
    // paths of files renamed without change (a test renamed itself: its imports only), is listed apart.
    const show = async (spec) => { try {
        return await git.exec(repo, ['show', '--no-textconv', spec]);
    }
    catch {
        return null;
    } };
    const importsOnly = [];
    const movedPathsOnly = [];
    for (const path of changed) {
        const was = changedFrom.get(path);
        if (untracked.has(path) || !was)
            continue;
        const now = head ? await show(`${head}:${path}`) : (() => { try {
            return readFileSync(join(repo, path), 'utf8');
        }
        catch {
            return null;
        } })();
        if (now === null)
            continue;
        let only = true;
        let moved = false;
        for (const [mb, old] of was) {
            const before = await show(`${mb}:${old}`);
            if (before !== null && (before === now || onlyImportPathsChanged(before, now)))
                continue;
            if (before !== null && old === path && onlyRenamedPathsChanged(before, now, renamedFrom.get(mb) ?? renamedPaths([]))) {
                moved = true;
                continue;
            }
            only = false;
            break;
        }
        if (only)
            (moved ? movedPathsOnly : importsOnly).push(path);
    }
    const files = changed.filter(path => !importsOnly.includes(path) && !movedPathsOnly.includes(path));
    const fixedWaits = [];
    if (settings.fixedWaits !== 'off') {
        for (const file of files) {
            if (fixedWaits.length >= MAX_FIXED_WAITS)
                break;
            const seen = new Set();
            const sources = untracked.has(file) ? [readFileSync(join(repo, file), 'utf8').split('\n').map((text, i) => ({ line: i + 1, text }))]
                : await Promise.all(from.map(async (mb) => addedLines(await git.exec(repo, [...diffArgs(mb), '--no-color', '-U0', '--', file]))));
            for (const lines of sources) {
                for (const { line, text } of fixedWaitLines(lines)) {
                    if (seen.has(line) || fixedWaits.length >= MAX_FIXED_WAITS)
                        continue;
                    seen.add(line);
                    fixedWaits.push({ file, line, text: text.trim().slice(0, 300) });
                }
            }
        }
        fixedWaits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    }
    return { base, reference, files, importsOnly, movedPathsOnly, fixedWaits };
}
/** The refusal of a repeated file whose path starts with `-`: appended to the command, it would read as an option. */
export function optionLikeFile(gateId, file) {
    return new PipelineError('GATE_REPEAT', `Répétition des tests modifiés refusée pour ${gateId} : le fichier ${file} commence par « - », il serait lu comme une option de la commande. Le renommer.`);
}
/** The refusal of a run whose changed test files exceed `maxFiles`: never a silent skip. */
export function tooManyFiles(gateId, plan, settings) {
    const shown = plan.files.slice(0, 30).map(f => `  ${f}`).join('\n');
    return new PipelineError('GATE_REPEAT', `Répétition des tests modifiés refusée pour ${gateId} : ${plan.files.length} fichier(s) de test ajouté(s) ou modifié(s) depuis ` +
        `${(plan.reference ?? plan.base).slice(0, 12)}, au-delà du plafond repeatChanged.maxFiles (${settings.maxFiles}) :\n${shown}${plan.files.length > 30 ? `\n  ... et ${plan.files.length - 30} autre(s)` : ''}\n` +
        'Rien n\'est lancé : découper le changement, ou relever le plafond dans .apv/config.json (revu comme le reste des contrôles). Un test modifié n\'est jamais sauté en silence.');
}
/** The refusal of a run whose changed test files wait on durations (`fixedWaits: "refuse"`). */
export function fixedWaitRefusal(gateId, waits) {
    return new PipelineError('GATE_REPEAT', `Attentes à durée fixe dans les tests modifiés de ${gateId} (repeatChanged.fixedWaits = refuse) :\n` +
        `${waits.slice(0, 30).map(w => `  ${w.file}:${w.line} : ${w.text}`).join('\n')}${waits.length > 30 ? `\n  ... et ${waits.length - 30} autre(s)` : ''}\n` +
        'Attendre un fait observable (réponse réseau, élément, état), jamais une durée ; l\'horloge contrôlée (page.clock) pour ce qui dépend du temps. Rien n\'est lancé.');
}
/** The repetition command: `{{repeat}}` replaced anywhere, then `stressArgs`; the files are appended by the caller. */
export function repeatArgv(settings) {
    return [...settings.command.map(arg => arg.split(REPEAT_PLACEHOLDER).join(String(settings.times))), ...(settings.stressArgs ?? [])];
}
/**
 * How many times each test failed in the output of the repetition: the lines matching `pattern` (capture group 1 when
 * present; ANSI codes removed), counted by name. A runner that reports each failed repetition on its own line (Playwright
 * `--repeat-each` with `--retries=0`, reporter `list` or `line`) gives « fails X times out of N ». 100 tests at most.
 */
export function repeatFailures(pattern, output) {
    if (!pattern)
        return [];
    const re = new RegExp(pattern);
    const counts = new Map();
    for (const raw of output.split('\n')) {
        // eslint-disable-next-line no-control-regex
        const line = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
        const m = re.exec(line);
        const name = m ? (m[1] ?? m[0]).trim().slice(0, 500) : '';
        if (!name)
            continue;
        if (!counts.has(name) && counts.size >= 100)
            continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([test, count]) => ({ test, count }));
}
/** The diagnostic of a failed repetition: « test instable : échoue X fois sur N » for each test the pattern names. */
export function repeatDiagnostic(input) {
    const what = `la répétition des tests modifiés (repeatChanged : ${input.files.length} fichier(s), ${input.times} fois chacun)`;
    const passed = input.afterRetry ? 'la commande du contrôle n\'avait réussi qu\'après la relance de ses tests en échec (retryFailed)' : 'la commande du contrôle avait réussi';
    const head = input.status === 'timed_out'
        ? `Refus : ${what} a dépassé son plafond de durée (${input.timeoutMs < 1000 ? `${input.timeoutMs} ms` : `${Math.round(input.timeoutMs / 1000)} s`}, repeatChanged.timeoutMs, sinon le délai du contrôle) ; ${passed}. ` +
            'Le contrôle est rouge, jamais sauté : réduire les fichiers répétés, accélérer ces tests ou relever le plafond.'
        : input.status === 'failed'
            ? `Test instable : ${what} échoue alors que ${passed}.`
            : `${what} n'a pas abouti (${input.status}) ; ${passed}.`;
    const tests = input.failures.length ? input.failures.map(f => `- ${f.test} : échoue ${f.count} fois sur ${input.times}`)
        : input.status === 'failed' ? [`- nombre d'échecs par test non relevé${input.hasPattern ? ' (aucune ligne ne répond à repeatChanged.testPattern)' : ' (repeatChanged.testPattern absent)'} : échoue au moins 1 fois sur ${input.times}`] : [];
    return [head, ...tests, `Fichiers répétés : ${input.files.join(', ')}`, input.excerpt].filter(Boolean).join('\n');
}
//# sourceMappingURL=repeat.js.map