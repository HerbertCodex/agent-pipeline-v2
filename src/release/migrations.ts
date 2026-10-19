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
  /** The sentence to type for each pending migration, in the same order. */
  toType: string[];
  /** Added since production, confirmed by the operator. */
  confirmed: string[];
  /** Changed, removed or renamed since production: a published migration never changes. */
  modified: string[];
  /** Symbolic links among the migrations at the released commit: refused, their target changes unseen. */
  links: string[];
}

/** The numeric prefix of the file name (`20261019120000_x.sql` gives `20261019120000`), or null. */
export const migrationVersion = (file: string): string | null => /^\d+/.exec(basename(file))?.[0] ?? null;

/** A pattern of `release.migrations` as Git paths: a leading `./` dropped (as `expandGlobs` does). */
export const migrationPattern = (pattern: string): RegExp => globToRegExp(pattern.replace(/^(?:\.\/)+/, ''));

/** The names of `file`, shortest first: version, name without extension, name, path. */
function ownNames(file: string): string[] {
  const name = basename(file);
  return [...new Set([migrationVersion(file), name.replace(/\.[^.]+$/, ''), name, file].filter((n): n is string => !!n))];
}

/**
 * The names that designate `file`, each kept only when no other migration of `all` has it: a version shared by two
 * migrations (`0002` of two Django apps) confirms neither, only their full name or path does.
 */
function namesOf(file: string, all: readonly string[]): string[] {
  const others = new Set(all.filter(f => f !== file).flatMap(ownNames));
  return ownNames(file).filter(n => !others.has(n));
}

/** The sentence the operator types once `file` is applied in production: its shortest name no other migration has. */
export const confirmationSentence = (file: string, all: readonly string[] = [file]): string => `migration ${namesOf(file, all)[0] ?? file} appliquée`;

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new PipelineError('RELEASE', `git ${args.slice(0, 2).join(' ')} en échec : ${(r.stderr ?? '').trim()}`);
  return r.stdout ?? '';
}

/**
 * The migrations matching `patterns` between `production` and `sha` (`git diff --name-status --no-renames`), the added ones
 * split by the operator's confirmation; the symbolic links among the migrations at `sha`. The tool never shows a
 * confirmation as a sentence of its own (always quoted inside a longer one), and the journal keeps hashes of whole
 * sentences, never of questions nor quotes: a refusal pasted back is no confirmation.
 */
export function releaseMigrations(repo: string, common: string, patterns: readonly string[], production: string, sha: string): Migrations {
  const out: Migrations = { pending: [], toType: [], confirmed: [], modified: [], links: [] };
  if (!patterns.length) return out;
  const matchers = patterns.map(migrationPattern);
  const matches = (file: string): boolean => matchers.some(m => m.test(file));
  // Every migration at `sha` with its mode: the names that are unique, and the symbolic links.
  const tree = git(repo, ['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean)
    .map(line => ({ mode: line.slice(0, line.indexOf(' ')), file: line.slice(line.indexOf('\t') + 1) })).filter(e => matches(e.file));
  const all = tree.map(e => e.file);
  out.links = tree.filter(e => e.mode === '120000').map(e => e.file);
  const fields = git(repo, ['diff', '--name-status', '--no-renames', '-z', production, sha, '--']).split('\0');
  const anchor = anchorKey(common);
  const messages = readOperatorMessages(common, anchor.key);
  const confirmed = (file: string): boolean =>
    namesOf(file, all).some(n => [`migration ${n} appliquée`, `migration ${n} appliquee`].some(c => anchoredQuote(messages, c, anchor.key)));
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i]!;
    const file = fields[i + 1]!;
    if (!matches(file)) continue;
    if (status !== 'A') out.modified.push(file);
    else if (confirmed(file)) out.confirmed.push(file);
    else { out.pending.push(file); out.toType.push(confirmationSentence(file, all)); }
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
export const pendingReason = (m: Migrations): string =>
  `migration(s) ${m.pending.join(', ')} à appliquer en production puis taper dans une session Claude Code ${m.toType.map(s => `« ${s} »`).join(', ')}`;

/** Why a release is refused: a migration that is a symbolic link, or a published migration changed. */
export function refusedReason(m: Migrations): string | null {
  if (m.links.length) return `migration(s) en lien symbolique : ${m.links.join(', ')} (le contenu de sa cible change sans que la mise en ligne le voie : un fichier ordinaire attendu)`;
  if (m.modified.length) return `migration(s) déjà publiée(s) modifiée(s), supprimée(s) ou renommée(s) depuis la production : ${m.modified.join(', ')} (une migration publiée ne change pas : en ajouter une nouvelle)`;
  return null;
}
