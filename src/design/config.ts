import { isAbsolute, normalize } from 'node:path';
import { s, type Infer } from '../domain/schema.js';
import { errorMessage, invariant } from '../domain/errors.js';
import { matches } from '../policy/policy.js';

/** Default folder of validated mockups, relative to the repository root (`design.dir` overrides it). */
export const DEFAULT_DESIGN_DIR = 'docs/design';

/** A group of validated mockups: a sub-folder of `design.dir` and the name (slug) patterns it takes. */
export const designGroupSchema = s.object({
  /** Sub-folder of `design.dir`, relative (`admin`, `produit/ecrans`). */
  dir: s.string(0, 200),
  /** Portable globs (`*`, `?`) matched against the mockup name (`admin-*`). */
  match: s.array(s.string(0, 100), 1, 50),
});

/** The `design` section of `.apv/config.json` (docs/DESIGN.md). */
export const designSchema = s.object({
  /** Folder of validated mockups, relative to the repository root. */
  dir: s.optional(s.string(0, 4096)),
  /** Ordered groups: the first whose patterns match the name decides the sub-folder of a mockup. */
  groups: s.optional(s.array(designGroupSchema, 0, 50)),
  /** Sub-folder of the names no group matches; absent: the root of `dir`. */
  defaultGroup: s.optional(s.string(0, 200)),
});
export type DesignSection = Infer<typeof designSchema>;

export interface DesignGroup { dir: string; match: string[] }

/** Validated `design` section: folder, groups in order and the folder of the names no group takes (null: the root). */
export interface DesignSettings { dir: string; groups: DesignGroup[]; defaultGroup: string | null }

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

const GROUP_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * A group sub-folder (`design.groups[].dir`, `design.defaultGroup`, `--group`), without its trailing slash:
 * relative to `design.dir`, without `..`, `.` or empty segment, without spaces; letters, digits, `.`, `_` and `-`
 * only. Throws a CONFIG error that names `field` and the faulty value.
 */
export function groupDir(value: string, field: string): string {
  const clean = value.trim().replace(/\/+$/, '');
  invariant(clean !== '', 'CONFIG', `${field} doit être un sous-dossier non vide`);
  invariant(!/\s/.test(clean), 'CONFIG', `${field} ne contient pas d'espace (${value})`);
  invariant(!clean.startsWith('/') && !/^[a-zA-Z]:/.test(clean) && !clean.includes('\\'), 'CONFIG', `${field} doit être un sous-dossier relatif de design.dir (${value})`);
  invariant(!clean.split('/').some(p => p === '..'), 'CONFIG', `${field} ne contient pas « .. » (${value})`);
  invariant(clean.split('/').every(p => GROUP_SEGMENT.test(p)), 'CONFIG',
    `${field} invalide (${value}) : lettres, chiffres, « . », « _ » et « - », segments séparés par « / », sans segment vide ni commençant par un point`);
  return clean;
}

/** Every setting of a `design` section, validated (CONFIG error naming the faulty field otherwise). */
export function designSettings(section: DesignSection | undefined): DesignSettings {
  const dir = designDir(section);
  const groups: DesignGroup[] = [];
  if (section?.groups !== undefined) {
    invariant(section.groups.length > 0, 'CONFIG', 'design.groups est vide : retirez-le, ou déclarez au moins un groupe { "dir": "<sous-dossier>", "match": ["<motif>"] }');
    section.groups.forEach((group, i) => {
      const field = `design.groups[${i}]`;
      const gdir = groupDir(group.dir, `${field}.dir`);
      invariant(!groups.some(g => g.dir === gdir), 'CONFIG', `${field}.dir : deux groupes ne peuvent pas avoir le même dossier (${gdir})`);
      const patterns = group.match.map((pattern, j) => {
        const clean = pattern.trim();
        invariant(clean !== '', 'CONFIG', `${field}.match[${j}] : motif vide`);
        invariant(!clean.includes('/'), 'CONFIG', `${field}.match[${j}] : le motif porte sur le nom de la maquette, sans « / » (${pattern})`);
        try { matches('probe', clean); } catch (error) { invariant(false, 'CONFIG', `${field}.match[${j}] : ${errorMessage(error)}`); }
        return clean;
      });
      groups.push({ dir: gdir, match: patterns });
    });
  }
  const defaultGroup = section?.defaultGroup === undefined ? null : groupDir(section.defaultGroup, 'design.defaultGroup');
  return { dir, groups, defaultGroup };
}

/** Whether the section declares groups (`design.groups` or `design.defaultGroup`). */
export const hasGroups = (settings: DesignSettings): boolean => settings.groups.length > 0 || settings.defaultGroup !== null;

/** Declared group folders: those of `design.groups` in order, then `design.defaultGroup` when it is another one. */
export function declaredGroups(settings: DesignSettings): string[] {
  return [...new Set([...settings.groups.map(g => g.dir), ...(settings.defaultGroup ? [settings.defaultGroup] : [])])];
}

/** Group a name falls in by the patterns: the first group that matches, else `defaultGroup`, else null (the root of `dir`). */
export function groupForName(settings: DesignSettings, slug: string): string | null {
  return settings.groups.find(g => g.match.some(pattern => matches(slug, pattern)))?.dir ?? settings.defaultGroup;
}

/** Folder of a group: `<dir>/<group>`, or `dir` itself for the root (null). */
export const groupFolder = (settings: DesignSettings, group: string | null): string => group ? `${settings.dir}/${group}` : settings.dir;
