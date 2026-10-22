import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { validateReceipt, type GateReceipt } from '../domain/contracts.js';
import { errorMessage } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { environment, expandCommand, redact, runProcess } from '../execution/process.js';
import { RECEIPTS_DIR, sharedStore } from '../gates/store.js';
import { sharedRunReceipts } from '../gates/reuse-proof.js';
import type { VerifyResult } from '../gates/verify.js';
import { anchorKey, readOperatorMessages, templateWaiver, waiverFor } from '../rules/operator.js';

/**
 * A test unstable at the release, unrelated to the change (docs/UNE-SUITE-PAR-PR.md, 3): a check of the full suite passed only
 * after the relaunch of its failed tests (`passed_after_retry`). Production no longer waits for an old test that fails at random
 * beside the change; the test is written as a finding (journal of the releases, follow-up of the findings) to be fixed apart.
 *
 * A relaunched test is unrelated when: its name gives its file (a path of the commit, `tests/a.spec.ts:12:5 › …`); that file is
 * neither added nor modified since production; and it is not among the test files the `affectedList` command of its check,
 * **read at production**, prints for the changes since production (the same computation as `affected`: the import graph of the
 * tests). Anything else blocks, as before: no test named (no `retryFailed.testPattern`, or no line matching it), a file the name
 * does not give, a check without `affectedList` at production, a list that fails, a test of a changed file or that the change
 * concerns. A failure that the relaunch did not cure, a repetition of a changed test that failed, a migration not confirmed:
 * still refused, elsewhere, as before. What blocks here, the operator alone can waive for the exact released commit
 * (`releaseWaiver`, « dérogation instable <commit> : <raison> »): published, each test written as a finding with his words.
 */
export interface UnstableTest {
  gateId: string;
  test: string;
  /** The files of the commit its name gives (one, usually); empty: none. */
  files: string[];
  runId: string;
  receipt: string;
  /** Failed passes out of the passes of the test: 1 out of 2 (first pass failed, relaunch passed). */
  failed: number;
  passes: number;
  /** Why it blocks the release, or null: unrelated to the change, written as a finding. */
  blocking: string | null;
}
/** `busy`: no copy to judge them in (the tests are judged later): never waived, whatever the operator typed. */
export interface UnstableVerdict { tests: UnstableTest[]; blocking: string[]; busy?: true }

/**
 * The waiver of the rule `instable` the operator typed for the released commit (docs/UNE-SUITE-PAR-PR.md, 3.1; decision of the
 * operator of 22 October 2026): « dérogation instable <12 premiers caractères du commit au moins> : <raison> », the very line
 * that waives the rule at the merge. Read in the operator journal (signed by the UserPromptSubmit hook, never by an agent) by
 * the same code as the waivers of the merge (`waiverFor`): for this exact commit only, never for another, never without a
 * reason nor with the template of the tool. It waives the blocking verdicts on checks that passed after the relaunch of their
 * failed tests (`passed_after_retry`) only: a failure the relaunch did not cure, a repetition that failed, a migration not
 * confirmed are refused before, the waiver never reaches them.
 */
export interface ReleaseWaiver { rule: 'instable'; commit: string; at: string; reason: string; line: string; blocking: string[] }

/**
 * The waiver of `instable` for `sha` in the journal of the Git common directory `common`; `template`: one typed with `<ta raison>`;
 * `keyProblem`: the anchor key is missing or refused, nothing signed is read (the refusal says so instead of asking for the
 * sentence again, which the operator may have typed already).
 */
export function releaseWaiver(common: string, sha: string, blocking: readonly string[]): { waiver: ReleaseWaiver | null; template: boolean; keyProblem: string | null } {
  const anchor = anchorKey(common);
  if (!anchor.key) return { waiver: null, template: false, keyProblem: anchor.problem ?? 'clé d\'ancrage absente' };
  const messages = readOperatorMessages(common, anchor.key);
  const found = waiverFor(messages, 'instable', sha);
  if (found) return { waiver: { rule: 'instable', commit: sha, at: found.message.at, reason: found.reason, line: found.line, blocking: [...blocking] }, template: false, keyProblem: null };
  return { waiver: null, template: templateWaiver(messages, 'instable', sha), keyProblem: null };
}

const PATH_TOKEN = /(?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]+\.[A-Za-z0-9]+/g;

/**
 * The files of `tracked` a text names: a path of the commit as written, or the only file of the commit it ends (a runner prints
 * paths from its own root: `a.spec.ts` for `tests/e2e/a.spec.ts`). A suffix several files end: all of them when `all`, else none.
 */
export function pathsIn(text: string, tracked: readonly string[], all = false): string[] {
  const exact = new Set(tracked);
  const out = new Set<string>();
  for (const token of text.match(PATH_TOKEN) ?? []) {
    const clean = token.replace(/^\.\//, '');
    if (exact.has(clean)) { out.add(clean); continue; }
    const ending = tracked.filter(f => f.endsWith(`/${clean}`));
    if (ending.length === 1 || (all && ending.length)) ending.forEach(f => out.add(f));
  }
  return [...out].sort();
}

/** The receipt `verify` retained for a check (worktree, else the intact run of the shared store), or null. */
function retained(repo: string, store: string, g: VerifyResult['gates'][number]): GateReceipt | null {
  if (!g.runId || !g.receipt) return null;
  if (g.source === 'local') {
    try {
      const r = validateReceipt(JSON.parse(readFileSync(join(repo, RECEIPTS_DIR, g.runId, `${g.gateId}.json`), 'utf8')));
      return r.id === g.receipt ? r : null;
    } catch { return null; }
  }
  const run = sharedRunReceipts(store, g.runId);
  return 'reason' in run ? null : run.found.find(f => f.receipt.id === g.receipt)?.receipt ?? null;
}

/**
 * The verdict on the unstable checks of `proof` at `commit`, released from `production`: each relaunched test, related or not.
 * `copy`: a prepared copy of the commit, where the `affectedList` commands run. `config`: the checks of the release (those of
 * production kept); `affectedList` is read at production only.
 */
export async function classifyUnstable(input: { repo: string; copy: string; commit: string; production: string; config: ApvConfig; proof: VerifyResult;
  env: NodeJS.ProcessEnv; log: (line: string) => void }): Promise<UnstableVerdict> {
  const { repo, commit, production } = input;
  const git = new Git();
  const store = await sharedStore(git, repo);
  const tracked = (await git.exec(repo, ['ls-tree', '-r', '--name-only', '-z', '--full-tree', commit])).split('\0').filter(Boolean);
  const changed = new Set((await git.exec(repo, ['diff', '--name-only', '--no-renames', '-z', production, commit, '--'])).split('\0').filter(Boolean));
  let atProduction: ApvConfig | null = null;
  try { atProduction = loadConfigAtCommit(repo, production).config; } catch { /* no affectedList read: every unstable test blocks */ }
  const tests: UnstableTest[] = [];
  const blocking: string[] = [];
  for (const g of input.proof.gates.filter(x => x.state === 'passed' && x.status === 'passed_after_retry')) {
    const receipt = retained(repo, store, g);
    const named = receipt?.retry?.tests ?? [];
    if (!receipt || !named.length) {
      blocking.push(`${g.gateId} : ${receipt ? 'aucun test nommé dans la première passe (retryFailed.testPattern absent ou sans ligne correspondante)' : 'reçu retenu illisible'} : le lien avec le changement ne se juge pas`);
      continue;
    }
    const declared = atProduction?.gates.find(x => x.id === g.gateId)?.affectedList;
    let affected: Set<string> | null = null;
    let listError: string | null = null;
    if (!declared) listError = `${g.gateId} ne déclare pas affectedList à la production (${production.slice(0, 12)}) : le lien des tests avec le changement (graphe d'imports) ne se juge pas`;
    else {
      const gate = input.config.gates.find(x => x.id === g.gateId);
      const env = environment([...input.config.environment.passEnv, ...(gate?.passEnv ?? [])], input.env);
      try {
        const argv = expandCommand(declared, { workspace: input.copy, candidateSha: commit, baseSha: production });
        const r = await runProcess({ command: argv, cwd: input.copy, env, timeoutMs: gate?.timeoutMs ?? 600_000, maxOutputBytes: 4 * 1024 * 1024 });
        if (r.status !== 'passed' || r.truncated) listError = `${g.gateId} : affectedList ${r.truncated ? 'à la sortie tronquée' : `en échec (${r.status}, code ${r.exitCode ?? '-'})`} : ${redact(`${r.stderr}${r.stdout}`.trim(), { ...env, ...input.env }).slice(-300)}`;
        else affected = new Set(pathsIn(`${r.stdout}\n${r.stderr}`, tracked, true));
      } catch (error) { listError = `${g.gateId} : affectedList non lancé (${errorMessage(error)})`; }
    }
    if (listError) blocking.push(listError);
    for (const test of named) {
      const files = pathsIn(test, tracked);
      const why = !files.length ? 'fichier du test introuvable dans son nom'
        : files.some(f => changed.has(f)) ? `fichier ajouté ou modifié depuis la production (${files.filter(f => changed.has(f)).join(', ')})`
        : listError ? 'lien avec le changement non jugé (affectedList)'
        : files.some(f => affected!.has(f)) ? 'concerné par le changement depuis la production (affectedList, graphe d\'imports)' : null;
      tests.push({ gateId: g.gateId, test, files, runId: receipt.runId, receipt: receipt.id, failed: 1, passes: 2, blocking: why });
      if (why && why !== 'lien avec le changement non jugé (affectedList)') blocking.push(`${g.gateId} : ${test} : ${why}`);
    }
  }
  for (const t of tests) input.log(`${t.gateId} : test instable ${t.test} (échoue ${t.failed} fois sur ${t.passes} passages) : ${t.blocking ? `bloquant, ${t.blocking}` : 'sans rapport avec le changement depuis la production, constat'}.`);
  return { tests, blocking };
}

const HEADING = '## Tests instables à la mise en ligne';

/** The line of the follow-up of a finding for an unstable test unrelated to the change. */
export const findingLine = (t: UnstableTest, commit: string, date: string): string =>
  `- ${date}, mise en ligne de ${commit.slice(0, 12)}, test instable sans rapport avec le changement : ${t.test} (${t.gateId}, ${t.files.join(', ')}) : échoue ${t.failed} fois sur ${t.passes} passages (exécution ${t.runId}) ; publié quand même, à corriger à part.`;

/** What the operator's waiver is said with, in the output and the follow-up: its date and reason. */
export const waiverWords = (w: ReleaseWaiver): string => `dérogation instable de l'opérateur (${w.at}) : ${w.reason}`;

/** The line of the follow-up of a test (or of a check, `t` null) published only by the waiver of the operator. */
export const waivedFindingLine = (w: ReleaseWaiver, date: string, t: UnstableTest | null, why: string): string =>
  `- ${date}, mise en ligne de ${w.commit.slice(0, 12)}, ${t ? `test instable publié par ${waiverWords(w)} : ${t.test} (${t.gateId}${t.files.length ? `, ${t.files.join(', ')}` : ''}) : échoue ${t.failed} fois sur ${t.passes} passages (exécution ${t.runId}) ; bloquant sans elle : ${why}`
    : `contrôle instable publié par ${waiverWords(w)} : ${why}`} ; à corriger à part.`;

/** The waived findings: each blocking test, then each blocking reason no test carries (a check whose tests are not named). */
export function waivedFindings(w: ReleaseWaiver, tests: readonly UnstableTest[], date: string): string[] {
  const own = tests.filter(t => t.blocking !== null);
  const said = new Set(own.map(t => `${t.gateId} : ${t.test} : ${t.blocking}`));
  return [...own.map(t => waivedFindingLine(w, date, t, t.blocking!)), ...w.blocking.filter(b => !said.has(b)).map(b => waivedFindingLine(w, date, null, b))];
}

/**
 * Appends the unstable tests unrelated to the change, and those the waiver of the operator published, to the follow-up of the findings (`.apv/state/suivi-constats.md` of the
 * checkout), once per test and commit. A failure is returned, never thrown: the release stands, its journal says it.
 */
export function writeFindings(root: string, commit: string, tests: readonly UnstableTest[], now = new Date(), waiver: ReleaseWaiver | null = null): string | null {
  const unrelated = tests.filter(t => t.blocking === null);
  if (!unrelated.length && !waiver) return null;
  try {
    const file = join(root, '.apv', 'state', 'suivi-constats.md');
    mkdirSync(join(root, '.apv', 'state'), { recursive: true });
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const date = now.toISOString().slice(0, 10);
    const lines = [...unrelated.map(t => findingLine(t, commit, date)), ...(waiver ? waivedFindings(waiver, tests, date) : [])];
    const fresh = lines.filter(line => !before.includes(line.slice(line.indexOf(', mise en ligne'))));
    if (!fresh.length) return null;
    // Under its own heading, written again when another section was added since.
    const last = before.split('\n').filter(l => l.startsWith('## ')).pop();
    const heading = last === HEADING ? '' : `${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${HEADING}\n`;
    appendFileSync(file, `${heading}${fresh.join('\n')}\n`);
    return null;
  } catch (error) { return errorMessage(error); }
}
