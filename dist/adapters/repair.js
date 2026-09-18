import { s, parseJson } from '../domain/schema.js';
import { invariant, PipelineError } from '../domain/errors.js';
export const repairPatchSchema = s.object({ patches: s.array(s.object({
        path: s.string(1, 500), op: s.default(s.enum(['set', 'remove']), 'set'), valueJson: s.default(s.string(1, 200000), 'null'),
    }), 1, 30) });
export const repairPatchRules = 'Patches run sequentially on a copy. Parents must already exist. set creates/replaces an object field, replaces an existing array item, or appends at the array length (or -). remove deletes an existing object field or array item; later array indexes shift. Sparse arrays, root replacement and prototype paths are forbidden. The entire result must satisfy targetSchema and controller rules.';
/** Set or remove fields/items beneath existing parents; never traverse prototypes. Array removals shift subsequent indexes. The complete result still passes the original schema and domain rules. */
export function applyRepairPatch(previous, patch) {
    const result = structuredClone(previous);
    for (const { path, op, valueJson } of repairPatchSchema.parse(patch).patches) {
        invariant(path.startsWith('/') && !/~(?![01])/u.test(path), 'ROLE_OUTPUT', 'Patch requires a JSON pointer');
        const keys = path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
        invariant(keys.every(k => k && !['__proto__', 'constructor', 'prototype'].includes(k)), 'ROLE_OUTPUT', 'Unsafe repair path');
        let parent = result;
        for (const key of keys.slice(0, -1)) {
            invariant(parent !== null && typeof parent === 'object' && Object.hasOwn(parent, key), 'ROLE_OUTPUT', `Unknown repair path ${path}`);
            parent = parent[key];
        }
        const last = keys.at(-1);
        invariant(parent !== null && typeof parent === 'object', 'ROLE_OUTPUT', `Invalid repair field ${path}`);
        if (Array.isArray(parent)) {
            const append = op === 'set' && (last === '-' || last === String(parent.length));
            invariant(append || /^(?:0|[1-9][0-9]*)$/.test(last) && Number(last) < parent.length, 'ROLE_OUTPUT', `Invalid repair field ${path}`);
            if (append) {
                parent.push(parseJson(valueJson));
                continue;
            }
        }
        if (op === 'remove') {
            invariant(Object.hasOwn(parent, last), 'ROLE_OUTPUT', 'Remove applies only to existing fields or array items');
            if (Array.isArray(parent))
                parent.splice(Number(last), 1);
            else
                delete parent[last];
        }
        else
            parent[last] = parseJson(valueJson);
    }
    invariant(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024, 'ROLE_OUTPUT', 'Repaired document exceeds 1 MiB');
    return result;
}
export function repairError(error) {
    const path = /^(\$[^:]*):/.exec(error.message)?.[1] ?? null;
    return { code: error.code, path, message: error.message.slice(0, 4000) };
}
//# sourceMappingURL=repair.js.map