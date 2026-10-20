import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { invariant } from '../domain/errors.js';

/** Whether `rel` is a repository-relative path that stays inside the repository, lexically. */
export function lexicallyInside(rel: string): boolean {
  const clean = normalize(rel);
  return rel !== '' && !isAbsolute(rel) && clean !== '..' && !clean.startsWith('../') && !clean.startsWith('..\\');
}

/**
 * The first component of `rel`, from the repository down to the file itself, that is a symbolic link, as a
 * repository-relative path; null when none is. The walk stops at the first missing component (what does not exist
 * yet is created as a real folder or file). A path that leaves the repository lexically counts as linked (`rel`).
 */
export function linkedComponent(repo: string, rel: string): string | null {
  if (!lexicallyInside(rel)) return rel;
  const parts = normalize(rel).split(/[\\/]/).filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const part = parts.slice(0, i).join('/');
    let link: boolean;
    try { link = lstatSync(join(repo, part)).isSymbolicLink(); } catch { return null; }
    if (link) return part;
  }
  return null;
}

/** Refuses (`DESIGN_LINK`) a path of the repository that goes through a symbolic link: the write could land outside. */
export function assertNoLink(repo: string, rel: string, what: string): void {
  const linked = linkedComponent(repo, rel);
  invariant(linked === null, 'DESIGN_LINK', `${what} ${rel} passe par un lien symbolique (${linked}) : refusé, l'écriture pourrait sortir du dépôt`);
}

/** After creating it: the real path of the folder `relDir` must be exactly the folder of the repository (`DESIGN_LINK`). */
export function assertRealFolder(repo: string, relDir: string): void {
  const expected = join(realpathSync(repo), relDir);
  invariant(realpathSync(join(repo, relDir)) === expected, 'DESIGN_LINK', `Le dossier ${relDir} ne mène pas dans le dépôt (lien symbolique) : refusé`);
}

/** Real path of `rel` when it exists and its real path is inside the real repository; null otherwise. */
export function realInside(repo: string, rel: string): string | null {
  if (!lexicallyInside(rel)) return null;
  let real: string;
  try { real = realpathSync(resolve(repo, rel)); } catch { return null; }
  const inner = relative(realpathSync(repo), real);
  return inner !== '' && !inner.startsWith('..') && !isAbsolute(inner) ? real : null;
}
