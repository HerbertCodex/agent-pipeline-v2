import { isAbsolute, normalize } from 'node:path';
import { s, type Infer } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';

/** Default folder of validated mockups, relative to the repository root (`design.dir` overrides it). */
export const DEFAULT_DESIGN_DIR = 'docs/design';

/** The `design` section of `.apv/config.json` (docs/DESIGN.md). */
export const designSchema = s.object({
  /** Folder of validated mockups, relative to the repository root. */
  dir: s.optional(s.string(0, 4096)),
});
export type DesignSection = Infer<typeof designSchema>;

/**
 * The validated-mockup folder of a `design` section: relative, inside the repository, without spaces,
 * normalized (no trailing slash). Throws a CONFIG error that names the faulty value.
 */
export function designDir(section: DesignSection | undefined): string {
  const dir = section?.dir;
  if (dir === undefined) return DEFAULT_DESIGN_DIR;
  invariant(dir.trim() !== '', 'CONFIG', 'design.dir doit être un chemin non vide');
  const clean = normalize(dir.trim()).replace(/\\/g, '/').replace(/\/+$/, '');
  invariant(!isAbsolute(clean) && clean !== '..' && !clean.startsWith('../') && clean !== '.', 'CONFIG', `design.dir doit être un dossier relatif, dans le dépôt (${dir})`);
  invariant(!/\s/.test(clean), 'CONFIG', `design.dir ne contient pas d'espace (${dir})`);
  return clean;
}
