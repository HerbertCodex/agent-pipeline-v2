import { lastQuotaReading } from '../quota/usage.js';
import { type RunSummaryEntry } from '../run/summary.js';
import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv status [--repo <chemin>] [--json]\n\nR\u00E9sume l'\u00E9tat de .apv/ : configuration, registre des d\u00E9cisions (empreinte), specs de .apv/specs/,\n\u00E9tat de reprise de .apv/state/, une ligne par ex\u00E9cution en cours (apv run) et dernier relev\u00E9 de quota.";
export interface ApvStatus {
    repo: string;
    config: {
        file: string | null;
        legacy: boolean;
        gates: string[];
        ignored: string[];
        error: string | null;
    };
    ledger: {
        file: string | null;
        decisions: number | null;
        hash: string | null;
        issues: number;
    };
    specs: {
        file: string;
        title: string | null;
        error: string | null;
    }[];
    state: {
        file: string;
        bytes: number;
        modifiedAt: string;
    }[];
    /** Spec executions (`.apv/state/run-<id>.json`, apv run), the most recent ones up to the read bounds. */
    runs: RunSummaryEntry[];
    /** State files of executions left unread (read bounds reached). */
    runsUnread: number;
    quota: ReturnType<typeof lastQuotaReading>;
}
export declare function apvStatus(repo: string): ApvStatus;
export declare function run(args: string[], io: CommandIO): Promise<number>;
