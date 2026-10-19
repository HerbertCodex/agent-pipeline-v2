import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { PipelineError } from '../domain/errors.js';
import { globToRegExp } from '../db/glob.js';
import { anchorKey, anchoredQuote, readOperatorMessages } from '../rules/operator.js';

/**
 * The migrations a release would put online (`release.migrations`, docs/CLI.md « apv release »): the operator applies them
 * to the production database himself, then types « migration <nom ou version> appliquée » in a Claude Code session. The
 * sentence is read in the operator journal (signed by the UserPromptSubmit hook, never by an agent), as the waivers are.
 */
export interface Migrations {
  /** Added since production, not confirmed yet: nothing is released. */
  pending: string[];
  /** Added since production, confirmed by the operator. */
  confirmed: string[];
  /** Changed, removed or renamed since production: a published migration never changes. */
  modified: string[];
}

/** The numeric prefix of the file name (`20261019120000_x.sql` gives `20261019120000`), or null. */
export const migrationVersion = (file: string): string | null => /^\d+/.exec(basename(file))?.[0] ?? null;

/** The sentence the operator types once `file` is applied in production (the version when the name has one). */
export const confirmationSentence = (file: string): string => `migration ${migrationVersion(file) ?? basename(file)} appliquée`;

/** Every sentence that confirms `file`: by its path, its name, its name without extension or its version; with or without accent. */
function confirmations(file: string): string[] {
  const name = basename(file);
  const names = new Set([file, name, name.replace(/\.[^.]+$/, ''), migrationVersion(file)].filter((n): n is string => !!n));
  return [...names].flatMap(n => [`migration ${n} appliquée`, `migration ${n} appliquee`]);
}

/**
 * The migrations matching `patterns` between `production` and `sha` (`git diff --name-status --no-renames`), the added ones
 * split by the operator's confirmation. The tool never shows a confirmation as a sentence of its own (always quoted inside a
 * longer one), so a refusal pasted back is no confirmation: the journal keeps hashes of whole sentences.
 */
export function releaseMigrations(repo: string, common: string, patterns: readonly string[], production: string, sha: string): Migrations {
  const out: Migrations = { pending: [], confirmed: [], modified: [] };
  if (!patterns.length) return out;
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'diff', '--name-status', '--no-renames', '-z', production, sha, '--'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new PipelineError('RELEASE', `git diff ${production.slice(0, 12)} ${sha.slice(0, 12)} en échec : ${(r.stderr ?? '').trim()}`);
  const matchers = patterns.map(globToRegExp);
  const fields = (r.stdout ?? '').split('\0');
  const anchor = anchorKey(common);
  const messages = readOperatorMessages(common, anchor.key);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i]!;
    const file = fields[i + 1]!;
    if (!matchers.some(m => m.test(file))) continue;
    if (status !== 'A') out.modified.push(file);
    else if (confirmations(file).some(s => anchoredQuote(messages, s, anchor.key))) out.confirmed.push(file);
    else out.pending.push(file);
  }
  return out;
}

/** What a release says of its migrations; empty when it has none. */
export function migrationLines(m: Migrations): string[] {
  return [
    ...(m.confirmed.length ? [`Migration(s) confirmée(s) appliquée(s) par l'opérateur : ${m.confirmed.join(', ')}.`] : []),
    ...(m.pending.length ? [`Migration(s) en attente : ${m.pending.join(', ')}.`] : []),
  ];
}

/** Why a release waits: what to apply, then what to type (quoted, never a sentence alone). */
export const pendingReason = (pending: readonly string[]): string =>
  `migration(s) ${pending.join(', ')} à appliquer en production puis taper dans une session Claude Code ${pending.map(f => `« ${confirmationSentence(f)} »`).join(', ')}`;

export const modifiedReason = (modified: readonly string[]): string =>
  `migration(s) déjà publiée(s) modifiée(s), supprimée(s) ou renommée(s) depuis la production : ${modified.join(', ')} (une migration publiée ne change pas : en ajouter une nouvelle)`;
