// Helpers of the tests for the rules checked before a merge (src/rules): the operator journal the UserPromptSubmit hook
// writes, and review records written as `apv review record` does, without the checkout it requires.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULES = ['preuve', 'instable', 'relecture', 'captures', 'controles', 'maquette'];

export const commonDirOf = repo => execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();

/** A message the operator typed in the session, as the hook keeps it. */
export function operatorSays(repo, text, at = new Date().toISOString()) {
  const dir = join(commonDirOf(repo), 'apv', 'operator');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'messages.jsonl'), `${JSON.stringify({ at, session: 'test', sha256: createHash('sha256').update(text).digest('hex'), text })}\n`);
}

/** The operator waives `rules` for `sha`, in one message, one line per rule. */
export function waive(repo, sha, rules = RULES, reason = 'flux GitHub du test, sans objet ici') {
  operatorSays(repo, rules.map(r => `dérogation ${r} ${sha.slice(0, 12)} : ${reason}`).join('\n'));
}

const digest = data => createHash('sha256').update(data).digest('hex');

/** A PNG of `size` bytes whose content depends on `seed` (a capture, for the tool: signature and size). */
export function png(seed, size = 2048) {
  const data = Buffer.alloc(size, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  return data;
}

/** A review record in the store, as `apv review record` writes it. */
export function seedReview(repo, sha, domain, { critical = 0, high = 0, reviewer = null, captures = [], at = '2026-09-30T10:00:00.000Z' } = {}) {
  const roles = { securite: 'qa-securite', fidelite: 'qa-fidelite', donnees: 'architecte-donnees', rgpd: 'dpo' };
  const dir = join(commonDirOf(repo), 'apv', 'reviews', sha, domain);
  mkdirSync(dir, { recursive: true });
  const id = `${at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${Math.random().toString(16).slice(2, 10)}`;
  const report = Buffer.from(`Relecture ${domain} du commit ${sha}\n${'constat détaillé. '.repeat(20)}\n`);
  writeFileSync(join(dir, `${id}-rapport.md`), report);
  const stored = captures.map(([viewport, theme], k) => {
    const data = png(k + 1);
    const file = `${id}-${viewport}-${theme}.png`;
    writeFileSync(join(dir, file), data);
    return { viewport, theme, file, sha256: digest(data), bytes: data.length };
  });
  const record = { version: 1, id, commit: sha, domain, reviewer: reviewer ?? `apv:${roles[domain]}`, at, findings: { critical, high, medium: 0, low: 0 },
    report: { file: `${id}-rapport.md`, sha256: digest(report), bytes: report.length }, captures: stored };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

/** Every combination of the default captures. */
export const ALL_CAPTURES = [['desktop', 'light'], ['desktop', 'dark'], ['phone', 'light'], ['phone', 'dark']];
