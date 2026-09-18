import { PipelineError } from '../domain/errors.js';
export declare const repairPatchSchema: import("../domain/schema.js").Schema<{
    readonly patches: {
        readonly path: string;
        readonly op: "remove" | "set";
        readonly valueJson: string;
    }[];
}>;
export declare const repairPatchRules = "Patches run sequentially on a copy. Parents must already exist. set creates/replaces an object field, replaces an existing array item, or appends at the array length (or -). remove deletes an existing object field or array item; later array indexes shift. Sparse arrays, root replacement and prototype paths are forbidden. The entire result must satisfy targetSchema and controller rules.";
/** Set or remove fields/items beneath existing parents; never traverse prototypes. Array removals shift subsequent indexes. The complete result still passes the original schema and domain rules. */
export declare function applyRepairPatch(previous: unknown, patch: unknown): unknown;
export declare function repairError(error: PipelineError): {
    code: string;
    path: string | null;
    message: string;
};
