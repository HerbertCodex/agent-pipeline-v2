import { type QuotaLevel, type UsageRunner } from '../quota/usage.js';
import type { CommandIO } from './io.js';
export declare const usage: string;
export declare const levelText: Record<QuotaLevel, string>;
/** Entry point with an injectable runner, so tests never call `claude`. */
export declare function runQuota(args: string[], io: CommandIO, runner?: UsageRunner): Promise<number>;
export declare function run(args: string[], io: CommandIO): Promise<number>;
