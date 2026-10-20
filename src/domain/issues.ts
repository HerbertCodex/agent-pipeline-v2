import { PipelineError, errorMessage } from './errors.js';
import type { JsonSchema, Schema } from './schema.js';

/** One validation problem. Validators that report issues list them all instead of stopping at the first. */
export interface Issue { code: string; message: string }

/** Collects issues where a V2 validator used `invariant`; `ok` keeps the checked condition usable as a guard. */
export class IssueList {
  readonly items: Issue[] = [];
  check(condition: unknown, code: string, message: string): boolean {
    if (!condition) this.items.push({ code, message });
    return Boolean(condition);
  }
  /** Runs a V2 check that throws, recording its error instead of propagating it. */
  attempt<T>(code: string, action: () => T): T | undefined {
    try { return action(); }
    catch (error) { this.items.push({ code: error instanceof PipelineError ? error.code : code, message: errorMessage(error) }); return undefined; }
  }
  get empty(): boolean { return this.items.length === 0; }
  /** V2 contract: throw the first issue, exactly as the former `invariant` sequence did. */
  throwFirst(): void {
    const first = this.items[0];
    if (first) throw new PipelineError(first.code, first.message);
  }
}

const TYPE_NAMES: Record<string, string> = { string: 'string', integer: 'integer', number: 'finite number', boolean: 'boolean', array: 'array', object: 'object', null: 'null' };
function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    default: return false;
  }
}

/**
 * Every schema violation of `value`, walking the JSON Schema that `s.*` builders publish (the same
 * definitions the runtime parser uses). The parser stops at the first problem; this lists them all so an
 * author fixes a document in one pass. It understands exactly the vocabulary `schema.ts` emits.
 */
export function jsonSchemaIssues(json: JsonSchema, value: unknown, path = '$'): Issue[] {
  const issues: Issue[] = [];
  const add = (message: string): void => { issues.push({ code: 'SCHEMA', message: `${path}: ${message}` }); };
  if (value === undefined && Object.hasOwn(json, 'default')) return issues;
  if (Array.isArray(json['anyOf'])) {
    const branches = (json['anyOf'] as JsonSchema[]).map(branch => jsonSchemaIssues(branch, value, path));
    if (branches.some(b => b.length === 0)) return issues;
    const typed = (json['anyOf'] as JsonSchema[]).findIndex(b => b['type'] !== 'null');
    return branches[typed >= 0 ? typed : 0] ?? issues;
  }
  if (Object.hasOwn(json, 'const')) {
    if (value !== json['const']) add(`expected ${String(json['const'])}`);
    return issues;
  }
  const type = json['type'];
  if (typeof type === 'string') {
    if (value === undefined) { add('missing value'); return issues; }
    if (!typeMatches(type, value)) { add(`expected ${TYPE_NAMES[type] ?? type}`); return issues; }
  }
  if (Array.isArray(json['enum']) && !(json['enum'] as unknown[]).includes(value)) {
    add(`expected ${(json['enum'] as unknown[]).join('|')}`); return issues;
  }
  if (typeof value === 'string') {
    if (value.includes('\0')) add('invalid string, a NUL character is never accepted');
    const min = json['minLength'] as number | undefined; const max = json['maxLength'] as number | undefined;
    if ((min !== undefined && value.length < min) || (max !== undefined && value.length > max))
      add(`invalid string of ${value.length} characters, expected between ${min ?? 0} and ${max ?? '∞'}`);
    if (typeof json['pattern'] === 'string' && !new RegExp(json['pattern']).test(value)) add(`invalid string, expected to match ${json['pattern']}`);
  }
  if (typeof value === 'number') {
    const min = json['minimum'] as number | undefined; const max = json['maximum'] as number | undefined;
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) add(`expected a value in [${min ?? '-∞'}, ${max ?? '∞'}]`);
  }
  if (Array.isArray(value)) {
    const min = json['minItems'] as number | undefined; const max = json['maxItems'] as number | undefined;
    if ((min !== undefined && value.length < min) || (max !== undefined && value.length > max))
      add(`invalid array of ${value.length} items, expected between ${min ?? 0} and ${max ?? '∞'}`);
    const items = json['items'] as JsonSchema | undefined;
    if (items) value.forEach((item, i) => issues.push(...jsonSchemaIssues(items, item, `${path}[${i}]`)));
  }
  if (typeMatches('object', value) && json['properties']) {
    const input = value as Record<string, unknown>;
    const properties = json['properties'] as Record<string, JsonSchema>;
    const required = new Set((json['required'] as string[] | undefined) ?? []);
    for (const key of Object.keys(input)) if (!Object.hasOwn(properties, key)) add(`unknown property ${key}`);
    for (const [key, schema] of Object.entries(properties)) {
      if (input[key] === undefined && required.has(key)) { issues.push({ code: 'SCHEMA', message: `${path}.${key}: missing required property` }); continue; }
      // An optional property (neither required nor defaulted) may be absent.
      if (input[key] === undefined && !Object.hasOwn(schema, 'default')) continue;
      issues.push(...jsonSchemaIssues(schema, input[key], `${path}.${key}`));
    }
  }
  const values = json['additionalProperties'];
  if (typeMatches('object', value) && values && typeof values === 'object') {
    // A map (`s.record`): every key follows `propertyNames`, every value the item schema.
    const entries = Object.entries(value as Record<string, unknown>);
    const names = (json['propertyNames'] as JsonSchema | undefined)?.['pattern'];
    const max = json['maxProperties'] as number | undefined;
    if (max !== undefined && entries.length > max) add(`too many properties, expected at most ${max}`);
    for (const [key, item] of entries) {
      if (typeof names === 'string' && !new RegExp(names).test(key)) add(`invalid key ${key}, expected to match ${names}`);
      issues.push(...jsonSchemaIssues(values as JsonSchema, item, `${path}.${key}`));
    }
  }
  return issues;
}

/** All schema issues, then the parser as a safety net: a value the walker accepts must also parse. */
export function schemaIssues<T>(schema: Schema<T>, value: unknown): { value: T | undefined; issues: Issue[] } {
  const issues = jsonSchemaIssues(schema.json, value);
  if (issues.length) return { value: undefined, issues };
  try { return { value: schema.parse(value), issues }; }
  catch (error) { return { value: undefined, issues: [{ code: error instanceof PipelineError ? error.code : 'SCHEMA', message: errorMessage(error) }] }; }
}
