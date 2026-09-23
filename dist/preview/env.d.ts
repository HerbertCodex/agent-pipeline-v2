/** Environment variable names accepted in an env file and in `serve.env`. */
export declare const ENV_NAME: RegExp;
/**
 * Parses a dotenv style file, the format of `supabase status -o env` and of shell files sourced with
 * `set -a`: `NAME=value`, `export NAME=value`, blank lines and `#` comments. Values may be double quoted
 * (escapes \n, \t, \", \\ and \$), single quoted (literal) or bare (an unquoted ` #` starts a comment).
 * No command substitution, no expansion: the file is data, never executed. Errors name the line, never
 * the value.
 */
export declare function parseEnvFile(text: string, file?: string): Record<string, string>;
/**
 * Replaces `${NAME}` with the value of NAME. An unknown name is an error (a silent empty value would start
 * the preview with a broken configuration). `$$` gives a literal `$`; any other `$` stays as is.
 */
export declare function expandVars(template: string, vars: NodeJS.ProcessEnv, where: string): string;
/**
 * Masks environment values in text shown or written by `apv preview`. Every value of the env file is
 * masked when it has 8 characters or more, and when it has 4 or more if its name looks secret (TOKEN,
 * KEY, SECRET, PASSWORD, SALT, DB_URL...). Shorter values (ports, `true`) would mask ordinary words.
 * Longest values first, so a value that contains another one is masked whole.
 */
export declare class Redactor {
    private readonly values;
    constructor(vars: Record<string, string>);
    get size(): number;
    redact(text: string): string;
}
/** Line-buffered redaction of a stream: a value is never split across two writes. */
export declare class RedactingWriter {
    private readonly redactor;
    private readonly write;
    private pending;
    constructor(redactor: Redactor, write: (s: string) => void);
    push(chunk: string): void;
    flush(): void;
}
