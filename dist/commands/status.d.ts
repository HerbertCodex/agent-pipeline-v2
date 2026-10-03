import { lastQuotaReading } from '../quota/usage.js';
import { type RunSummaryEntry } from '../run/summary.js';
import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv status [--repo <chemin>] [--json]\n\nR\u00E9sume l'\u00E9tat de .apv/ : configuration, registre des d\u00E9cisions (empreinte), specs de .apv/specs/,\n\u00E9tat de reprise de .apv/state/, une ligne par ex\u00E9cution en cours (apv run) et dernier relev\u00E9 de quota ; le plugin\nde Claude Code (install\u00E9, activ\u00E9, sa version face \u00E0 celle de l'outil), les r\u00E8gles de fusion que le plugin install\u00E9\nne conna\u00EEt pas encore et celles qu'apporte la prochaine version de l'outil (branche suivie, telle que r\u00E9cup\u00E9r\u00E9e) ;\npuis les ancrages des r\u00E8gles avant fusion : journal de l'op\u00E9rateur (messages re\u00E7us, ou pourquoi aucun), protection\nde la branche par d\u00E9faut sur GitHub (gh api ; indisponible en plan gratuit pour un d\u00E9p\u00F4t priv\u00E9, dit une fois),\naudit des fusions faites hors de apv stack merge (apv audit merges).";
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
