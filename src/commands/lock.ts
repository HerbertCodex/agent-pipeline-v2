import type { CommandIO } from './io.js';

/** Placeholder: `apv lock` is built on another branch of phase 1; integration replaces this file. */
export async function run(_args: string[], io: CommandIO): Promise<number> {
  io.stderr('apv lock : non disponible dans cette branche\n');
  return 2;
}
