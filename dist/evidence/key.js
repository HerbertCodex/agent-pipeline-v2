import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { release } from 'node:os';
import { VERSION } from '../domain/contracts.js';
import { hash, hashFile } from '../domain/hash.js';
import { PipelineError } from '../domain/errors.js';
export async function executableIdentity(command, cwd, env) {
    const candidates = isAbsolute(command) || command.includes('/') ? [resolve(cwd, command)] : (env['PATH'] ?? '/usr/bin:/bin').split(delimiter).map(p => resolve(p || cwd, command));
    for (const file of candidates) {
        try {
            accessSync(file, constants.X_OK);
            const path = realpathSync(file);
            return { path, sha256: await hashFile(path) };
        }
        catch { /* Try the next PATH entry. */ }
    }
    throw new PipelineError('EXECUTABLE', `Executable unavailable: ${command}`);
}
export function environmentIdentity(id, env, extra) {
    return hash({ id, env, extra, node: process.version, platform: process.platform, arch: process.arch,
        kernel: release(), runner: VERSION });
}
export function proofKey(input) {
    // Exact commit, not a partial package.json fingerprint. Full lockfile content
    // is transitively covered by Git. Environment pinning is still an operator duty.
    return hash({ protocol: 'apv2-receipt-1', runner: VERSION, ...input });
}
//# sourceMappingURL=key.js.map