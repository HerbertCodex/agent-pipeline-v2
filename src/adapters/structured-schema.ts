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
    // A bound the producer cannot see is a bound it cannot respect: its whole document is
    // rejected afterwards for one field a few characters too long. `maxLength` and `maxItems`
    // are not portable structured-output keywords, so the bound is stated in the description,
    // which every provider carries. Schema.parse remains the authority that enforces it.
    const bounds: string[] = [];
    if (typeof json['maxLength'] === 'number')
        bounds.push(`${typeof json['minLength'] === 'number' ? json['minLength'] : 0} to ${json['maxLength']} characters`);
    if (typeof json['maxItems'] === 'number')
        bounds.push(`${typeof json['minItems'] === 'number' ? json['minItems'] : 0} to ${json['maxItems']} items`);
    if (bounds.length)
        out['description'] = out['description'] ? `${out['description']} (${bounds.join(', ')})` : bounds.join(', ');

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
