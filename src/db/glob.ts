import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build', '.vercel', '.netlify', 'coverage', '.apv', '.apv2']);

/** Converts a glob (`**`, `*`, `?`, `{a,b}`) into an anchored regular expression over `/` paths. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) { out += '\\{'; continue; }
      out += `(?:${glob.slice(i + 1, end).split(',').map((alt) => alt.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    } else {
      out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Directory part of the glob before any wildcard, to avoid walking the whole repository. */
function staticPrefix(glob: string): string {
  const parts = glob.split('/');
  const fixed: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (/[*?{]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.join('/');
}

/** Files under `root` matching any of the globs, as sorted `/` relative paths. */
export function expandGlobs(root: string, globs: readonly string[]): string[] {
  const found = new Set<string>();
  for (const glob of globs) {
    const pattern = globToRegExp(glob.replace(/^\.\//, ''));
    const start = staticPrefix(glob.replace(/^\.\//, ''));
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
        } else if (entry.isFile()) {
          const rel = relative(root, full).split(sep).join('/');
          if (pattern.test(rel)) found.add(rel);
        }
      }
    };
    walk(start ? join(root, start) : root);
  }
  return [...found].sort();
}
