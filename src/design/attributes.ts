import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRead } from '../run/git-probe.js';

/** Root attributes file of the repository, where the validated-mockup line is written. */
export const GITATTRIBUTES = '.gitattributes';

/**
 * Line that keeps the validated mockups out of the whitespace checks (`git diff --check`, and the CI of the
 * projects that run it): a mockup is registered under its sha256, so its trailing spaces cannot be cleaned
 * without changing its fingerprint. `**` covers the root of the folder and its group sub-folders.
 */
export const designAttributeLine = (dir: string): string => `${dir}/**/*.html -whitespace`;

/** Line written before the groups (3.0.0-alpha.11 and earlier): the root of the folder only. */
export const legacyDesignAttributeLine = (dir: string): string => `${dir}/*.html -whitespace`;

export type DesignAttributeStatus = 'present' | 'missing' | 'added' | 'replaced' | 'ineffective';
export interface DesignAttributeResult {
  file: string;
  line: string;
  status: DesignAttributeStatus;
  /**
   * The root-only line found in `.gitattributes` while groups exist: insufficient (state `missing`), or
   * replaced by the line that covers the sub-folders (`replaced`, and `ineffective` after a replacement).
   */
  previous?: string;
}

/** Whether Git sees the `whitespace` attribute unset for a mockup of `folder` (any matching line counts). */
function unsetIn(repo: string, folder: string): boolean {
  const out = gitRead(repo, ['check-attr', 'whitespace', '--', `${folder}/apv-sonde-validee.html`]);
  return out !== null && out.trim().endsWith(': whitespace: unset');
}

/**
 * Whether Git sees the `whitespace` attribute unset for a mockup of `dir` and of each of its group
 * sub-folders `groups` (relative to `dir`).
 */
export function designWhitespaceUnset(repo: string, dir: string, groups: readonly string[] = []): boolean {
  return [dir, ...groups.map(g => `${dir}/${g}`)].every(folder => unsetIn(repo, folder));
}

function legacyLinePresent(repo: string, dir: string): boolean {
  const path = join(repo, GITATTRIBUTES);
  if (!existsSync(path)) return false;
  const legacy = legacyDesignAttributeLine(dir);
  return readFileSync(path, 'utf8').split('\n').some(line => line.trim() === legacy);
}

/** State of the line for `dir` and its groups, without writing anything. */
export function designAttributeState(repo: string, dir: string, groups: readonly string[] = []): DesignAttributeResult {
  const present = designWhitespaceUnset(repo, dir, groups);
  const previous = !present && groups.length > 0 && legacyLinePresent(repo, dir) ? legacyDesignAttributeLine(dir) : undefined;
  return { file: GITATTRIBUTES, line: designAttributeLine(dir), status: present ? 'present' : 'missing', ...(previous && { previous }) };
}

/**
 * Makes Git unset `whitespace` for the mockups of `dir` and of its group sub-folders: nothing when it already does;
 * otherwise the root-only line of an earlier version is replaced in place by the line that covers the sub-folders
 * (`replaced`), or the line is appended to the root `.gitattributes` (`added`; the file is created when absent, its
 * content kept otherwise). `dryRun` reports the change without writing. After writing, Git is asked again:
 * `ineffective` when another attributes file still overrides the line.
 */
export function ensureDesignAttribute(repo: string, dir: string, dryRun = false, groups: readonly string[] = []): DesignAttributeResult {
  const state = designAttributeState(repo, dir, groups);
  if (state.status === 'present') return state;
  const status: DesignAttributeStatus = state.previous ? 'replaced' : 'added';
  if (dryRun) return { ...state, status };
  const path = join(repo, GITATTRIBUTES);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (state.previous) {
    let done = false;
    // The first root-only line becomes the new line, at its place (its comment kept); a duplicate is dropped.
    const lines = before.split('\n').flatMap(line => {
      if (line.trim() !== state.previous) return [line];
      if (done) return [];
      done = true;
      return [state.line];
    });
    writeFileSync(path, lines.join('\n'));
  } else {
    const separator = before === '' || before.endsWith('\n') ? '' : '\n';
    writeFileSync(path, `${before}${separator}# Maquettes validées (apv design register) : empreinte sha256 figée, espaces de fin de ligne gardés hors de git diff --check\n${state.line}\n`);
  }
  return { ...state, status: designWhitespaceUnset(repo, dir, groups) ? status : 'ineffective' };
}

/** Trailing whitespace or blank lines at the end of a file: what `git diff --check` reports. */
export function hasWhitespaceErrors(path: string): boolean {
  const text = readFileSync(path, 'utf8');
  return /[ \t\r]+$/m.test(text) || /\n[ \t\r]*\n$/.test(text);
}
