import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, normalize } from 'node:path';
import { loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { validateReceipt, type GateReceipt } from '../domain/contracts.js';
import { errorMessage } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { environment, expandCommand, redact, runProcess } from '../execution/process.js';
import { RECEIPTS_DIR, sharedStore } from '../gates/store.js';
import { sharedRunReceipts } from '../gates/reuse-proof.js';
import type { VerifyResult } from '../gates/verify.js';
import { anchorKey, ignoredWaiver, readOperatorMessages, templateWaiver, waiverFor } from '../rules/operator.js';

/**
 * A test unstable at the release, unrelated to the change (docs/UNE-SUITE-PAR-PR.md, 3): a check of the full suite passed only
 * after the relaunch of its failed tests (`passed_after_retry`). Production no longer waits for an old test that fails at random
 * beside the change; the test is written as a finding (journal of the releases, follow-up of the findings) to be fixed apart.
 *
 * A relaunched test is unrelated when: its name gives its file (a path of the commit, `tests/a.spec.ts:12:5 › …`); that file is
 * neither added nor modified since production; and it is not among the test files the `affectedList` command of its check,
 * **read at production**, prints for the changes since production (the same computation as `affected`: the import graph of the
 * tests). Anything else blocks, as before: no test named (no `retryFailed.testPattern`, or no line matching it), a file the name
 * does not give, a check without `affectedList` at production, a list that fails, a change that touches a file the command
 * executes (its paths, the script it runs, what they import locally: the list would come from the candidate itself, which would
 * decide for itself), a test of a changed file or that the change concerns. A failure that the relaunch did not cure, a repetition of a changed test that failed, a migration not confirmed:
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
export function releaseWaiver(common: string, sha: string, blocking: readonly string[]):
  { waiver: ReleaseWaiver | null; template: boolean; keyProblem: string | null; ignored: string | null } {
  const anchor = anchorKey(common);
  if (!anchor.key) return { waiver: null, template: false, keyProblem: anchor.problem ?? 'clé d\'ancrage absente', ignored: null };
  const messages = readOperatorMessages(common, anchor.key);
  const found = waiverFor(messages, 'instable', sha);
  if (found) return { waiver: { rule: 'instable', commit: sha, at: found.message.at, reason: found.reason, line: found.line, blocking: [...blocking] }, template: false, keyProblem: null, ignored: null };
  return { waiver: null, template: templateWaiver(messages, 'instable', sha), keyProblem: null, ignored: ignoredWaiver(messages, 'instable', sha) };
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

const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const CODE_FILE = /\.[cm]?[jt]sx?$/;
/** Configuration files that change what a command runs (options of Node, of the runner, of the compiler), counted beside it. */
const CONFIG_FILE = /^(?:package\.json|\.npmrc|\.yarnrc(?:\.yml)?|bunfig\.toml|tsconfig[^/]*\.json)$/;
/** A module specifier of a script: `from 'x'`, `import 'x'`, `import('x')`, `require('x')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]*)\1/g;
/** An `import(` or `require(` whose argument is not a plain string literal: a template, a computed path. */
const DYNAMIC = /\b(?:import|require)\s*\(\s*(?!(['"])[^'"\n]*\1\s*\))/;
const BUILTINS = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
const MAX_COMMAND_FILES = 300;
const SCRIPT_CALLS_RUNNER = /\b(?:npm|pnpm|yarn|bun|npx)\b/;

/**
 * The files of the commit that an `affectedList` command executes (review of 22 October 2026, F4 and its review), and what
 * the tool does not know how to follow (`unknown`): the command cannot then be trusted and the judgment « sans rapport » fails
 * closed. Counted: the paths its arguments name; the `package.json`, `.npmrc`, `.yarnrc*`, `bunfig.toml` and `tsconfig*.json`
 * of the root and of the folders of the files above; for `npm|pnpm|yarn|bun run <script>` the script of `package.json`
 * (with its `pre` and `post`) and the paths it names; the local modules (`./`, `../`) of every script, read in the commit.
 * Unknown: a runner called any other way (`npm test`, `npm run --silent`), a script that calls another runner or is missing,
 * a file that is neither a script nor JSON, a symbolic link, an `import()` or `require()` that is not a plain string, a package
 * (bare name, `#` import) that is not a Node module, a module not found, more than 300 files. A file that a script reads as
 * data is not followed (documented limit).
 */
export async function commandFiles(argv: readonly string[], tracked: readonly string[], read: (path: string) => Promise<string | null>,
  symlinks: ReadonlySet<string> = new Set()): Promise<{ files: string[]; unknown: string[] }> {
  const known = new Set(tracked);
  const seen = new Set<string>();
  const unknown: string[] = [];
  const queue = pathsIn(argv.join(' '), tracked, true);
  const dirOf = (file: string): string => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  if (SCRIPT_RUNNERS.has(argv[0] ?? '')) {
    const name = argv[1] === 'run' || (argv[0] === 'npm' && argv[1] === 'run-script') ? argv[2] : undefined;
    if (!name || name.startsWith('-')) unknown.push(`${argv[0]} ${argv.slice(1, 3).join(' ')} : seule la forme « ${argv[0]} run <script> » est suivie`);
    else {
      let scripts: Record<string, unknown> = {};
      try { scripts = (JSON.parse(await read('package.json') ?? '') as { scripts?: Record<string, unknown> }).scripts ?? {}; } catch { unknown.push('package.json illisible'); }
      if (typeof scripts[name] !== 'string') unknown.push(`script « ${name} » introuvable dans package.json`);
      for (const n of [`pre${name}`, name, `post${name}`]) {
        const body = scripts[n];
        if (typeof body !== 'string') continue;
        if (SCRIPT_CALLS_RUNNER.test(body)) unknown.push(`script « ${n} » : appelle un autre lanceur (${body.slice(0, 60)})`);
        queue.push(...pathsIn(body, tracked, true));
      }
    }
  }
  // The configuration files beside the command: at the root and in the folders of the files it executes.
  const addConfigs = (): void => {
    const dirs = new Set(['']);
    for (const f of [...seen, ...queue]) for (let d = dirOf(f); d; d = dirOf(d)) dirs.add(d);
    for (const f of tracked) if (CONFIG_FILE.test(f.slice(f.lastIndexOf('/') + 1)) && dirs.has(dirOf(f))) queue.push(f);
  };
  addConfigs();
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    if (seen.size >= MAX_COMMAND_FILES) { unknown.push(`plus de ${MAX_COMMAND_FILES} fichiers à suivre`); break; }
    seen.add(file);
    if (symlinks.has(file)) { unknown.push(`${file} : lien symbolique`); continue; }
    if (file.endsWith('.json') || CONFIG_FILE.test(file.slice(file.lastIndexOf('/') + 1))) continue;
    if (!CODE_FILE.test(file)) { unknown.push(`${file} : ni script JavaScript ni JSON, non suivi`); continue; }
    const text = await read(file);
    if (text === null) { unknown.push(`${file} : illisible`); continue; }
    if (DYNAMIC.test(text)) unknown.push(`${file} : import() ou require() qui n'est pas une chaîne littérale`);
    const dir = dirOf(file);
    for (const match of text.matchAll(SPECIFIER)) {
      const spec = match[2]!;
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        if (!BUILTINS.has(spec)) unknown.push(`${file} : « ${spec.slice(0, 60)} » n'est ni un module local ni un module de Node`);
        continue;
      }
      const target = normalize(join(dir, spec)).split('\\').join('/');
      const found: string[] = [];
      for (const base of new Set([target, target.replace(/\.[cm]?js$/, '')])) {
        for (const ext of ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.json']) {
          for (const candidate of [`${base}${ext}`, `${base}/index${ext}`]) if (known.has(candidate)) found.push(candidate);
        }
      }
      if (!found.length) unknown.push(`${file} : « ${spec.slice(0, 60)} » introuvable dans le commit`);
      queue.push(...found);
    }
    addConfigs();
  }
  return { files: [...seen].filter(f => known.has(f)).sort(), unknown: [...new Set(unknown)] };
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
  const entries = (await git.exec(repo, ['ls-tree', '-r', '-z', '--full-tree', commit])).split('\0').filter(Boolean).map(e => ({ mode: e.slice(0, e.indexOf(' ')), path: e.slice(e.indexOf('\t') + 1) }));
  const tracked = entries.map(e => e.path);
  const symlinks = new Set(entries.filter(e => e.mode === '120000').map(e => e.path));
  const changed = new Set((await git.exec(repo, ['diff', '--name-only', '--no-renames', '-z', production, commit, '--'])).split('\0').filter(Boolean));
  let atProduction: ApvConfig | null = null;
  try { atProduction = loadConfigAtCommit(repo, production).config; } catch { /* no affectedList read: every unstable test blocks */ }
  // The command is read at production but its script is the candidate's: a change to a file it executes would decide for itself.
  const read = (path: string): Promise<string | null> => git.exec(repo, ['show', `${commit}:${path}`]).catch(() => null);
  /**
   * Why the copy where the suite ran cannot run `affectedList`, or null: a tracked file modified (a test of the candidate may have
   * rewritten the script), or a file of the command that differs from the commit.
   */
  const copyDrift = async (files: readonly string[]): Promise<string | null> => {
    const dirty = (await git.exec(input.copy, ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean);
    if (dirty.length) return `la copie de la suite a des fichiers suivis modifiés (${dirty.slice(0, 3).map(l => l.slice(3)).join(', ')})`;
    for (const f of files) {
      const here = (await git.exec(input.copy, ['hash-object', '--no-filters', '--', f]).catch(() => '')).trim();
      const there = (await git.exec(repo, ['rev-parse', `${commit}:${f}`]).catch(() => null))?.trim();
      if (!here || here !== there) return `${f} diffère de son contenu au commit dans la copie de la suite`;
    }
    return null;
  };
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
    const followed = declared ? await commandFiles(declared, tracked, read, symlinks) : null;
    const touched = followed?.files.filter(f => changed.has(f)) ?? [];
    let drift: string | null = null;
    if (!declared) listError = `${g.gateId} ne déclare pas affectedList à la production (${production.slice(0, 12)}) : le lien des tests avec le changement (graphe d'imports) ne se juge pas`;
    else if (followed!.unknown.length) listError = `${g.gateId} : affectedList : l'outil ne sait pas suivre ce que la commande exécute (${followed!.unknown.slice(0, 3).join(' ; ')}) : aucun test n'est jugé sans rapport`;
    else if (touched.length) listError = `${g.gateId} : le changement depuis la production touche un fichier que affectedList exécute (${touched.join(', ')}) : la liste viendrait d'un script que la PR décide elle-même, aucun test n'est jugé sans rapport`;
    else if ((drift = await copyDrift(followed!.files))) listError = `${g.gateId} : affectedList non lancé : ${drift} : la liste ne serait pas celle du commit, aucun test n'est jugé sans rapport`;
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
