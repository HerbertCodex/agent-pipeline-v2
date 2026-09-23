import type { CommandIO } from './io.js';
export type CommandModule = {
    run(args: string[], io: CommandIO): Promise<number>;
};
interface Entry {
    summary: string;
    load: () => Promise<CommandModule>;
}
/**
 * Every `apv` command lives in `src/commands/<name>.ts` and exports `run(args, io)`. Modules load lazily:
 * a module that fails to load is reported as unavailable instead of breaking the others.
 */
export declare const commands: Record<string, Entry>;
export declare function helpText(): string;
export declare function dispatch(argv: string[], input: CommandIO): Promise<number>;
export {};
