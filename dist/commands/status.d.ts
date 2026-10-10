import { type ModelSettings } from '../config/models.js';
import { lastQuotaReading } from '../quota/usage.js';
import { type RunSummaryEntry } from '../run/summary.js';
import type { CommandIO } from './io.js';
import { type CiProofSettings } from '../rules/config.js';
import { type FreshnessOptions, type FreshnessReport } from '../freshness/check.js';
import { type RunMetrics } from '../metrics/run.js';
export declare const usage = "Utilisation :\n  apv status [--repo <chemin>] [--json]\n\nR\u00E9sume l'\u00E9tat de .apv/ : configuration, registre des d\u00E9cisions (empreinte), specs de .apv/specs/,\n\u00E9tat de reprise de .apv/state/, une ligne par ex\u00E9cution en cours (apv run) et dernier relev\u00E9 de quota ; le plugin\nde Claude Code (install\u00E9, activ\u00E9, sa version face \u00E0 celle de l'outil), les r\u00E8gles de fusion que le plugin install\u00E9\nne conna\u00EEt pas encore et celles qu'apporte la prochaine version de l'outil (branche suivie, telle que r\u00E9cup\u00E9r\u00E9e) ;\npuis les ancrages des r\u00E8gles avant fusion : journal de l'op\u00E9rateur (messages re\u00E7us, ou pourquoi aucun), protection\nde la branche par d\u00E9faut sur GitHub (gh api ; indisponible en plan gratuit pour un d\u00E9p\u00F4t priv\u00E9, dit une fois),\naudit des fusions faites hors de apv stack merge (apv audit merges). Ligne \u00AB Mesure \u00BB : temps de bout en bout et\nchemin critique des trois derni\u00E8res ex\u00E9cutions (apv metrics run, sans appel gh).\n\nSection \u00AB Fichiers d'\u00E9tat p\u00E9rim\u00E9s \u00BB (lecture seule, rien n'est d\u00E9plac\u00E9 ni supprim\u00E9) : .apv/state/resume.md, les\n.apv/state/*.md et les chemins de freshness.paths (~/ accept\u00E9) modifi\u00E9s il y a plus de freshness.maxAgeDays jours\n(d\u00E9faut 2), et ceux de plus de freshness.maxLines lignes (d\u00E9faut 300), avec la proposition \u00AB couper : \u00E9tat court +\narchive \u00BB. Seules la date et le nombre de lignes sont lus ; la date seule pour un nom de secret (.env*, *key*,\n*secret*, *token*). Un fichier absent est ignor\u00E9.";
export interface ApvStatus {
    repo: string;
    config: {
        file: string | null;
        legacy: boolean;
        gates: string[];
        ignored: string[];
        error: string | null;
    };
    /** Model of each role and the effort (`models`, docs/CONFIGURATION.md): the defaults when the section is absent or the configuration invalid. */
    models: ModelSettings;
    /**
     * The proof by the CI as this working tree declares it (`rules.ciProof`; apv rules check reads it at the merge base):
     * null when undeclared or the configuration invalid.
     */
    ciProof: {
        settings: CiProofSettings | null;
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
    /** Living state files not rewritten for too long or too long themselves (`freshness`, src/freshness/check.ts). */
    freshness: FreshnessReport;
    /** Time measure of the last three executions (apv metrics run, offline), most recent first; empty outside a repository. */
    metrics: Pick<RunMetrics, 'specId' | 'totalMs' | 'end' | 'criticalPath' | 'finished'>[];
}
export declare function apvStatus(repo: string, options?: FreshnessOptions): ApvStatus;
/** « Mesure (apv metrics run) : a 7 h 59 min jusqu'à la fusion, chemin critique 1 h 59 min ; … ». */
export declare function metricsLine(list: ApvStatus['metrics']): string | null;
export declare function run(args: string[], io: CommandIO): Promise<number>;
/** The line « Preuve CI » of apv status: the declaration of the working tree, as apv rules check would read it at the base. */
export declare function ciProofLine(ci: CiProofSettings | null): string;
