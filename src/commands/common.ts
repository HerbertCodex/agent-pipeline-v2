import { parseArgs, type ParseArgsConfig } from 'node:util';
import { resolve } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import type { CommandIO } from './io.js';

/** Exit codes shared by every `apv` command. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** Wrong invocation: unknown option, missing argument. Reported with the command usage, exit 2. */
export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}

type Options = NonNullable<ParseArgsConfig['options']>;
export function parse<T extends Options>(args: string[], options: T) {
  try { return parseArgs({ args, options, allowPositionals: true, strict: true }); }
  catch (error) { throw new UsageError(errorMessage(error)); }
}

export function repoPath(io: CommandIO, value: string | boolean | undefined): string {
  return resolve(io.cwd, typeof value === 'string' ? value : '.');
}

export function list(value: string | boolean | undefined): string[] {
  return typeof value === 'string' ? value.split(',').map(x => x.trim()).filter(Boolean) : [];
}

export function json(io: CommandIO, value: unknown): void { io.stdout(`${JSON.stringify(value, null, 2)}\n`); }

/**
 * Runs a command body and turns errors into an exit code: a usage error prints the usage (exit 2), a known
 * pipeline error prints its code and message (exit 1). Anything else is a bug and propagates.
 */
export async function guard(io: CommandIO, usage: string, body: () => Promise<number>): Promise<number> {
  try { return await body(); }
  catch (error) {
    if (error instanceof UsageError) { io.stderr(`Erreur : ${error.message}\n\n${usage}\n`); return EXIT.usage; }
    if (error instanceof PipelineError) { io.stderr(`Erreur [${error.code}] : ${error.message}\n`); return EXIT.failed; }
    throw error;
  }
}

/** Fixed-width text table for terminal summaries. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(headers), line(widths.map(w => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
