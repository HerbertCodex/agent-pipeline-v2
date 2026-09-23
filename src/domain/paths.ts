import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Absolute path with every symlink of its longest existing ancestor resolved, the missing tail kept as
 * written. Git reports resolved roots (macOS: /var is /private/var), so paths compared with a repository
 * root, or displayed relative to it, must be resolved the same way, including paths that do not exist yet.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}
