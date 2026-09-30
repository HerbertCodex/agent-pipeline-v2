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
    for (const mb of from) {
        const renames = new Map();
        const status = (await git.exec(repo, ['diff', '--no-ext-diff', '--no-textconv', '-M', '--name-status', '-z', mb, ...(head ? [head] : []), '--'])).split('\0');
        for (let i = 0; i < status.length;) {
            const code = status[i] ?? '';
            if (!code) {
                i++;
                continue;
            }
            if (code.startsWith('R') || code.startsWith('C')) {
                if (code.startsWith('R') && status[i + 1] && status[i + 2])
                    renames.set(status[i + 2], status[i + 1]);
                i += 3;
            }
            else
                i += 2;
        }
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
    // A test file whose only differences with every base it changed from are the paths of its imports is listed apart.
    const show = async (spec) => { try {
        return await git.exec(repo, ['show', '--no-textconv', spec]);
    }
    catch {
        return null;
    } };
    const importsOnly = [];
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
        for (const [mb, old] of was) {
            const before = await show(`${mb}:${old}`);
            if (before === null || !(before === now || onlyImportPathsChanged(before, now))) {
                only = false;
                break;
            }
        }
        if (only)
            importsOnly.push(path);
    }
    const files = changed.filter(path => !importsOnly.includes(path));
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
    return { base, reference, files, importsOnly, fixedWaits };
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