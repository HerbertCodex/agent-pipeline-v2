import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { release } from 'node:os';
import { VERSION, type Gate } from '../domain/contracts.js';
import { hash, hashFile } from '../domain/hash.js';
import { PipelineError } from '../domain/errors.js';
export async function executableIdentity(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ path: string; sha256: string }> {
  const candidates = isAbsolute(command) || command.includes('/') ? [resolve(cwd,command)] : (env['PATH'] ?? '/usr/bin:/bin').split(delimiter).map(p => resolve(p || cwd,command));
  for (const file of candidates) {
    try { accessSync(file, constants.X_OK); const path = realpathSync(file); return { path, sha256: await hashFile(path) }; }
    catch { /* Try the next PATH entry. */ }
  }
  throw new PipelineError('EXECUTABLE', `Executable unavailable: ${command}`);
}
export function environmentIdentity(id: string, env: NodeJS.ProcessEnv, extra: unknown): string {
  return hash({ id, env, extra, node: process.version, platform: process.platform, arch: process.arch,
    kernel: release(), runner: VERSION });
}
export function proofKey(input: {
  repository: string; baseSha: string; candidateSha: string; taskHash: string;
  configHash: string; environmentHash: string; workspace: string; gate: Gate;
  dependencyKeys: string[]; executable: { path: string; sha256: string };
}): string {
  // Exact commit, not a partial package.json fingerprint. Full lockfile content
  // is transitively covered by Git. Environment pinning is still an operator duty.
  return hash({ protocol: 'apv2-receipt-1', runner: VERSION, ...input });
}
