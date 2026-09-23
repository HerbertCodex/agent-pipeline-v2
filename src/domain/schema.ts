import { invariant, PipelineError } from './errors.js';

// A deliberately small schema vocabulary: runtime parsing and JSON Schema share
// the same definitions. No transforms, coercions, executable config, or $ref.
export type JsonSchema = Record<string, unknown>;
export interface Schema<T> { readonly json: JsonSchema; parse(value: unknown, path?: string): T }
export type Infer<S> = S extends Schema<infer T> ? T : never;
function make<T>(json: JsonSchema, parse: (v: unknown, p: string) => T): Schema<T> {
  return { json, parse: (v, p = '$') => parse(v, p) };
}
/** Schemas made by `s.optional`: an object leaves them out of `required` and omits an absent value. */
const OPTIONAL = new WeakSet<Schema<unknown>>();
export const s = {
  string(min = 1, max = 10000, pattern?: RegExp): Schema<string> {
    return make({ type: 'string', minLength: min, maxLength: max,
      allOf: [{ pattern: '^[^\\u0000]*$' }],
      ...(pattern ? { pattern: pattern.source } : {}) }, (v, p) => {
      invariant(typeof v === 'string', 'SCHEMA', `${p}: expected string`);
      invariant(!v.includes('\0'), 'SCHEMA', `${p}: invalid string, a NUL character is never accepted`);
      invariant(v.length >= min && v.length <= max, 'SCHEMA', `${p}: invalid string of ${v.length} characters, expected between ${min} and ${max}`);
      if (pattern) invariant(pattern.test(v), 'SCHEMA', `${p}: invalid string, expected to match ${pattern.source}`);
      return v;
    });
  },
  number(min: number, max: number): Schema<number> {
    return make({ type: 'integer', minimum: min, maximum: max }, (v, p) => {
      invariant(typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max,
        'SCHEMA', `${p}: expected integer in [${min}, ${max}]`); return v;
    });
  },
  finite(min: number, max: number): Schema<number> {
    return make({ type: 'number',minimum: min,maximum: max }, (v,p) => {
      invariant(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max,
        'SCHEMA', `${p}: expected finite number in [${min}, ${max}]`); return v;
    });
  },
  nullable<T>(schema: Schema<T>): Schema<T | null> {
    return make({ anyOf: [schema.json,{ type: 'null' }] }, (v,p) => v === null ? null : schema.parse(v,p));
  },
  boolean(): Schema<boolean> {
    return make({ type: 'boolean' }, (v, p) => {
      invariant(typeof v === 'boolean', 'SCHEMA', `${p}: expected boolean`); return v;
    });
  },
  enum<const T extends readonly string[]>(values: T): Schema<T[number]> {
    return make({ type: 'string', enum: [...values] }, (v, p) => {
      invariant(typeof v === 'string' && values.includes(v), 'SCHEMA', `${p}: expected ${values.join('|')}`);
      return v as T[number];
    });
  },
  literal<const T extends number | string>(value: T): Schema<T> {
    return make({ const: value }, (v, p) => {
      invariant(v === value, 'SCHEMA', `${p}: expected ${value}`); return value;
    });
  },
  array<T>(item: Schema<T>, min = 0, max = 1000): Schema<T[]> {
    return make({ type: 'array', items: item.json, minItems: min, maxItems: max }, (v, p) => {
      invariant(Array.isArray(v) && v.length >= min && v.length <= max, 'SCHEMA', `${p}: invalid array`);
      return (v as unknown[]).map((x, i) => item.parse(x, `${p}[${i}]`));
    });
  },
  default<T>(schema: Schema<T>, value: T): Schema<T> {
    return make({ ...schema.json, default: value }, (v, p) => schema.parse(v === undefined ? structuredClone(value) : v, p));
  },
  /** An object property that may be absent (no default): absent stays absent, never `undefined` in the output. */
  optional<T>(schema: Schema<T>): Schema<T | undefined> {
    const out = make<T | undefined>({ ...schema.json }, (v, p) => v === undefined ? undefined : schema.parse(v, p));
    OPTIONAL.add(out);
    return out;
  },
  /** A string-keyed map whose keys match `key` and whose values all follow `value`. */
  record<T>(key: RegExp, value: Schema<T>, max = 1000): Schema<Record<string, T>> {
    return make({ type: 'object', propertyNames: { pattern: key.source }, additionalProperties: value.json, maxProperties: max }, (v, p) => {
      invariant(v !== null && typeof v === 'object' && !Array.isArray(v), 'SCHEMA', `${p}: expected object`);
      const entries = Object.entries(v as Record<string, unknown>);
      invariant(entries.length <= max, 'SCHEMA', `${p}: too many properties, expected at most ${max}`);
      const out: Record<string, T> = {};
      for (const [k, x] of entries) {
        invariant(key.test(k), 'SCHEMA', `${p}: invalid key ${k}, expected to match ${key.source}`);
        // defineProperty: a `__proto__` key stays a plain property instead of changing the prototype.
        Object.defineProperty(out, k, { value: value.parse(x, `${p}.${k}`), enumerable: true, writable: true, configurable: true });
      }
      return out;
    });
  },
  /** The first alternative that parses; the error lists why each one failed. */
  union<A, B>(a: Schema<A>, b: Schema<B>): Schema<A | B> {
    return make({ anyOf: [a.json, b.json] }, (v, p) => {
      try { return a.parse(v, p); } catch (first) {
        try { return b.parse(v, p); } catch (second) {
          throw new PipelineError('SCHEMA', `${p}: no alternative matches (${(first as Error).message}; ${(second as Error).message})`);
        }
      }
    });
  },
  object<const T extends Record<string, Schema<unknown>>>(shape: T): Schema<{ [K in keyof T]: Infer<T[K]> }> {
    const properties = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.json]));
    const required = Object.keys(shape).filter(k => !Object.hasOwn(shape[k]!.json, 'default') && !OPTIONAL.has(shape[k]!));
    return make({ type: 'object', properties, required, additionalProperties: false }, (v, p) => {
      invariant(v !== null && typeof v === 'object' && !Array.isArray(v), 'SCHEMA', `${p}: expected object`);
      const input = v as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        invariant(Object.hasOwn(shape, key), 'SCHEMA', `${p}: unknown property ${key}`);
      }
      const out: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(shape)) {
        const parsed = schema.parse(input[key], `${p}.${key}`);
        if (parsed !== undefined || !OPTIONAL.has(schema)) out[key] = parsed;
      }
      return out as { [K in keyof T]: Infer<T[K]> };
    });
  },
};
export function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (cause) { throw new PipelineError('JSON', 'Invalid JSON', { cause }); }
}
