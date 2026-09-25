import { type QuotaLevel, type UsageRunner } from '../quota/usage.js';
import type { CommandIO } from './io.js';
export declare const usage: string;
export declare const levelText: Record<QuotaLevel, string>;
/**
 * How many executions (`/apv:run`) may run side by side at each level: as many as free test stacks below the
 * first threshold, one more at most from it, none beyond (the running ones finish).
 */
export declare const runsText: Record<QuotaLevel, string>;
/** Entry point with an injectable runner, so tests never call `claude`. */
export declare function runQuota(args: string[], io: CommandIO, runner?: UsageRunner): Promise<number>;
export declare function run(args: string[], io: CommandIO): Promise<number>;
