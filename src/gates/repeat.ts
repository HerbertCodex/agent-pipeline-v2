import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Gate } from '../domain/contracts.js';
import { PipelineError } from '../domain/errors.js';
import type { Git } from '../execution/git.js';
import { matches } from '../policy/policy.js';

/**
 * Repetition of the changed test files (`repeatChanged` of a check, docs/APV3-SPEC.md, section 19): a test written
 * with a fixed wait, the real clock or shared data passes alone and fails at random under load, days later, in
 * someone else's full suite. The files the change adds or modifies are run again, several times, right after the
 * check passed, so that such a test is caught on the branch that brings it.
 */

export type RepeatSettings = NonNullable<Gate['repeatChanged']>;
/** A fixed wait found in a line the change adds to a repeated test file. */
export interface FixedWait { file: string; line: number; text: string }
/** What a check repeats in this run: computed once, before any wait. */
export interface RepeatPlan {
  /** The merge base of `--base` and HEAD the files are compared to. */
  base: string;
  /** The merge base of the reference (the branch the change goes to, `repeatChanged.reference`) and HEAD, when used. */
  reference: string | null;
  files: string[];
  fixedWaits: FixedWait[];
}

/** Placeholder of the number of repetitions, replaced anywhere in an argument (`--repeat-each={{repeat}}`). */
export const REPEAT_PLACEHOLDER = '{{repeat}}';
/** Reference a full suite and `apv gates verify` compare the changes to when `repeatChanged.reference` is absent. */
export const DEFAULT_REPEAT_REFERENCE = 'origin/HEAD';
/** Most fixed waits listed for one check. */
const MAX_FIXED_WAITS = 100;

/**
 * Waits on a duration rather than on an observable fact: Playwright `waitForTimeout(`, a `sleep(` or `delay(` helper,
 * `await setTimeout(` (`node:timers/promises`), and the `new Promise(r => setTimeout(r, ...))` idiom (type argument
 * and a line break or two included). Lines that are only a comment are ignored.
 */
const FIXED_WAIT = [/\.waitForTimeout\s*\(/, /(?<![.\w$])(?:sleep|delay)\s*\(/, /\bawait\s+(?:[\w$]+\.)?setTimeout\s*\(/];
const PROMISE_TIMEOUT = /new\s+Promise\s*(?:<[^>]*>\s*)?\(\s*(?:\((?:[^()]|\([^()]*\))*\)|[\w$]+)\s*=>\s*\{?\s*(?:[\w$]+\.)?setTimeout\s*\(/;
const isComment = (code: string): boolean => code.startsWith('//') || code.startsWith('*') || code.startsWith('/*');
export function fixedWaitIn(line: string): boolean {
  const code = line.trim();
  if (isComment(code)) return false;
  return FIXED_WAIT.some(re => re.test(code)) || PROMISE_TIMEOUT.test(code);
}
/**
 * The fixed waits of consecutive lines: each line alone, and a `new Promise(` joined with the (at most three)
 * following consecutive lines, so that `new Promise(resolve =>` / `setTimeout(resolve, 100))` is found on its first line.
 */
export function fixedWaitLines(lines: readonly { line: number; text: string }[]): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  lines.forEach((l, i) => {
    const code = l.text.trim();
    if (isComment(code)) return;
    if (fixedWaitIn(code)) { found.push(l); return; }
    if (!/new\s+Promise\b/.test(code)) return;
    let joined = code;
    for (let k = i + 1; k < Math.min(lines.length, i + 4) && lines[k]!.line === lines[k - 1]!.line + 1; k++) {
      const next = lines[k]!.text.trim();
      if (isComment(next)) continue;
      joined += ` ${next}`;
      if (PROMISE_TIMEOUT.test(joined)) { found.push(l); return; }
    }
  });
  return found;
}

/**
 * Lines added by a unified diff with no context (`-U0`), with their number in the new file. Only the lines inside
 * a hunk count, so an added line `++i;` (`+++i;` in the diff) is a line, never the `+++ b/<file>` header.
 */
export function addedLines(diff: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let next = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { next = 0; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (next === 0) continue;
    if (raw.startsWith('+')) { out.push({ line: next, text: raw.slice(1) }); next += 1; }
  }
  return out;
}

/** The commit `ref` names, or null when it does not resolve (no remote, reference absent). */
export async function resolveRef(git: Git, repo: string, ref: string): Promise<string | null> {
  try { return (await git.exec(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null; } catch { return null; }
}
/** The merge base of `a` and `b`; `a` itself without a common ancestor (unrelated histories: everything counts). */
export async function mergeBase(git: Git, repo: string, a: string, b: string): Promise<string> {
  try { return (await git.exec(repo, ['merge-base', a, b])).trim() || a; } catch { return a; }
}

/**
 * The test files to repeat: added or modified since the merge base of `base` (and of `reference`, when given) with
 * `head`, those matching one of the globs `paths`, sorted; deleted files never. Without `head`, against the working
 * tree (a task run may have uncommitted tests), untracked files not ignored included; with `head` (a commit), its
 * committed content only (`apv gates verify`, `apv stack batch`). Also the fixed waits in the lines they add (a new
 * file: every line), unless `fixedWaits` is off.
 */
export async function planRepeat(git: Git, repo: string, bases: { base: string; reference?: string | null }, settings: RepeatSettings, head?: string): Promise<RepeatPlan> {
  const tip = head ?? 'HEAD';
  const base = await mergeBase(git, repo, bases.base, tip);
  const reference = bases.reference ? await mergeBase(git, repo, bases.reference, tip) : null;
  const from = [...new Set([base, ...(reference ? [reference] : [])])];
  const diffArgs = (mb: string): string[] => ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', mb, ...(head ? [head] : [])];
  const tracked: string[] = [];
  for (const mb of from) tracked.push(...(await git.exec(repo, [...diffArgs(mb), '--diff-filter=AM', '--name-only', '-z', '--'])).split('\0').filter(Boolean));
  const untracked = head ? new Set<string>() : new Set((await git.exec(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
  const wanted = (path: string): boolean => settings.paths.some(glob => matches(path, glob));
  const files = [...new Set([...tracked, ...untracked])].filter(wanted).filter(path => {
    if (head) return true;
    try { return statSync(join(repo, path)).isFile(); } catch { return false; }
  }).sort();
  const fixedWaits: FixedWait[] = [];
  if (settings.fixedWaits !== 'off') {
    for (const file of files) {
      if (fixedWaits.length >= MAX_FIXED_WAITS) break;
      const seen = new Set<number>();
      const sources = untracked.has(file) ? [readFileSync(join(repo, file), 'utf8').split('\n').map((text, i) => ({ line: i + 1, text }))]
        : await Promise.all(from.map(async mb => addedLines(await git.exec(repo, [...diffArgs(mb), '--no-color', '-U0', '--', file]))));
      for (const lines of sources) {
        for (const { line, text } of fixedWaitLines(lines)) {
          if (seen.has(line) || fixedWaits.length >= MAX_FIXED_WAITS) continue;
          seen.add(line);
          fixedWaits.push({ file, line, text: text.trim().slice(0, 300) });
        }
      }
    }
    fixedWaits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }
  return { base, reference, files, fixedWaits };
}

/** The refusal of a repeated file whose path starts with `-`: appended to the command, it would read as an option. */
export function optionLikeFile(gateId: string, file: string): PipelineError {
  return new PipelineError('GATE_REPEAT', `Répétition des tests modifiés refusée pour ${gateId} : le fichier ${file} commence par « - », il serait lu comme une option de la commande. Le renommer.`);
}

/** The refusal of a run whose changed test files exceed `maxFiles`: never a silent skip. */
export function tooManyFiles(gateId: string, plan: RepeatPlan, settings: RepeatSettings): PipelineError {
  const shown = plan.files.slice(0, 30).map(f => `  ${f}`).join('\n');
  return new PipelineError('GATE_REPEAT', `Répétition des tests modifiés refusée pour ${gateId} : ${plan.files.length} fichier(s) de test ajouté(s) ou modifié(s) depuis ` +
    `${(plan.reference ?? plan.base).slice(0, 12)}, au-delà du plafond repeatChanged.maxFiles (${settings.maxFiles}) :\n${shown}${plan.files.length > 30 ? `\n  ... et ${plan.files.length - 30} autre(s)` : ''}\n` +
    'Rien n\'est lancé : découper le changement, ou relever le plafond dans .apv/config.json (revu comme le reste des contrôles). Un test modifié n\'est jamais sauté en silence.');
}

/** The refusal of a run whose changed test files wait on durations (`fixedWaits: "refuse"`). */
export function fixedWaitRefusal(gateId: string, waits: readonly FixedWait[]): PipelineError {
  return new PipelineError('GATE_REPEAT', `Attentes à durée fixe dans les tests modifiés de ${gateId} (repeatChanged.fixedWaits = refuse) :\n` +
    `${waits.slice(0, 30).map(w => `  ${w.file}:${w.line} : ${w.text}`).join('\n')}${waits.length > 30 ? `\n  ... et ${waits.length - 30} autre(s)` : ''}\n` +
    'Attendre un fait observable (réponse réseau, élément, état), jamais une durée ; l\'horloge contrôlée (page.clock) pour ce qui dépend du temps. Rien n\'est lancé.');
}

/** The repetition command: `{{repeat}}` replaced anywhere, then `stressArgs`; the files are appended by the caller. */
export function repeatArgv(settings: RepeatSettings): string[] {
  return [...settings.command.map(arg => arg.split(REPEAT_PLACEHOLDER).join(String(settings.times))), ...(settings.stressArgs ?? [])];
}

/**
 * How many times each test failed in the output of the repetition: the lines matching `pattern` (capture group 1 when
 * present; ANSI codes removed), counted by name. A runner that reports each failed repetition on its own line (Playwright
 * `--repeat-each` with `--retries=0`, reporter `list` or `line`) gives « fails X times out of N ». 100 tests at most.
 */
export function repeatFailures(pattern: string | undefined, output: string): { test: string; count: number }[] {
  if (!pattern) return [];
  const re = new RegExp(pattern);
  const counts = new Map<string, number>();
  for (const raw of output.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    const m = re.exec(line);
    const name = m ? (m[1] ?? m[0]).trim().slice(0, 500) : '';
    if (!name) continue;
    if (!counts.has(name) && counts.size >= 100) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([test, count]) => ({ test, count }));
}

/** The diagnostic of a failed repetition: « test instable : échoue X fois sur N » for each test the pattern names. */
export function repeatDiagnostic(input: { files: readonly string[]; times: number; failures: readonly { test: string; count: number }[]; afterRetry: boolean;
  status: string; timeoutMs: number; excerpt: string; hasPattern: boolean }): string {
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
