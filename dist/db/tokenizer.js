export class SqlSyntaxError extends Error {
    line;
    constructor(message, line) {
        super(message);
        this.line = line;
    }
}
const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_$]/u;
const OPERATOR = /[+\-*/<>=~!@#%^&|`?:]/;
export function tokenize(sql) {
    const tokens = [];
    let i = 0;
    let line = 1;
    const n = sql.length;
    const countLines = (from, to) => {
        for (let k = from; k < to; k++)
            if (sql[k] === '\n')
                line++;
    };
    while (i < n) {
        const c = sql[i];
        if (c === '\n') {
            line++;
            i++;
            continue;
        }
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        if (c === '-' && sql[i + 1] === '-') {
            while (i < n && sql[i] !== '\n')
                i++;
            continue;
        }
        if (c === '/' && sql[i + 1] === '*') {
            const start = line;
            let depth = 0;
            while (i < n) {
                if (sql[i] === '/' && sql[i + 1] === '*') {
                    depth++;
                    i += 2;
                    continue;
                }
                if (sql[i] === '*' && sql[i + 1] === '/') {
                    depth--;
                    i += 2;
                    if (depth === 0)
                        break;
                    continue;
                }
                if (sql[i] === '\n')
                    line++;
                i++;
            }
            if (depth !== 0)
                throw new SqlSyntaxError('commentaire /* non fermé', start);
            continue;
        }
        const startLine = line;
        // E'...' escape strings, then plain '...' strings.
        if ((c === 'E' || c === 'e') && sql[i + 1] === '\'') {
            let j = i + 2;
            let value = '';
            for (;;) {
                if (j >= n)
                    throw new SqlSyntaxError('chaîne non fermée', startLine);
                const ch = sql[j];
                if (ch === '\\') {
                    value += sql[j + 1] ?? '';
                    j += 2;
                    continue;
                }
                if (ch === '\'' && sql[j + 1] === '\'') {
                    value += '\'';
                    j += 2;
                    continue;
                }
                if (ch === '\'')
                    break;
                value += ch;
                j++;
            }
            countLines(i, j + 1);
            tokens.push({ kind: 'string', value, text: sql.slice(i, j + 1), line: startLine });
            i = j + 1;
            continue;
        }
        if (c === '\'') {
            let j = i + 1;
            let value = '';
            for (;;) {
                if (j >= n)
                    throw new SqlSyntaxError('chaîne non fermée', startLine);
                const ch = sql[j];
                if (ch === '\'' && sql[j + 1] === '\'') {
                    value += '\'';
                    j += 2;
                    continue;
                }
                if (ch === '\'')
                    break;
                value += ch;
                j++;
            }
            countLines(i, j + 1);
            tokens.push({ kind: 'string', value, text: sql.slice(i, j + 1), line: startLine });
            i = j + 1;
            continue;
        }
        if (c === '"') {
            let j = i + 1;
            let value = '';
            for (;;) {
                if (j >= n)
                    throw new SqlSyntaxError('identifiant entre guillemets non fermé', startLine);
                const ch = sql[j];
                if (ch === '"' && sql[j + 1] === '"') {
                    value += '"';
                    j += 2;
                    continue;
                }
                if (ch === '"')
                    break;
                value += ch;
                j++;
            }
            countLines(i, j + 1);
            tokens.push({ kind: 'qident', value, text: sql.slice(i, j + 1), line: startLine });
            i = j + 1;
            continue;
        }
        if (c === '$') {
            const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
            if (tag) {
                const delimiter = tag[0];
                const end = sql.indexOf(delimiter, i + delimiter.length);
                if (end < 0)
                    throw new SqlSyntaxError(`corps ${delimiter} non fermé`, startLine);
                const value = sql.slice(i + delimiter.length, end);
                countLines(i, end + delimiter.length);
                tokens.push({ kind: 'string', value, text: sql.slice(i, end + delimiter.length), line: startLine });
                i = end + delimiter.length;
                continue;
            }
            // Positional parameter ($1).
            const param = /^\$\d+/.exec(sql.slice(i, i + 12));
            if (param) {
                tokens.push({ kind: 'word', value: param[0], text: param[0], line });
                i += param[0].length;
                continue;
            }
        }
        if (WORD_START.test(c)) {
            let j = i + 1;
            while (j < n && WORD_PART.test(sql[j]))
                j++;
            const text = sql.slice(i, j);
            tokens.push({ kind: 'word', value: text.toLowerCase(), text, line });
            i = j;
            continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
            const m = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i.exec(sql.slice(i, i + 64));
            const text = m ? m[0] : c;
            tokens.push({ kind: 'number', value: text, text, line });
            i += text.length;
            continue;
        }
        if ('(),;.[]'.includes(c)) {
            tokens.push({ kind: 'punct', value: c, text: c, line });
            i++;
            continue;
        }
        if (OPERATOR.test(c)) {
            let j = i + 1;
            while (j < n && OPERATOR.test(sql[j]) && !(sql[j] === '-' && sql[j + 1] === '-') && !(sql[j] === '/' && sql[j + 1] === '*'))
                j++;
            const text = sql.slice(i, j);
            tokens.push({ kind: 'op', value: text, text, line });
            i = j;
            continue;
        }
        // Any other character (backslash commands in psql scripts, stray symbols) is kept as an operator.
        tokens.push({ kind: 'op', value: c, text: c, line });
        i++;
    }
    return tokens;
}
/** Splits on top-level semicolons. `begin atomic ... end` bodies (SQL-standard functions) stay whole. */
export function splitStatements(tokens) {
    const statements = [];
    let current = [];
    let depth = 0;
    let atomic = false;
    let caseDepth = 0;
    for (let k = 0; k < tokens.length; k++) {
        const token = tokens[k];
        if (token.kind === 'punct' && token.value === '(')
            depth++;
        if (token.kind === 'punct' && token.value === ')')
            depth = Math.max(0, depth - 1);
        if (token.kind === 'word') {
            if (token.value === 'begin' && tokens[k + 1]?.kind === 'word' && tokens[k + 1]?.value === 'atomic')
                atomic = true;
            else if (atomic && token.value === 'case')
                caseDepth++;
            else if (atomic && token.value === 'end') {
                if (caseDepth > 0)
                    caseDepth--;
                else
                    atomic = false;
            }
        }
        if (token.kind === 'punct' && token.value === ';' && depth === 0 && !atomic) {
            if (current.length > 0)
                statements.push({ tokens: current, line: current[0].line });
            current = [];
            continue;
        }
        current.push(token);
    }
    if (current.length > 0)
        statements.push({ tokens: current, line: current[0].line });
    return statements;
}
//# sourceMappingURL=tokenizer.js.map