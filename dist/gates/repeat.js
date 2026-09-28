import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../domain/errors.js';
import { matches } from '../policy/policy.js';
/** Placeholder of the number of repetitions, replaced anywhere in an argument (`--repeat-each={{repeat}}`). */
export const REPEAT_PLACEHOLDER = '{{repeat}}';
/** Most fixed waits listed for one check. */
const MAX_FIXED_WAITS = 100;
/**
 * Waits on a duration rather than on an observable fact: Playwright `waitForTimeout(`, a `sleep(` helper, and the
 * `new Promise(r => setTimeout(r, ...))` idiom. Lines that are only a comment are ignored.
 */
const FIXED_WAIT = [/\.waitForTimeout\s*\(/, /\bsleep\s*\(/, /new\s+Promise\s*\(\s*\(?\s*[\w$]*\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(/];
export function fixedWaitIn(line) {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*'))
        return false;
    return FIXED_WAIT.some(re => re.test(code));
}
/** Lines added by a unified diff with no context (`-U0`), with their number in the new file. */
export function addedLines(diff) {
    const out = [];
    let next = 0;
    for (const raw of diff.split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk) {
            next = Number(hunk[1]);
            continue;
        }
        if (next === 0 || raw.startsWith('+++'))
            continue;
        if (raw.startsWith('+')) {
            out.push({ line: next, text: raw.slice(1) });
            next += 1;
        }
    }
    return out;
}
/**
 * The test files to repeat: added or modified since the merge base of `base` and HEAD, working tree included (a task
 * run may have uncommitted tests), untracked files not ignored included, deleted files never; those matching one of
 * the globs `paths`, sorted. Also the fixed waits in the lines they add (a new file: every line).
 */
export async function planRepeat(git, repo, baseSha, settings) {
    // Without a common ancestor (unrelated histories), the base itself: every file it does not have counts as added.
    let base = baseSha;
    try {
        base = (await git.exec(repo, ['merge-base', baseSha, 'HEAD'])).trim() || baseSha;
    }
    catch { /* no merge base */ }
    const tracked = (await git.exec(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-filter=AM', '--name-only', '-z', base, '--'])).split('\0').filter(Boolean);
    const untracked = new Set((await git.exec(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
    const wanted = (path) => settings.paths.some(glob => matches(path, glob));
    const files = [...new Set([...tracked, ...untracked])].filter(wanted).filter(path => {
        try {
            return statSync(join(repo, path)).isFile();
        }
        catch {
            return false;
        }
    }).sort();
    const fixedWaits = [];
    if (settings.fixedWaits !== 'off') {
        for (const file of files) {
            if (fixedWaits.length >= MAX_FIXED_WAITS)
                break;
            const lines = untracked.has(file) ? readFileSync(join(repo, file), 'utf8').split('\n').map((text, i) => ({ line: i + 1, text }))
                : addedLines(await git.exec(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '-U0', base, '--', file]));
            for (const { line, text } of lines) {
                if (fixedWaitIn(text))
                    fixedWaits.push({ file, line, text: text.trim().slice(0, 300) });
                if (fixedWaits.length >= MAX_FIXED_WAITS)
                    break;
            }
        }
    }
    return { base, files, fixedWaits };
}
/** The refusal of a run whose changed test files exceed `maxFiles`: never a silent skip. */
export function tooManyFiles(gateId, plan, settings) {
    const shown = plan.files.slice(0, 30).map(f => `  ${f}`).join('\n');
    return new PipelineError('GATE_REPEAT', `Répétition des tests modifiés refusée pour ${gateId} : ${plan.files.length} fichier(s) de test ajouté(s) ou modifié(s) depuis ` +
        `${plan.base.slice(0, 12)}, au-delà du plafond repeatChanged.maxFiles (${settings.maxFiles}) :\n${shown}${plan.files.length > 30 ? `\n  ... et ${plan.files.length - 30} autre(s)` : ''}\n` +
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