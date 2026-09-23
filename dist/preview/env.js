import { PipelineError } from '../domain/errors.js';
/** Environment variable names accepted in an env file and in `serve.env`. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Parses a dotenv style file, the format of `supabase status -o env` and of shell files sourced with
 * `set -a`: `NAME=value`, `export NAME=value`, blank lines and `#` comments. Values may be double quoted
 * (escapes \n, \t, \", \\ and \$), single quoted (literal) or bare (an unquoted ` #` starts a comment).
 * No command substitution, no expansion: the file is data, never executed. Errors name the line, never
 * the value.
 */
export function parseEnvFile(text, file = 'fichier d\'environnement') {
    const out = {};
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#'))
            continue;
        const body = line.replace(/^export\s+/, '');
        const eq = body.indexOf('=');
        const name = eq < 0 ? body : body.slice(0, eq).trim();
        if (eq < 0 || !ENV_NAME.test(name)) {
            throw new PipelineError('PREVIEW_ENV', `${file}, ligne ${i + 1} : attendu NOM=valeur (nom de variable : lettres, chiffres, _)`);
        }
        let raw = body.slice(eq + 1).trim();
        let value;
        if (raw.startsWith('"')) {
            let j = 1;
            let acc = '';
            const escapes = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', $: '$' };
            for (;;) {
                if (j >= raw.length) {
                    // A double quoted value may span lines.
                    if (i + 1 >= lines.length)
                        throw new PipelineError('PREVIEW_ENV', `${file}, ligne ${i + 1} : guillemet non fermé`);
                    acc += '\n';
                    raw += `\n${lines[++i]}`;
                    j++;
                    continue;
                }
                const c = raw[j];
                if (c === '"')
                    break;
                if (c === '\\' && j + 1 < raw.length) {
                    const n = raw[j + 1];
                    acc += escapes[n] ?? `\\${n}`;
                    j += 2;
                    continue;
                }
                acc += c;
                j++;
            }
            value = acc;
        }
        else if (raw.startsWith('\'')) {
            const end = raw.indexOf('\'', 1);
            if (end < 0)
                throw new PipelineError('PREVIEW_ENV', `${file}, ligne ${i + 1} : apostrophe non fermée`);
            value = raw.slice(1, end);
        }
        else {
            value = raw.replace(/\s+#.*$/, '').trim();
        }
        Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
}
/**
 * Replaces `${NAME}` with the value of NAME. An unknown name is an error (a silent empty value would start
 * the preview with a broken configuration). `$$` gives a literal `$`; any other `$` stays as is.
 */
export function expandVars(template, vars, where) {
    return template.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
        if (match === '$$')
            return '$';
        const value = vars[name];
        if (value === undefined)
            throw new PipelineError('PREVIEW_ENV', `${where} : variable inconnue \${${name}} (ni dans le fichier d'environnement, ni dans l'environnement)`);
        return value;
    });
}
const SECRET_NAME = /TOKEN|KEY|PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE|SALT|DB_URL|DATABASE_URL|DSN/i;
/**
 * Masks environment values in text shown or written by `apv preview`. Every value of the env file is
 * masked when it has 8 characters or more, and when it has 4 or more if its name looks secret (TOKEN,
 * KEY, SECRET, PASSWORD, SALT, DB_URL...). Shorter values (ports, `true`) would mask ordinary words.
 * Longest values first, so a value that contains another one is masked whole.
 */
export class Redactor {
    values;
    constructor(vars) {
        this.values = Object.entries(vars)
            .filter(([name, value]) => value.length >= 8 || (value.length >= 4 && SECRET_NAME.test(name)))
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value.length - a.value.length);
    }
    get size() { return this.values.length; }
    redact(text) {
        let out = text;
        for (const { name, value } of this.values)
            if (out.includes(value))
                out = out.split(value).join(`[masqué:${name}]`);
        return out;
    }
}
/** Line-buffered redaction of a stream: a value is never split across two writes. */
export class RedactingWriter {
    redactor;
    write;
    pending = '';
    constructor(redactor, write) {
        this.redactor = redactor;
        this.write = write;
    }
    push(chunk) {
        this.pending += chunk;
        const cut = this.pending.lastIndexOf('\n');
        if (cut < 0) {
            // A very long line without newline: flush it anyway to bound memory.
            if (this.pending.length > 1_000_000) {
                this.write(this.redactor.redact(this.pending));
                this.pending = '';
            }
            return;
        }
        this.write(this.redactor.redact(this.pending.slice(0, cut + 1)));
        this.pending = this.pending.slice(cut + 1);
    }
    flush() {
        if (this.pending)
            this.write(this.redactor.redact(this.pending));
        this.pending = '';
    }
}
//# sourceMappingURL=env.js.map