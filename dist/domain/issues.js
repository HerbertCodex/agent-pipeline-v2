import { PipelineError, errorMessage } from './errors.js';
/** Collects issues where a V2 validator used `invariant`; `ok` keeps the checked condition usable as a guard. */
export class IssueList {
    items = [];
    check(condition, code, message) {
        if (!condition)
            this.items.push({ code, message });
        return Boolean(condition);
    }
    /** Runs a V2 check that throws, recording its error instead of propagating it. */
    attempt(code, action) {
        try {
            return action();
        }
        catch (error) {
            this.items.push({ code: error instanceof PipelineError ? error.code : code, message: errorMessage(error) });
            return undefined;
        }
    }
    get empty() { return this.items.length === 0; }
    /** V2 contract: throw the first issue, exactly as the former `invariant` sequence did. */
    throwFirst() {
        const first = this.items[0];
        if (first)
            throw new PipelineError(first.code, first.message);
    }
}
const TYPE_NAMES = { string: 'string', integer: 'integer', number: 'finite number', boolean: 'boolean', array: 'array', object: 'object', null: 'null' };
function typeMatches(type, value) {
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
export function jsonSchemaIssues(json, value, path = '$') {
    const issues = [];
    const add = (message) => { issues.push({ code: 'SCHEMA', message: `${path}: ${message}` }); };
    if (value === undefined && Object.hasOwn(json, 'default'))
        return issues;
    if (Array.isArray(json['anyOf'])) {
        const branches = json['anyOf'].map(branch => jsonSchemaIssues(branch, value, path));
        if (branches.some(b => b.length === 0))
            return issues;
        const typed = json['anyOf'].findIndex(b => b['type'] !== 'null');
        return branches[typed >= 0 ? typed : 0] ?? issues;
    }
    if (Object.hasOwn(json, 'const')) {
        if (value !== json['const'])
            add(`expected ${String(json['const'])}`);
        return issues;
    }
    const type = json['type'];
    if (typeof type === 'string') {
        if (value === undefined) {
            add('missing value');
            return issues;
        }
        if (!typeMatches(type, value)) {
            add(`expected ${TYPE_NAMES[type] ?? type}`);
            return issues;
        }
    }
    if (Array.isArray(json['enum']) && !json['enum'].includes(value)) {
        add(`expected ${json['enum'].join('|')}`);
        return issues;
    }
    if (typeof value === 'string') {
        if (value.includes('\0'))
            add('invalid string, a NUL character is never accepted');
        const min = json['minLength'];
        const max = json['maxLength'];
        if ((min !== undefined && value.length < min) || (max !== undefined && value.length > max))
            add(`invalid string of ${value.length} characters, expected between ${min ?? 0} and ${max ?? '∞'}`);
        if (typeof json['pattern'] === 'string' && !new RegExp(json['pattern']).test(value))
            add(`invalid string, expected to match ${json['pattern']}`);
    }
    if (typeof value === 'number') {
        const min = json['minimum'];
        const max = json['maximum'];
        if ((min !== undefined && value < min) || (max !== undefined && value > max))
            add(`expected a value in [${min ?? '-∞'}, ${max ?? '∞'}]`);
    }
    if (Array.isArray(value)) {
        const min = json['minItems'];
        const max = json['maxItems'];
        if ((min !== undefined && value.length < min) || (max !== undefined && value.length > max))
            add(`invalid array of ${value.length} items, expected between ${min ?? 0} and ${max ?? '∞'}`);
        const items = json['items'];
        if (items)
            value.forEach((item, i) => issues.push(...jsonSchemaIssues(items, item, `${path}[${i}]`)));
    }
    if (typeMatches('object', value) && json['properties']) {
        const input = value;
        const properties = json['properties'];
        const required = new Set(json['required'] ?? []);
        for (const key of Object.keys(input))
            if (!Object.hasOwn(properties, key))
                add(`unknown property ${key}`);
        for (const [key, schema] of Object.entries(properties)) {
            if (input[key] === undefined && required.has(key)) {
                issues.push({ code: 'SCHEMA', message: `${path}.${key}: missing required property` });
                continue;
            }
            issues.push(...jsonSchemaIssues(schema, input[key], `${path}.${key}`));
        }
    }
    return issues;
}
/** All schema issues, then the parser as a safety net: a value the walker accepts must also parse. */
export function schemaIssues(schema, value) {
    const issues = jsonSchemaIssues(schema.json, value);
    if (issues.length)
        return { value: undefined, issues };
    try {
        return { value: schema.parse(value), issues };
    }
    catch (error) {
        return { value: undefined, issues: [{ code: error instanceof PipelineError ? error.code : 'SCHEMA', message: errorMessage(error) }] };
    }
}
//# sourceMappingURL=issues.js.map