import { invariant, PipelineError } from './errors.js';
function make(json, parse) {
    return { json, parse: (v, p = '$') => parse(v, p) };
}
export const s = {
    string(min = 1, max = 10000, pattern) {
        return make({ type: 'string', minLength: min, maxLength: max,
            allOf: [{ pattern: '^[^\\u0000]*$' }],
            ...(pattern ? { pattern: pattern.source } : {}) }, (v, p) => {
            invariant(typeof v === 'string', 'SCHEMA', `${p}: expected string`);
            invariant(!v.includes('\0'), 'SCHEMA', `${p}: invalid string, a NUL character is never accepted`);
            invariant(v.length >= min && v.length <= max, 'SCHEMA', `${p}: invalid string of ${v.length} characters, expected between ${min} and ${max}`);
            if (pattern)
                invariant(pattern.test(v), 'SCHEMA', `${p}: invalid string, expected to match ${pattern.source}`);
            return v;
        });
    },
    number(min, max) {
        return make({ type: 'integer', minimum: min, maximum: max }, (v, p) => {
            invariant(typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max, 'SCHEMA', `${p}: expected integer in [${min}, ${max}]`);
            return v;
        });
    },
    finite(min, max) {
        return make({ type: 'number', minimum: min, maximum: max }, (v, p) => {
            invariant(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max, 'SCHEMA', `${p}: expected finite number in [${min}, ${max}]`);
            return v;
        });
    },
    nullable(schema) {
        return make({ anyOf: [schema.json, { type: 'null' }] }, (v, p) => v === null ? null : schema.parse(v, p));
    },
    boolean() {
        return make({ type: 'boolean' }, (v, p) => {
            invariant(typeof v === 'boolean', 'SCHEMA', `${p}: expected boolean`);
            return v;
        });
    },
    enum(values) {
        return make({ type: 'string', enum: [...values] }, (v, p) => {
            invariant(typeof v === 'string' && values.includes(v), 'SCHEMA', `${p}: expected ${values.join('|')}`);
            return v;
        });
    },
    literal(value) {
        return make({ const: value }, (v, p) => {
            invariant(v === value, 'SCHEMA', `${p}: expected ${value}`);
            return value;
        });
    },
    array(item, min = 0, max = 1000) {
        return make({ type: 'array', items: item.json, minItems: min, maxItems: max }, (v, p) => {
            invariant(Array.isArray(v) && v.length >= min && v.length <= max, 'SCHEMA', `${p}: invalid array`);
            return v.map((x, i) => item.parse(x, `${p}[${i}]`));
        });
    },
    default(schema, value) {
        return make({ ...schema.json, default: value }, (v, p) => schema.parse(v === undefined ? structuredClone(value) : v, p));
    },
    object(shape) {
        const properties = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.json]));
        const required = Object.keys(shape).filter(k => !Object.hasOwn(shape[k].json, 'default'));
        return make({ type: 'object', properties, required, additionalProperties: false }, (v, p) => {
            invariant(v !== null && typeof v === 'object' && !Array.isArray(v), 'SCHEMA', `${p}: expected object`);
            const input = v;
            for (const key of Object.keys(input)) {
                invariant(Object.hasOwn(shape, key), 'SCHEMA', `${p}: unknown property ${key}`);
            }
            const out = {};
            for (const [key, schema] of Object.entries(shape))
                out[key] = schema.parse(input[key], `${p}.${key}`);
            return out;
        });
    },
};
export function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch (cause) {
        throw new PipelineError('JSON', 'Invalid JSON', { cause });
    }
}
//# sourceMappingURL=schema.js.map