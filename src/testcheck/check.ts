import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { s, type Infer } from '../domain/schema.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { matches } from '../policy/policy.js';
import { addedLines, fixedWaitLines } from '../gates/repeat.js';

/**
 * `apv tests check`: deterministic checks of the test files a change adds or modifies, run as a check of the task
 * stage. Pilot project, 3 October 2026: the same findings came back review after review on a pull request of tests (a
 * fixed wait in a browser test, a delay tested on the real clock), each costing a round of corrections and a new
 * review. What a tool can see in the changed lines, it says before the review:
 * - `waitForTimeout`: `page.waitForTimeout(` (Playwright) added to a browser test: error by default;
 * - `fixedWait`: any other wait on a duration added to a browser test (`sleep(`, `delay(`, `await setTimeout(`,
 *   `new Promise(r => setTimeout(r, …))`): warning by default;
 * - `realClock`: a unit test that tests a delay on the real clock (`setTimeout(` and `Date.now()` or
 *   `performance.now()` in the same file, one of them in a changed line, no fake timers): warning by default;
 * - `sharedData`: an e-mail address written in a changed line of a browser test and also written in another browser
 *   test of the project (two tests that may change the same account): warning by default.
 * The waits are those of `repeatChanged.fixedWaits` (src/gates/repeat.ts), here on every changed test file, at the task
 * stage, whatever the checks declare. Only the lines the change adds count: what existed is never reported.
 */

export const TEST_CHECK_RULES = ['waitForTimeout', 'fixedWait', 'realClock', 'sharedData'] as const;
export type TestCheckRule = typeof TEST_CHECK_RULES[number];
export const TEST_CHECK_SEVERITIES = ['off', 'warning', 'error'] as const;
export type TestCheckSeverity = typeof TEST_CHECK_SEVERITIES[number];
export const DEFAULT_TEST_CHECK_SEVERITY: Readonly<Record<TestCheckRule, TestCheckSeverity>> = { waitForTimeout: 'error', fixedWait: 'warning', realClock: 'warning', sharedData: 'warning' };

/** Browser tests (Playwright, Cypress and the usual folders). */
export const DEFAULT_E2E_PATHS = ['**/e2e/**', '**/*.e2e.*', '**/playwright/**', '**/cypress/**', 'tests/**/*.spec.*', '**/*.pw.*'] as const;
/** Unit tests: test files that are not browser tests. */
export const DEFAULT_UNIT_PATHS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'test/**', 'tests/**'] as const;

const globs = s.array(s.string(1, 500), 1, 200);
const severity = s.optional(s.enum(TEST_CHECK_SEVERITIES));
export const testsCheckSchema = s.object({
  /** False: `apv tests check` passes without reading anything (the project opts out, said in the output). */
  enabled: s.optional(s.boolean()),
  /** The branch the change goes to (`origin/main`), when `--base` is not given. */
  reference: s.optional(s.string(1, 200)),
  e2e: s.optional(globs),
  unit: s.optional(globs),
  /** Globs left out of every rule (generated files, vendored tests). */
  ignore: s.optional(globs),
  severity: s.optional(s.object({ waitForTimeout: severity, fixedWait: severity, realClock: severity, sharedData: severity })),
});
export type TestsCheckConfig = Infer<typeof testsCheckSchema>;

export interface TestFinding { rule: TestCheckRule; severity: Exclude<TestCheckSeverity, 'off'>; file: string; line: number; text: string; message: string }
export interface TestCheckReport {
  tool: 'apv tests check';
  enabled: boolean;
  base: { ref: string | null; mergeBase: string | null };
  files: { e2e: string[]; unit: string[] };
  severity: Record<TestCheckRule, TestCheckSeverity>;
  findings: TestFinding[];
  ok: boolean;
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new PipelineError('TESTS_GIT', `git ${args.slice(0, 2).join(' ')} a échoué : ${stderr || errorMessage(error)}`);
  }
}

const isComment = (code: string): boolean => /^(?:\/\/|\/\*|\*)/.test(code);
const WAIT_FOR_TIMEOUT = /\.waitForTimeout\s*\(/;
const REAL_TIMER = /\bsetTimeout\s*\(/;
const REAL_NOW = /\bDate\.now\s*\(|\bperformance\.now\s*\(/;
/** Fake timers of the usual runners: the clock of the test is controlled. */
const FAKE_TIMERS = /\buseFakeTimers\s*\(|\bmock\.timers\b|\bpage\.clock\b|\bclock\.install\s*\(|\bFakeTimers\b|\badvanceTimers/;
const EMAIL = /['"`]([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})['"`]/g;

/**
 * The test files the change adds or modifies since the merge base of `base` and HEAD, working tree and untracked files
 * included (a task run may check uncommitted tests), with the lines it adds.
 */
function changedTests(repo: string, mergeBase: string, wanted: (path: string) => boolean): { file: string; lines: { line: number; text: string }[] }[] {
  const tracked = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-filter=AM', '--name-only', '-z', mergeBase, '--']).split('\0').filter(Boolean);
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const out: { file: string; lines: { line: number; text: string }[] }[] = [];
  for (const file of [...new Set([...tracked, ...untracked])].filter(wanted).sort()) {
    try { if (!statSync(join(repo, file)).isFile()) continue; } catch { continue; }
    const lines = untracked.includes(file)
      ? readFileSync(join(repo, file), 'utf8').split('\n').map((text, i) => ({ line: i + 1, text }))
      : addedLines(git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', mergeBase, '--', file]));
    out.push({ file, lines });
  }
  return out;
}

export function testsCheckSeverity(config: TestsCheckConfig | undefined): Record<TestCheckRule, TestCheckSeverity> {
  return Object.fromEntries(TEST_CHECK_RULES.map(r => [r, config?.severity?.[r] ?? DEFAULT_TEST_CHECK_SEVERITY[r]])) as Record<TestCheckRule, TestCheckSeverity>;
}

export function checkTests(repo: string, config: TestsCheckConfig | undefined, options: { base?: string }): TestCheckReport {
  const severity = testsCheckSeverity(config);
  const enabled = config?.enabled !== false;
  const ref = options.base ?? config?.reference ?? null;
  const empty = { tool: 'apv tests check' as const, enabled, severity, files: { e2e: [], unit: [] }, findings: [], ok: true };
  if (!enabled) return { ...empty, base: { ref, mergeBase: null } };
  if (!ref) throw new PipelineError('TESTS_BASE', 'apv tests check : --base <ref> (le contrôle déclaré passe {{baseSha}}) ou testsCheck.reference est obligatoire : seuls les tests que le changement ajoute ou modifie sont lus.');
  let mergeBase: string;
  try { mergeBase = git(repo, ['merge-base', ref, 'HEAD']).trim(); } catch { throw new PipelineError('TESTS_BASE', `apv tests check : référence introuvable ou sans base commune avec HEAD : ${ref}`); }
  const e2eGlobs = config?.e2e ?? [...DEFAULT_E2E_PATHS];
  const unitGlobs = config?.unit ?? [...DEFAULT_UNIT_PATHS];
  const ignore = config?.ignore ?? [];
  const isE2e = (p: string): boolean => e2eGlobs.some(g => matches(p, g));
  const isUnit = (p: string): boolean => !isE2e(p) && unitGlobs.some(g => matches(p, g));
  const kept = (p: string): boolean => !ignore.some(g => matches(p, g)) && /\.(?:[cm]?[jt]sx?)$/.test(p);
  const changed = changedTests(repo, mergeBase, p => kept(p) && (isE2e(p) || isUnit(p)));
  const findings: TestFinding[] = [];
  const add = (rule: TestCheckRule, file: string, line: { line: number; text: string }, message: string): void => {
    const level = severity[rule];
    if (level === 'off') return;
    findings.push({ rule, severity: level, file, line: line.line, text: line.text.trim().slice(0, 300), message });
  };
  const e2eFiles = changed.filter(c => isE2e(c.file));
  const unitFiles = changed.filter(c => isUnit(c.file));
  for (const { file, lines } of e2eFiles) {
    for (const wait of fixedWaitLines(lines)) {
      if (WAIT_FOR_TIMEOUT.test(wait.text)) add('waitForTimeout', file, wait, 'attente à durée fixe (waitForTimeout) : attendre un fait observable (élément, réponse réseau, état), page.clock pour ce qui dépend du temps');
      else add('fixedWait', file, wait, 'attente à durée fixe dans un test navigateur : attendre un fait observable, jamais une durée');
    }
  }
  for (const { file, lines } of unitFiles) {
    let text: string;
    try { text = readFileSync(join(repo, file), 'utf8'); } catch { continue; }
    const code = text.split('\n').filter(l => !isComment(l.trim())).join('\n');
    if (FAKE_TIMERS.test(code) || !REAL_TIMER.test(code) || !REAL_NOW.test(code)) continue;
    const at = lines.find(l => !isComment(l.text.trim()) && (REAL_TIMER.test(l.text) || REAL_NOW.test(l.text)));
    if (at) add('realClock', file, at, 'délai testé sur l\'horloge réelle (setTimeout et Date.now sans faux minuteurs) : instable sous charge ; vi.useFakeTimers(), jest.useFakeTimers() ou mock.timers de node:test');
  }
  if (severity.sharedData !== 'off' && e2eFiles.length) {
    // Every browser test of the project at HEAD and in the working tree: an address another test writes too.
    const all = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(p => p && kept(p) && isE2e(p));
    const owners = new Map<string, Set<string>>();
    for (const p of all) {
      let text: string;
      try { text = readFileSync(join(repo, p), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(EMAIL)) owners.set(m[1]!.toLowerCase(), new Set([...(owners.get(m[1]!.toLowerCase()) ?? []), p]));
    }
    for (const { file, lines } of e2eFiles) {
      const seen = new Set<string>();
      for (const l of lines) {
        if (isComment(l.text.trim())) continue;
        for (const m of l.text.matchAll(EMAIL)) {
          const address = m[1]!.toLowerCase();
          const others = [...(owners.get(address) ?? [])].filter(p => p !== file);
          if (!others.length || seen.has(address)) continue;
          seen.add(address);
          add('sharedData', file, l, `adresse ${address} aussi écrite dans ${others.slice(0, 3).join(', ')}${others.length > 3 ? '…' : ''} : deux tests sur le même compte se gênent en parallèle ; des données propres au test (adresse unique par test)`);
        }
      }
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { ...empty, base: { ref, mergeBase }, files: { e2e: e2eFiles.map(c => c.file), unit: unitFiles.map(c => c.file) }, findings, ok: !findings.some(f => f.severity === 'error') };
}
