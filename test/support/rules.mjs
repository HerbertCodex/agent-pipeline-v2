// Helpers of the tests for the rules checked before a merge (src/rules): the operator journal the UserPromptSubmit hook
// writes, and review records written and sealed as `apv review record` and its PostToolUse hook do. The anchor key of the
// tests lives in a temporary folder, set in this process (setAnchorKeyFile) and given to the hooks a test runs through test/support/run-hook.mjs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendJournal, journalEntry, readAnchorKey, setAnchorKeyFile, sign } from '../../dist/rules/operator.js';

// The tests sign as the apv command does (src/rules/operator.ts: signing needs APV_ENTRY set to cli or hook; no value
// is kept for the tests alone, which the environment of a session could carry).
process.env.APV_ENTRY = 'cli';

export const RULES = ['preuve', 'instable', 'relecture', 'captures', 'controles', 'maquette'];

/** The anchor key of the tests of this file (one process per test file). */
export const TEST_KEY_FILE = join(mkdtempSync(join(tmpdir(), 'apv3-cle-')), 'cle-ancrage');
writeFileSync(TEST_KEY_FILE, `${randomBytes(32).toString('hex')}\n`, { mode: 0o400 });
// Removed with its folder when the test process ends, normally or stopped by SIGINT, SIGTERM or SIGHUP (Ctrl-C, the
// runner's timeout): the process then ends with the code of that signal, whatever other listener it has. SIGKILL
// cannot be caught: the key stays in the temporary folder of the system.
const removeKey = () => { try { rmSync(dirname(TEST_KEY_FILE), { recursive: true, force: true }); } catch { /* already gone */ } };
process.on('exit', removeKey);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { removeKey(); process.exit(128 + osConstants.signals[signal]); });
setAnchorKeyFile(TEST_KEY_FILE);
export const TEST_KEY = readAnchorKey(TEST_KEY_FILE);

export const commonDirOf = repo => execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();

/** A message the operator typed in the session, as the hook keeps it (signed). */
export function operatorSays(repo, text, at = new Date().toISOString()) {
  appendJournal(commonDirOf(repo), journalEntry(text, { at, session: 'test' }, TEST_KEY));
}

/** The operator waives `rules` for `sha`, in one message, one line per rule. */
export function waive(repo, sha, rules = RULES, reason = 'flux GitHub du test, sans objet ici') {
  operatorSays(repo, rules.map(r => `dérogation ${r} ${sha.slice(0, 12)} : ${reason}`).join('\n'));
}

/**
 * Messages that contain the words of a waiver of `rule` for `sha12` without being one (security review of PR #160: A1 a
 * refusal, A2 a question, A3 a quote of an agent's proposal, then variants): none waives anything.
 */
export const notWaivers = (rule, sha12) => [
  `Non, pas de dérogation ${rule} ${sha12} : corrige d'abord le test cassé.`,
  `Dois-je taper dérogation ${rule} ${sha12} : test ancien ? Explique avant.`,
  `> dérogation ${rule} ${sha12} : test ancien sans rapport\nC est bien ?`,
  `Je ne tape pas dérogation ${rule} ${sha12} : il faut corriger le test`,
  `dérogation ${rule} ${sha12} : test ancien sans rapport, c'est bien ça ?`,
  `dérogation ${rule} ${sha12} : l'agent propose « test ancien sans rapport »`,
  `dérogation ${rule} ${sha12} test ancien sans rapport, sans deux-points`,
  // Second review of PR #160: a proposal pasted, then a question or a change of mind (C1 to C4).
  `L'agent propose :\n\`\`\`\ndérogation ${rule} ${sha12} : test ancien sans rapport\n\`\`\`\nJe tape ça ?`,
  `L'agent propose :\ndérogation ${rule} ${sha12} : test ancien sans rapport\nC'est bien ça ?`,
  `Il dit de taper :\n    dérogation ${rule} ${sha12} : test ancien sans rapport\nPourquoi ?`,
  `    dérogation ${rule} ${sha12} : test ancien sans rapport`,
  `dérogation ${rule} ${sha12} : test ancien sans rapport\nNon, finalement pas de dérogation, corrige.`,
  // Delta review of PR #160 (F1, infos): a retraction on the same line; NEL, VT and FF in the reason; « migration non appliquée » is no confirmation.
  `dérogation ${rule} ${sha12} : test ancien sans rapport. Non, finalement pas de dérogation, corrige.`,
  ...['\u0085', '\u000B', '\u000C'].map(c => `dérogation ${rule} ${sha12} : test ancien${c}sans rapport`),
  `dérogation ${rule} ${sha12} : test ancien sans rapport\nmigration non appliquée`,
];

/** Forms of a waiver typed alone that count (second review of PR #160): tab, non-breaking spaces, CRLF, BOM, final line break. */
export const plainWaivers = (rule, sha12, reason = 'test ancien sans rapport') => [
  `\tdérogation ${rule} ${sha12} : ${reason}`,
  `dérogation ${rule} ${sha12} : ${reason}`,
  `dérogation ${rule} ${sha12} : ${reason}\r\n`,
  `﻿dérogation ${rule} ${sha12} : ${reason}`,
  `dérogation ${rule} ${sha12} : ${reason}\n`,
  `   dérogation ${rule} ${sha12} : ${reason}`,
];

const digest = data => createHash('sha256').update(data).digest('hex');

/** A PNG of `size` bytes whose content depends on `seed` (a capture, for the tool: signature and size). */
export function png(seed, size = 2048) {
  const data = Buffer.alloc(size, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  return data;
}

/**
 * A review record in the store, as `apv review record` writes it, sealed as the hook does (`seal: false`: not sealed).
 * `delta`: a review of the delta only, `{ from, files }` as `--delta-from` records it.
 */
export function seedReview(repo, sha, domain, { critical = 0, high = 0, reviewer = null, captures = [], at = '2026-09-30T10:00:00.000Z', seal = true, delta = null } = {}) {
  const roles = { securite: 'qa-securite', fidelite: 'qa-fidelite', donnees: 'architecte-donnees', rgpd: 'dpo' };
  const dir = join(commonDirOf(repo), 'apv', 'reviews', sha, domain);
  mkdirSync(dir, { recursive: true });
  const id = `${at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
  const report = Buffer.from(`Relecture ${domain} du commit ${sha}\n${'constat détaillé. '.repeat(20)}\n`);
  writeFileSync(join(dir, `${id}-rapport.md`), report);
  const stored = captures.map(([viewport, theme], k) => {
    const data = png(k + 1);
    const file = `${id}-${viewport}-${theme}.png`;
    writeFileSync(join(dir, file), data);
    return { viewport, theme, file, sha256: digest(data), bytes: data.length };
  });
  const record = { version: 1, id, commit: sha, domain, reviewer: reviewer ?? `apv:${roles[domain]}`, at, findings: { critical, high, medium: 0, low: 0 },
    report: { file: `${id}-rapport.md`, sha256: digest(report), bytes: report.length }, captures: stored, ...(delta ? { delta } : {}) };
  const content = Buffer.from(JSON.stringify(record, null, 2));
  writeFileSync(join(dir, `${id}.json`), content);
  if (seal) writeFileSync(join(dir, `${id}.sig`), `${sign(TEST_KEY, 'review', digest(content))}\n`);
  return record;
}

/** Every combination of the default captures. */
export const ALL_CAPTURES = [['desktop', 'light'], ['desktop', 'dark'], ['phone', 'light'], ['phone', 'dark']];
