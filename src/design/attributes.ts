import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRead } from '../run/git-probe.js';

/** Root attributes file of the repository, where the validated-mockup line is written. */
export const GITATTRIBUTES = '.gitattributes';

/**
 * Line that keeps the validated mockups out of the whitespace checks (`git diff --check`, and the CI of the
 * projects that run it): a mockup is registered under its sha256, so its trailing spaces cannot be cleaned
 * without changing its fingerprint.
 */
export const designAttributeLine = (dir: string): string => `${dir}/*.html -whitespace`;

export type DesignAttributeStatus = 'present' | 'missing' | 'added' | 'ineffective';
export interface DesignAttributeResult { file: string; line: string; status: DesignAttributeStatus }

/** Whether Git sees the `whitespace` attribute unset for a mockup of `dir` (any matching line counts). */
export function designWhitespaceUnset(repo: string, dir: string): boolean {
  const probe = `${dir}/apv-sonde-validee.html`;
  const out = gitRead(repo, ['check-attr', 'whitespace', '--', probe]);
  return out !== null && out.trim().endsWith(': whitespace: unset');
}

/** State of the line for `dir`, without writing anything. */
export function designAttributeState(repo: string, dir: string): DesignAttributeResult {
  return { file: GITATTRIBUTES, line: designAttributeLine(dir), status: designWhitespaceUnset(repo, dir) ? 'present' : 'missing' };
}

/**
 * Adds the line to the root `.gitattributes` when Git does not already unset `whitespace` for the mockups of `dir`
 * (the file is created when absent, its content kept otherwise). `dryRun` reports `added` without writing. After
 * writing, Git is asked again: `ineffective` when another attributes file still overrides the line.
 */
export function ensureDesignAttribute(repo: string, dir: string, dryRun = false): DesignAttributeResult {
  const state = designAttributeState(repo, dir);
  if (state.status === 'present' || dryRun) return { ...state, status: state.status === 'present' ? 'present' : 'added' };
  const path = join(repo, GITATTRIBUTES);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const separator = before === '' || before.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${before}${separator}# Maquettes validées (apv design register) : empreinte sha256 figée, espaces de fin de ligne gardés hors de git diff --check\n${state.line}\n`);
  return { ...state, status: designWhitespaceUnset(repo, dir) ? 'added' : 'ineffective' };
}

/** Trailing whitespace or blank lines at the end of a file: what `git diff --check` reports. */
export function hasWhitespaceErrors(path: string): boolean {
  const text = readFileSync(path, 'utf8');
  return /[ \t\r]+$/m.test(text) || /\n[ \t\r]*\n$/.test(text);
}
