import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from './domain/contracts.js';
import { hash } from './domain/hash.js';
import { qaSchema } from './lifecycle/contracts.js';
import { readRole } from './knowledge/catalog.js';

/** Identifies the QA implementation actually loaded from this installation, independently of cwd. */
export function qaRuntime() {
    const files = ['lifecycle/contracts.js', 'lifecycle/service.js', 'lifecycle/roles.js', 'adapters/invocations.js'];
    return {
        version: VERSION,
        installation: fileURLToPath(new URL('../', import.meta.url)),
        qaEngineHash: hash(files.map(path => [path, readFileSync(new URL(path, import.meta.url), 'utf8')])),
        qaSchemaHash: hash(qaSchema.json),
        qaInstructionsHash: readRole('qa').sha256,
    };
}
