import type { CommandIO } from './io.js';
export declare const usage: string;
export declare function run(args: string[], io: CommandIO): Promise<number>;
