import { SqlSyntaxError, splitStatements, tokenize } from './tokenizer.js';
import { emptyModel, tableKey } from './model.js';
const COLUMN_CONSTRAINT_WORDS = new Set(['not', 'null', 'default', 'primary', 'unique', 'references', 'check', 'constraint', 'generated', 'collate', 'deferrable', 'initially']);
const FUNCTION_ATTRIBUTE_WORDS = new Set([
    'language', 'security', 'external', 'set', 'as', 'immutable', 'stable', 'volatile', 'strict', 'called',
    'parallel', 'cost', 'rows', 'leakproof', 'not', 'window', 'support', 'transform', 'begin', 'return', 'reset', 'owner', 'rename',
]);
const isWord = (t, ...values) => t !== undefined && t.kind === 'word' && (values.length === 0 || values.includes(t.value));
const isPunct = (t, value) => t !== undefined && t.kind === 'punct' && t.value === value;
const isIdent = (t) => t !== undefined && (t.kind === 'word' || t.kind === 'qident');
export const tokensText = (tokens) => tokens.map((t) => t.text).join(' ')
    .replace(/\( /g, '(').replace(/ \)/g, ')').replace(/ ,/g, ',').replace(/ \. /g, '.');
/** True when a table element (or an `add` action) starts a table constraint rather than a column. */
function startsTableConstraint(tokens) {
    const [first, second] = tokens;
    if (isWord(first, 'constraint'))
        return true;
    if (isWord(first, 'primary', 'foreign'))
        return isWord(second, 'key');
    if (isWord(first, 'unique'))
        return isPunct(second, '(') || isWord(second, 'nulls', 'using');
    if (isWord(first, 'check'))
        return isPunct(second, '(');
    if (isWord(first, 'exclude'))
        return isPunct(second, '(') || isWord(second, 'using');
    return false;
}
/** Splits a token list on top-level separators (commas by default). */
export function splitTopLevel(tokens, separator = ',') {
    const parts = [];
    let current = [];
    let depth = 0;
    for (const token of tokens) {
        if (isPunct(token, '(') || isPunct(token, '['))
            depth++;
        if (isPunct(token, ')') || isPunct(token, ']'))
            depth--;
        if (depth === 0 && token.kind === 'punct' && token.value === separator) {
            parts.push(current);
            current = [];
            continue;
        }
        current.push(token);
    }
    if (current.length > 0 || parts.length > 0)
        parts.push(current);
    return parts;
}
class Cursor {
    tokens;
    i = 0;
    constructor(tokens) {
        this.tokens = tokens;
    }
    peek(k = 0) { return this.tokens[this.i + k]; }
    atEnd() { return this.i >= this.tokens.length; }
    next() { return this.tokens[this.i++]; }
    /** Consumes the word sequence when it matches entirely. */
    accept(...words) {
        for (let k = 0; k < words.length; k++)
            if (!isWord(this.peek(k), words[k]))
                return false;
        this.i += words.length;
        return true;
    }
    ident() {
        const t = this.peek();
        if (!isIdent(t))
            return null;
        this.i++;
        return { schema: null, name: t.value, quoted: t.kind === 'qident', line: t.line };
    }
    qualified() {
        const first = this.ident();
        if (!first)
            return null;
        if (isPunct(this.peek(), '.') && isIdent(this.peek(1))) {
            this.i++;
            const second = this.ident();
            return { schema: first.name, name: second.name, quoted: second.quoted, line: first.line };
        }
        return first;
    }
    /** Returns the tokens inside the parenthesized group at the cursor and moves past it. */
    group() {
        if (!isPunct(this.peek(), '('))
            return null;
        let depth = 0;
        const start = this.i;
        for (let k = this.i; k < this.tokens.length; k++) {
            const t = this.tokens[k];
            if (isPunct(t, '('))
                depth++;
            if (isPunct(t, ')')) {
                depth--;
                if (depth === 0) {
                    this.i = k + 1;
                    return this.tokens.slice(start + 1, k);
                }
            }
        }
        this.i = this.tokens.length;
        return this.tokens.slice(start + 1);
    }
    rest() { const r = this.tokens.slice(this.i); this.i = this.tokens.length; return r; }
}
/** Column names from `(a, b)`; expressions become `(expr)`. */
function columnList(tokens) {
    return splitTopLevel(tokens).filter((part) => part.length > 0).map((part) => {
        const first = part[0];
        // `col`, `col desc nulls last`, `col text_pattern_ops`, `col collate "C"`: a plain column.
        if (isIdent(first) && part.slice(1).every((t) => t.kind === 'word' || t.kind === 'qident'))
            return first.value;
        return `(${tokensText(part)})`;
    });
}
function roleList(tokens) {
    return splitTopLevel(tokens).map((part) => {
        const words = part.filter((t) => isIdent(t));
        if (isWord(words[0], 'group'))
            words.shift();
        return words[0]?.value ?? '';
    }).filter(Boolean);
}
export class MigrationParser {
    options;
    model = emptyModel();
    file = '';
    constructor(options = {}) {
        this.options = options;
    }
    parse(files) {
        for (const migration of files)
            this.parseFile(migration);
        return this.model;
    }
    parseFile(migration) {
        this.file = migration.path;
        let tokens;
        try {
            tokens = tokenize(migration.sql);
        }
        catch (error) {
            const line = error instanceof SqlSyntaxError ? error.line : 1;
            this.model.notes.push({ file: migration.path, line, message: `lecture impossible : ${error.message}` });
            return;
        }
        for (const statement of splitStatements(tokens)) {
            try {
                this.statement(new Cursor(statement.tokens));
            }
            catch (error) {
                this.model.notes.push({ file: migration.path, line: statement.line, message: `instruction non comprise : ${error.message}` });
            }
        }
    }
    loc(line) { return { file: this.file, line }; }
    resolveTable(name) {
        if (name.schema)
            return tableKey(name.schema, name.name);
        const temp = tableKey('pg_temp', name.name);
        if (this.model.tables.has(temp))
            return temp;
        return tableKey('public', name.name);
    }
    statement(c) {
        if (c.accept('create')) {
            c.accept('or', 'replace');
            let temporary = false;
            for (;;) {
                if (c.accept('temp') || c.accept('temporary')) {
                    temporary = true;
                    continue;
                }
                if (c.accept('global') || c.accept('local') || c.accept('unlogged'))
                    continue;
                break;
            }
            if (c.accept('table'))
                return this.createTable(c, temporary);
            if (c.accept('unique', 'index'))
                return this.createIndex(c, true);
            if (c.accept('index'))
                return this.createIndex(c, false);
            if (c.accept('policy'))
                return this.createPolicy(c);
            if (c.accept('function') || c.accept('procedure'))
                return this.createFunction(c);
            if (c.accept('type'))
                return this.createType(c, 'type');
            if (c.accept('domain'))
                return this.createType(c, 'domain');
            return;
        }
        if (c.accept('alter')) {
            if (c.accept('table'))
                return this.alterTable(c);
            if (c.accept('index'))
                return this.alterIndex(c);
            if (c.accept('policy'))
                return this.alterPolicy(c);
            if (c.accept('function') || c.accept('procedure') || c.accept('routine'))
                return this.alterFunction(c);
            if (c.accept('type') || c.accept('domain'))
                return this.alterType(c);
            return;
        }
        if (c.accept('drop')) {
            if (c.accept('table'))
                return this.dropTable(c);
            if (c.accept('index'))
                return this.dropIndex(c);
            if (c.accept('policy'))
                return this.dropPolicy(c);
            if (c.accept('function') || c.accept('procedure') || c.accept('routine'))
                return this.dropFunction(c);
            if (c.accept('type') || c.accept('domain'))
                return this.dropType(c);
            return;
        }
        if (c.accept('grant'))
            return this.grantOrRevoke(c, true);
        if (c.accept('revoke'))
            return this.grantOrRevoke(c, false);
    }
    // ---------------------------------------------------------------- tables
    createTable(c, temporary) {
        const ifNotExists = c.accept('if', 'not', 'exists');
        const name = c.qualified();
        if (!name)
            throw new Error('nom de table attendu');
        const schema = temporary ? 'pg_temp' : name.schema ?? 'public';
        const key = tableKey(schema, name.name);
        if (this.model.tables.has(key)) {
            if (ifNotExists)
                return;
            this.model.notes.push({ ...this.loc(name.line), message: `table ${key} créée deux fois` });
        }
        const table = {
            schema, name: name.name, quoted: name.quoted, temporary, columns: new Map(), rlsEnabled: false, rlsForced: false, ...this.loc(name.line),
        };
        this.model.tables.set(key, table);
        const body = c.group();
        if (!body)
            return; // create table ... as select / partition of: columns unknown
        for (const element of splitTopLevel(body)) {
            if (element.length === 0)
                continue;
            if (startsTableConstraint(element)) {
                this.tableConstraint(key, new Cursor(element));
            }
            else if (isWord(element[0], 'like')) {
                continue;
            }
            else {
                this.columnDefinition(key, new Cursor(element));
            }
        }
    }
    columnDefinition(key, c) {
        const table = this.model.tables.get(key);
        if (!table)
            return;
        const name = c.ident();
        if (!name)
            throw new Error('nom de colonne attendu');
        const typeTokens = [];
        let depth = 0;
        while (!c.atEnd()) {
            const t = c.peek();
            if (depth === 0 && isWord(t) && COLUMN_CONSTRAINT_WORDS.has(t.value))
                break;
            if (isPunct(t, '('))
                depth++;
            if (isPunct(t, ')'))
                depth--;
            typeTokens.push(t);
            c.next();
        }
        const column = { name: name.name, quoted: name.quoted, type: tokensText(typeTokens).toLowerCase(), ...this.loc(name.line) };
        table.columns.set(name.name, column);
        let constraintName = null;
        while (!c.atEnd()) {
            if (c.accept('constraint')) {
                constraintName = c.ident()?.name ?? null;
                continue;
            }
            const t = c.peek();
            if (c.accept('primary', 'key')) {
                this.addIndex({ name: constraintName ?? `${table.name}_pkey`, table: key, kind: 'primary', unique: true, columns: [name.name], partial: false, predicate: null, ...this.loc(t.line) });
                constraintName = null;
                continue;
            }
            if (c.accept('unique')) {
                c.accept('nulls', 'not', 'distinct');
                c.accept('nulls', 'distinct');
                this.addIndex({ name: constraintName ?? `${table.name}_${name.name}_key`, table: key, kind: 'unique', unique: true, columns: [name.name], partial: false, predicate: null, ...this.loc(t.line) });
                constraintName = null;
                continue;
            }
            if (c.accept('references')) {
                const ref = c.qualified();
                if (!ref)
                    throw new Error('table référencée attendue');
                const refColumns = c.group();
                this.model.foreignKeys.push({
                    name: constraintName ?? `${table.name}_${name.name}_fkey`, table: key, columns: [name.name],
                    refTable: this.resolveTable(ref), refColumns: refColumns ? columnList(refColumns) : ['id'], ...this.loc(t.line),
                });
                constraintName = null;
                continue;
            }
            if (c.accept('check')) {
                c.group();
                constraintName = null;
                continue;
            }
            if (isPunct(t, '(')) {
                c.group();
                continue;
            }
            c.next();
        }
    }
    tableConstraint(key, c) {
        const table = this.model.tables.get(key);
        if (!table)
            return;
        let name = null;
        const start = c.peek();
        if (c.accept('constraint'))
            name = c.ident()?.name ?? null;
        if (c.accept('primary', 'key')) {
            const cols = columnList(c.group() ?? []);
            this.addIndex({ name: name ?? `${table.name}_pkey`, table: key, kind: 'primary', unique: true, columns: cols, partial: false, predicate: null, ...this.loc(start.line) });
            return;
        }
        if (c.accept('unique')) {
            c.accept('nulls', 'not', 'distinct');
            c.accept('nulls', 'distinct');
            if (c.accept('using', 'index')) {
                const indexName = c.ident()?.name;
                const index = this.model.indexes.find((ix) => ix.name === indexName && ix.table === key);
                if (index) {
                    index.kind = 'unique';
                    index.unique = true;
                    if (name)
                        index.name = name;
                }
                return;
            }
            const cols = columnList(c.group() ?? []);
            this.addIndex({ name: name ?? `${table.name}_${cols.join('_')}_key`, table: key, kind: 'unique', unique: true, columns: cols, partial: false, predicate: null, ...this.loc(start.line) });
            return;
        }
        if (c.accept('foreign', 'key')) {
            const cols = columnList(c.group() ?? []);
            if (!c.accept('references'))
                throw new Error('references attendu');
            const ref = c.qualified();
            if (!ref)
                throw new Error('table référencée attendue');
            const refCols = c.group();
            this.model.foreignKeys.push({
                name: name ?? `${table.name}_${cols.join('_')}_fkey`, table: key, columns: cols,
                refTable: this.resolveTable(ref), refColumns: refCols ? columnList(refCols) : cols.map(() => 'id'), ...this.loc(start.line),
            });
        }
        // check / exclude constraints do not change the model.
    }
    addIndex(index) {
        this.model.indexes.push(index);
    }
    renameTable(from, to, line) {
        const table = this.model.tables.get(from);
        if (!table)
            return;
        this.model.tables.delete(from);
        table.name = to.slice(to.indexOf('.') + 1);
        Object.assign(table, this.loc(line));
        this.model.tables.set(to, table);
        for (const fk of this.model.foreignKeys) {
            if (fk.table === from)
                fk.table = to;
            if (fk.refTable === from)
                fk.refTable = to;
        }
        for (const index of this.model.indexes)
            if (index.table === from)
                index.table = to;
        for (const policy of this.model.policies)
            if (policy.table === from)
                policy.table = to;
    }
    dropColumn(key, column) {
        const table = this.model.tables.get(key);
        table?.columns.delete(column);
        const mentions = new RegExp(`(^|[^\\w$])${column}($|[^\\w$])`);
        this.model.indexes = this.model.indexes.filter((ix) => !(ix.table === key
            && (ix.columns.some((col) => col === column || (col.startsWith('(') && mentions.test(col))) || (ix.predicate !== null && mentions.test(ix.predicate)))));
        this.model.foreignKeys = this.model.foreignKeys.filter((fk) => !(fk.table === key && fk.columns.includes(column)) && !(fk.refTable === key && fk.refColumns.includes(column)));
    }
    dropConstraint(key, name) {
        this.model.foreignKeys = this.model.foreignKeys.filter((fk) => !(fk.table === key && fk.name === name));
        this.model.indexes = this.model.indexes.filter((ix) => !(ix.table === key && ix.kind !== 'index' && ix.name === name));
    }
    alterTable(c) {
        c.accept('if', 'exists');
        c.accept('only');
        const name = c.qualified();
        if (!name)
            return;
        let key = this.resolveTable(name);
        for (const action of splitTopLevel(c.rest())) {
            const a = new Cursor(action);
            if (a.accept('rename', 'to')) {
                const to = a.ident();
                if (!to)
                    continue;
                const next = tableKey(key.slice(0, key.indexOf('.')), to.name);
                this.renameTable(key, next, to.line);
                key = next;
                continue;
            }
            if (a.accept('rename', 'constraint')) {
                const from = a.ident()?.name;
                a.accept('to');
                const to = a.ident()?.name;
                if (!from || !to)
                    continue;
                for (const fk of this.model.foreignKeys)
                    if (fk.table === key && fk.name === from)
                        fk.name = to;
                for (const ix of this.model.indexes)
                    if (ix.table === key && ix.name === from)
                        ix.name = to;
                continue;
            }
            if (a.accept('rename')) {
                a.accept('column');
                const from = a.ident()?.name;
                a.accept('to');
                const to = a.ident();
                const table = this.model.tables.get(key);
                if (!from || !to || !table)
                    continue;
                const column = table.columns.get(from);
                if (column) {
                    table.columns.delete(from);
                    table.columns.set(to.name, { ...column, name: to.name, quoted: to.quoted, ...this.loc(to.line) });
                }
                for (const fk of this.model.foreignKeys) {
                    if (fk.table === key)
                        fk.columns = fk.columns.map((col) => (col === from ? to.name : col));
                    if (fk.refTable === key)
                        fk.refColumns = fk.refColumns.map((col) => (col === from ? to.name : col));
                }
                for (const ix of this.model.indexes)
                    if (ix.table === key)
                        ix.columns = ix.columns.map((col) => (col === from ? to.name : col));
                continue;
            }
            if (a.accept('add')) {
                if (startsTableConstraint(action.slice(a.i))) {
                    this.tableConstraint(key, a);
                    continue;
                }
                a.accept('column');
                const ifNotExists = a.accept('if', 'not', 'exists');
                const colName = a.peek();
                if (ifNotExists && colName && this.model.tables.get(key)?.columns.has(colName.value))
                    continue;
                this.columnDefinition(key, a);
                continue;
            }
            if (a.accept('drop', 'constraint')) {
                a.accept('if', 'exists');
                const constraint = a.ident()?.name;
                if (constraint)
                    this.dropConstraint(key, constraint);
                continue;
            }
            if (a.accept('drop')) {
                a.accept('column');
                a.accept('if', 'exists');
                const column = a.ident()?.name;
                if (column)
                    this.dropColumn(key, column);
                continue;
            }
            const table = this.model.tables.get(key);
            if (!table)
                continue;
            if (a.accept('enable', 'row', 'level', 'security')) {
                table.rlsEnabled = true;
                continue;
            }
            if (a.accept('disable', 'row', 'level', 'security')) {
                table.rlsEnabled = false;
                continue;
            }
            if (a.accept('force', 'row', 'level', 'security')) {
                table.rlsForced = true;
                continue;
            }
            if (a.accept('no', 'force', 'row', 'level', 'security')) {
                table.rlsForced = false;
                continue;
            }
            if (a.accept('alter')) {
                a.accept('column');
                const column = a.ident()?.name;
                if (column && (a.accept('type') || a.accept('set', 'data', 'type'))) {
                    const existing = table.columns.get(column);
                    const typeTokens = [];
                    while (!a.atEnd() && !isWord(a.peek(), 'using', 'collate'))
                        typeTokens.push(a.next());
                    if (existing)
                        existing.type = tokensText(typeTokens).toLowerCase();
                }
                continue;
            }
        }
    }
    // --------------------------------------------------------------- indexes
    createIndex(c, unique) {
        c.accept('concurrently');
        const ifNotExists = c.accept('if', 'not', 'exists');
        let indexName = null;
        if (!isWord(c.peek(), 'on'))
            indexName = c.qualified();
        if (!c.accept('on'))
            throw new Error('on attendu');
        c.accept('only');
        const table = c.qualified();
        if (!table)
            throw new Error('table attendue');
        if (c.accept('using'))
            c.next();
        const columns = columnList(c.group() ?? []);
        let predicate = null;
        while (!c.atEnd()) {
            if (c.accept('where')) {
                predicate = tokensText(c.rest());
                break;
            }
            if (isPunct(c.peek(), '('))
                c.group();
            else
                c.next();
        }
        const key = this.resolveTable(table);
        const bare = key.slice(key.indexOf('.') + 1);
        const name = indexName?.name ?? `${bare}_${columns.map((col) => col.replace(/\W+/g, '')).join('_')}_idx`;
        if (ifNotExists && this.model.indexes.some((ix) => ix.name === name))
            return;
        this.addIndex({ name, table: key, kind: unique ? 'unique' : 'index', unique, columns, partial: predicate !== null, predicate, ...this.loc(indexName?.line ?? table.line) });
    }
    alterIndex(c) {
        c.accept('if', 'exists');
        const name = c.qualified();
        if (!name || !c.accept('rename', 'to'))
            return;
        const to = c.ident();
        if (!to)
            return;
        for (const ix of this.model.indexes)
            if (ix.name === name.name)
                ix.name = to.name;
    }
    dropIndex(c) {
        c.accept('concurrently');
        c.accept('if', 'exists');
        for (const part of splitTopLevel(c.rest())) {
            const name = new Cursor(part).qualified();
            if (name)
                this.model.indexes = this.model.indexes.filter((ix) => ix.name !== name.name);
        }
    }
    dropTable(c) {
        c.accept('if', 'exists');
        for (const part of splitTopLevel(c.rest())) {
            const name = new Cursor(part).qualified();
            if (!name)
                continue;
            const key = this.resolveTable(name);
            this.model.tables.delete(key);
            this.model.indexes = this.model.indexes.filter((ix) => ix.table !== key);
            this.model.foreignKeys = this.model.foreignKeys.filter((fk) => fk.table !== key && fk.refTable !== key);
            this.model.policies = this.model.policies.filter((p) => p.table !== key);
        }
    }
    // -------------------------------------------------------------- policies
    policyClauses(c, policy) {
        while (!c.atEnd()) {
            if (c.accept('as')) {
                c.next();
                continue;
            }
            if (c.accept('for')) {
                policy.command = c.next()?.value ?? 'all';
                continue;
            }
            if (c.accept('to')) {
                const roles = [];
                while (!c.atEnd() && !isWord(c.peek(), 'using', 'with'))
                    roles.push(c.next());
                policy.roles = roleList(roles);
                continue;
            }
            if (c.accept('using')) {
                policy.using = tokensText(c.group() ?? []);
                continue;
            }
            if (c.accept('with', 'check')) {
                policy.withCheck = tokensText(c.group() ?? []);
                continue;
            }
            c.next();
        }
    }
    createPolicy(c) {
        const name = c.ident();
        if (!name || !c.accept('on'))
            throw new Error('create policy <nom> on <table> attendu');
        const table = c.qualified();
        if (!table)
            throw new Error('table attendue');
        const policy = { name: name.name, table: this.resolveTable(table), command: 'all', roles: ['public'], using: null, withCheck: null, ...this.loc(name.line) };
        this.policyClauses(c, policy);
        this.model.policies.push(policy);
    }
    alterPolicy(c) {
        const name = c.ident();
        if (!name || !c.accept('on'))
            return;
        const table = c.qualified();
        if (!table)
            return;
        const key = this.resolveTable(table);
        const policy = this.model.policies.find((p) => p.table === key && p.name === name.name);
        if (!policy)
            return;
        if (c.accept('rename', 'to')) {
            const to = c.ident();
            if (to)
                policy.name = to.name;
            return;
        }
        this.policyClauses(c, policy);
        Object.assign(policy, this.loc(name.line));
    }
    dropPolicy(c) {
        c.accept('if', 'exists');
        const name = c.ident();
        if (!name || !c.accept('on'))
            return;
        const table = c.qualified();
        if (!table)
            return;
        const key = this.resolveTable(table);
        this.model.policies = this.model.policies.filter((p) => !(p.table === key && p.name === name.name));
    }
    // ------------------------------------------------------------- functions
    /** Identity argument count and types: OUT arguments are not part of the signature. */
    signature(args) {
        const parts = splitTopLevel(args).filter((part) => part.length > 0);
        const kept = parts.filter((part) => !isWord(part[0], 'out'));
        const types = kept.map((part) => {
            const tokens = [...part];
            if (isWord(tokens[0], 'in', 'inout', 'variadic'))
                tokens.shift();
            const cut = tokens.findIndex((t) => isWord(t, 'default') || (t.kind === 'op' && t.value === '='));
            const decl = cut >= 0 ? tokens.slice(0, cut) : tokens;
            // `name type` or just `type`: a leading identifier followed by another word is the name.
            if (decl.length >= 2 && isIdent(decl[0]) && isIdent(decl[1]) && !isWord(decl[1], 'precision', 'varying', 'with', 'without', 'zone'))
                decl.shift();
            return tokensText(decl).toLowerCase();
        });
        return { count: kept.length, types: types.join(', ') };
    }
    findFunctions(name, argCount) {
        const schema = name.schema ?? 'public';
        const sameName = this.model.functions.filter((f) => f.schema === schema && f.name === name.name);
        if (argCount === null || sameName.length <= 1)
            return argCount === null ? sameName : sameName.filter((f) => f.argCount === argCount || sameName.length === 1);
        return sameName.filter((f) => f.argCount === argCount);
    }
    readSearchPath(c) {
        const items = [];
        if (c.accept('from', 'current'))
            return ['<from current>'];
        if (!c.accept('to') && !(c.peek()?.kind === 'op' && c.peek()?.value === '=' && c.next()))
            return items;
        for (;;) {
            const t = c.peek();
            if (!t)
                break;
            if (t.kind === 'string' || t.kind === 'qident' || t.kind === 'word') {
                items.push(t.value);
                c.next();
            }
            else
                break;
            if (isPunct(c.peek(), ',')) {
                c.next();
                continue;
            }
            break;
        }
        return items;
    }
    functionAttributes(c, fn) {
        while (!c.atEnd()) {
            if (c.accept('returns')) {
                const tokens = [];
                while (!c.atEnd() && !(isWord(c.peek()) && FUNCTION_ATTRIBUTE_WORDS.has(c.peek().value))) {
                    if (isPunct(c.peek(), '(')) {
                        c.group();
                        tokens.push({ kind: 'word', value: '(...)', text: '(...)', line: 0 });
                        continue;
                    }
                    tokens.push(c.next());
                }
                fn.returns = tokensText(tokens).toLowerCase();
                continue;
            }
            if (c.accept('external', 'security', 'definer') || c.accept('security', 'definer')) {
                fn.securityDefiner = true;
                continue;
            }
            if (c.accept('external', 'security', 'invoker') || c.accept('security', 'invoker')) {
                fn.securityDefiner = false;
                continue;
            }
            if (c.accept('set')) {
                const param = c.ident();
                if (param?.name === 'search_path')
                    fn.searchPath = this.readSearchPath(c);
                continue;
            }
            if (c.accept('reset', 'all')) {
                fn.searchPath = null;
                continue;
            }
            if (c.accept('reset', 'search_path')) {
                fn.searchPath = null;
                continue;
            }
            if (c.accept('rename', 'to')) {
                const to = c.ident();
                if (to)
                    fn.name = to.name;
                continue;
            }
            if (c.accept('set', 'schema')) {
                const to = c.ident();
                if (to)
                    fn.schema = to.name;
                continue;
            }
            if (isPunct(c.peek(), '(')) {
                c.group();
                continue;
            }
            c.next();
        }
    }
    defaultGrants(fn) {
        const roles = ['public'];
        if (this.options.supabaseDefaults !== false && fn.schema === 'public')
            roles.push('anon', 'authenticated', 'service_role');
        for (const role of roles)
            fn.executeGrants.set(role, { role, explicit: false, file: fn.file, line: fn.line });
    }
    createFunction(c) {
        const name = c.qualified();
        if (!name)
            throw new Error('nom de fonction attendu');
        const args = c.group() ?? [];
        const { count, types } = this.signature(args);
        const schema = name.schema ?? 'public';
        if (schema === 'pg_temp')
            return;
        const existing = this.model.functions.find((f) => f.schema === schema && f.name === name.name && f.argCount === count && f.argTypes === types);
        const fn = existing ?? {
            schema, name: name.name, quoted: name.quoted, argCount: count, argTypes: types, returns: '', securityDefiner: false, searchPath: null,
            executeGrants: new Map(), ...this.loc(name.line),
        };
        fn.securityDefiner = false;
        fn.searchPath = null;
        fn.returns = '';
        Object.assign(fn, this.loc(name.line));
        this.functionAttributes(c, fn);
        if (!existing) {
            this.defaultGrants(fn);
            this.model.functions.push(fn);
        }
    }
    alterFunction(c) {
        const name = c.qualified();
        if (!name)
            return;
        const args = c.group();
        const targets = this.findFunctions(name, args ? this.signature(args).count : null);
        for (const fn of targets) {
            const sub = new Cursor(c.tokens.slice(c.i));
            const before = { definer: fn.securityDefiner, path: fn.searchPath };
            this.functionAttributes(sub, fn);
            if (before.definer !== fn.securityDefiner || before.path !== fn.searchPath)
                Object.assign(fn, this.loc(name.line));
        }
    }
    dropFunction(c) {
        c.accept('if', 'exists');
        for (const part of splitTopLevel(c.rest())) {
            const p = new Cursor(part);
            const name = p.qualified();
            if (!name)
                continue;
            const args = p.group();
            const targets = new Set(this.findFunctions(name, args ? this.signature(args).count : null));
            this.model.functions = this.model.functions.filter((f) => !targets.has(f));
        }
    }
    grantOrRevoke(c, grant) {
        if (!grant)
            c.accept('grant', 'option', 'for');
        const privileges = [];
        while (!c.atEnd() && !isWord(c.peek(), 'on'))
            privileges.push(c.next());
        const words = privileges.filter((t) => t.kind === 'word').map((t) => t.value);
        if (!words.includes('execute') && !words.includes('all'))
            return;
        if (!c.accept('on'))
            return;
        let targets = [];
        const objects = [];
        while (!c.atEnd() && !isWord(c.peek(), grant ? 'to' : 'from'))
            objects.push(c.next());
        const o = new Cursor(objects);
        if (o.accept('all', 'functions', 'in', 'schema') || o.accept('all', 'procedures', 'in', 'schema') || o.accept('all', 'routines', 'in', 'schema')) {
            const schemas = splitTopLevel(o.rest()).map((part) => part[0]?.value).filter(Boolean);
            targets = this.model.functions.filter((f) => schemas.includes(f.schema));
        }
        else if (o.accept('function') || o.accept('procedure') || o.accept('routine')) {
            for (const part of splitTopLevel(o.rest())) {
                const p = new Cursor(part);
                const name = p.qualified();
                if (!name)
                    continue;
                const args = p.group();
                targets.push(...this.findFunctions(name, args ? this.signature(args).count : null));
            }
        }
        else {
            return;
        }
        if (!c.accept(grant ? 'to' : 'from'))
            return;
        const roleTokens = [];
        while (!c.atEnd() && !isWord(c.peek(), 'with', 'cascade', 'restrict', 'granted'))
            roleTokens.push(c.next());
        const roles = roleList(roleTokens);
        const line = c.tokens[0]?.line ?? 0;
        for (const fn of targets) {
            for (const role of roles) {
                if (grant)
                    fn.executeGrants.set(role, { role, explicit: true, ...this.loc(line) });
                else
                    fn.executeGrants.delete(role);
            }
        }
    }
    // ----------------------------------------------------------------- types
    createType(c, kind) {
        const name = c.qualified();
        if (!name)
            return;
        const schema = name.schema ?? 'public';
        let detail = kind;
        if (kind === 'type' && c.accept('as'))
            detail = isWord(c.peek(), 'enum') ? 'enum' : isWord(c.peek(), 'range') ? 'range' : 'composite';
        this.model.types.set(tableKey(schema, name.name), { schema, name: name.name, quoted: name.quoted, kind: detail, ...this.loc(name.line) });
    }
    alterType(c) {
        const name = c.qualified();
        if (!name || !c.accept('rename', 'to'))
            return;
        const to = c.ident();
        const key = tableKey(name.schema ?? 'public', name.name);
        const type = this.model.types.get(key);
        if (!to || !type)
            return;
        this.model.types.delete(key);
        this.model.types.set(tableKey(type.schema, to.name), { ...type, name: to.name, quoted: to.quoted, ...this.loc(to.line) });
    }
    dropType(c) {
        c.accept('if', 'exists');
        for (const part of splitTopLevel(c.rest())) {
            const name = new Cursor(part).qualified();
            if (name)
                this.model.types.delete(tableKey(name.schema ?? 'public', name.name));
        }
    }
}
export function parseMigrations(files, options = {}) {
    return new MigrationParser(options).parse(files);
}
//# sourceMappingURL=parser.js.map