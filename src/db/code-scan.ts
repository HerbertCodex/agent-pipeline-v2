import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandGlobs, globToRegExp } from './glob.js';
import { RULES, type Finding } from './checks.js';

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Text of the call arguments starting at `open` (the index of `(`), bounded to keep the scan linear. */
function callArguments(text: string, open: number): string {
  let depth = 0;
  const limit = Math.min(text.length, open + 400);
  for (let i = open; i < limit; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1, limit);
}

/**
 * `select('*')`, `select('id, events(*)')`, `.select()` without argument (supabase-js returns every
 * column) and `select *` in SQL strings. `select('*', { count: 'exact', head: true })` only counts
 * rows and is accepted.
 */
export function scanSelectStar(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const push = (index: number, message: string) => findings.push({ rule: RULES.selectStar, severity: 'error', file, line: lineAt(text, index), target: file, message });
  const call = /\.select\s*\(/g;
  for (let match = call.exec(text); match; match = call.exec(text)) {
    const open = match.index + match[0].length - 1;
    const args = callArguments(text, open);
    if (args.trim() === '') {
      // Only a query builder chain (`.from(...)`, `.insert(...)`) returns rows; `input.select()` selects text.
      const before = text.slice(Math.max(0, match.index - 600), match.index);
      const statement = before.slice(before.lastIndexOf(';') + 1);
      if (/\.(from|insert|upsert|update|delete|rpc)\s*\(/.test(statement)) {
        push(match.index, '.select() sans argument renvoie toutes les colonnes ; nommer les colonnes utiles');
      }
      continue;
    }
    const literal = /^\s*(['"`])([\s\S]*?)\1/.exec(args);
    if (!literal) continue;
    const columns = literal[2] ?? '';
    if (!/(^|[\s,(:])\*/.test(columns)) continue;
    if (/head\s*:\s*true/.test(args.slice(literal[0].length))) continue;
    push(match.index, `.select(${literal[1]}${columns.trim()}${literal[1]}) lit toutes les colonnes ; nommer les colonnes utiles`);
  }
  const sql = /\bselect\s+(?:distinct\s+)?\*(?![\w*])/gi;
  for (let match = sql.exec(text); match; match = sql.exec(text)) {
    push(match.index, `« ${match[0]} » dans le code : nommer les colonnes utiles`);
  }
  return findings;
}

export function scanCode(root: string, globs: readonly string[], exclude: readonly string[]): { files: string[]; findings: Finding[] } {
  const excluded = exclude.map(globToRegExp);
  const files = expandGlobs(root, globs).filter((file) => !excluded.some((re) => re.test(file)));
  const findings: Finding[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    findings.push(...scanSelectStar(file, text));
  }
  return { files, findings };
}
