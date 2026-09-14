import type { JsonSchema } from '../domain/schema.js';
// Provider transport, not the authoritative validator. Structured-output APIs
// support only a subset of JSON Schema. Keep the portable shape/enum vocabulary;
// the original Schema.parse still enforces every bound, pattern and NUL check.
// In particular, `allOf` and defaults must not leak into a strict provider schema.
export function strictSchema(json: JsonSchema): JsonSchema {
    const out: JsonSchema = {};
    if (Object.hasOwn(json, 'const')) {
        const value = json['const'];
        out['type'] = typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
        out['enum'] = [value];
    }
    for (const key of ['type', 'enum', 'description', 'title'] as const) {
        if (Object.hasOwn(json, key))
            out[key] = structuredClone(json[key]);
    }
    if (json['properties'] && typeof json['properties'] === 'object') {
        out['properties'] = Object.fromEntries(Object.entries(json['properties']).map(([key, value]) => [key, strictSchema(value as JsonSchema)]));
        out['required'] = Object.keys(out['properties'] as object);
        out['additionalProperties'] = false;
    }
    if (json['items'] && typeof json['items'] === 'object')
        out['items'] = strictSchema(json['items'] as JsonSchema);
    if (Array.isArray(json['anyOf']))
        out['anyOf'] = json['anyOf'].map(value => strictSchema(value as JsonSchema));
    return out;
}
