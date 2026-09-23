import { type ParseArgsConfig } from 'node:util';
import type { CommandIO } from './io.js';
/** Exit codes shared by every `apv` command. */
export declare const EXIT: {
    readonly ok: 0;
    readonly failed: 1;
    readonly usage: 2;
};
/** Wrong invocation: unknown option, missing argument. Reported with the command usage, exit 2. */
export declare class UsageError extends Error {
    constructor(message: string);
}
type Options = NonNullable<ParseArgsConfig['options']>;
export declare function parse<T extends Options>(args: string[], options: T): {
    values: T extends import("util").ParseArgsOptionsConfig ? { -readonly [LongOption in keyof T]?: { [LongOption_1 in keyof T]: T[LongOption_1]["multiple"] extends infer T_1 ? T_1 extends T[LongOption_1]["multiple"] ? T_1 extends false ? T[LongOption_1]["type"] extends "string" ? string : T[LongOption_1]["type"] extends "boolean" ? boolean : string | boolean : T_1 extends true ? (T[LongOption_1]["type"] extends "string" ? string : T[LongOption_1]["type"] extends "boolean" ? boolean : string | boolean)[] : T[LongOption_1]["type"] extends "string" ? string : T[LongOption_1]["type"] extends "boolean" ? boolean : string | boolean : never : never; }[LongOption]; } & { [LongOption_2 in keyof T as T[LongOption_2]["default"] extends {} ? LongOption_2 : never]: { [LongOption_1 in keyof T]: T[LongOption_1]["multiple"] extends infer T_2 ? T_2 extends T[LongOption_1]["multiple"] ? T_2 extends false ? T[LongOption_1]["type"] extends "string" ? string : T[LongOption_1]["type"] extends "boolean" ? boolean : string | boolean : T_2 extends true ? (T[LongOption_1]["type"] extends "string" ? string : T[LongOption_1]["type"] extends "boolean" ? boolean : string | boolean)[] : T[LongOption_1]["type"] extends "string" ? string : T[LongOption_1]["type"] extends "boolean" ? boolean : string | boolean : never : never; }[LongOption_2]; } extends infer P ? { [K in keyof P]: P[K]; } : never : {};
    positionals: string[];
};
/** Repository path from --repo or the working directory, symlinks resolved like the roots Git reports. */
export declare function repoPath(io: CommandIO, value: string | boolean | undefined): string;
export declare function list(value: string | boolean | undefined): string[];
export declare function json(io: CommandIO, value: unknown): void;
/**
 * Runs a command body and turns errors into an exit code: a usage error prints the usage (exit 2), a known
 * pipeline error prints its code and message (exit 1). Anything else is a bug and propagates.
 */
export declare function guard(io: CommandIO, usage: string, body: () => Promise<number>): Promise<number>;
/** Fixed-width text table for terminal summaries. */
export declare function table(headers: string[], rows: string[][]): string;
export {};
