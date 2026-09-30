import { type ApvConfig } from '../config/load.js';
import { type ChangeBase, type Changes } from '../reuse/changes.js';
import { type StructureReport } from './analyze.js';
import { type MapInputs } from './archmap.js';
import { type Severity, type StructureSettings } from './config.js';
import { type StackProfile } from './profiles.js';
import { type UsageGraph } from './split.js';
/** A finding of the comparison with the base (`--base`), or about the architecture map. */
export interface ChangeFinding {
    code: 'flat-growth' | 'architecture-map' | 'configuration' | 'coverage';
    severity: Severity;
    /** Added by the change (never true without base). */
    isNew: boolean;
    /** `error` and new: the check fails. */
    blocking: boolean;
    path: string;
    message: string;
}
export interface StructureCheckReport extends StructureReport {
    base: ChangeBase;
    changes: ChangeFinding[];
    architectureMap: {
        path: string;
        exists: boolean;
        profile: string;
        items: number;
        described: number;
    };
    /** The usage graph could not be built (the split then reads the names only). */
    usageError: string | null;
}
export type StructureConfig = {
    structure?: ApvConfig['structure'] | undefined;
    reuse?: ApvConfig['reuse'] | undefined;
    map?: ApvConfig['map'] | undefined;
    design?: ApvConfig['design'] | undefined;
};
/**
 * Modules per folder, as `flat-folder` counts them: one per module key (`x.ts`, `x.svelte.ts` and `x.test.ts` are one;
 * `x.extra.ts` is another), tests alone apart. The default exclusions never apply to `always` (what the change creates).
 */
export declare function folderEntries(paths: readonly string[], settings: Pick<StructureSettings, 'ignore' | 'roots'>, always?: ReadonlySet<string>): Map<string, Map<string, string>>;
/** The usage graph of the working tree, from the code map (who imports whom, what modules export). */
export declare function usageGraph(repo: string, config: StructureConfig): Promise<UsageGraph>;
/** The stack profile: `structure.profile`, else detected. */
export declare function profileOf(repo: string, settings: StructureSettings, files: readonly string[]): StackProfile;
/** Everything the architecture map is written from. */
export declare function mapInputs(repo: string, config: StructureConfig, settings: StructureSettings, files: readonly string[], report: StructureReport): MapInputs;
export interface CheckOptions {
    /** `--base`: any commit-ish. Without it, nothing is compared: the analysis and the map are reported, never blocking. */
    base?: string;
    paths?: readonly string[];
    /** Precomputed changes and usage (tests). */
    changes?: Changes;
    usage?: UsageGraph | null;
    /** Tracked files, for the analysis without base. */
    tracked?: readonly string[];
}
/**
 * `apv structure check` (docs/STRUCTURE.md). Without base: the analysis of the tracked files, and the architecture map
 * signalled without blocking. With `--base`: the configuration of the base judges the change (it never loosens its own
 * check); what the change adds is compared with the base: a code file added to a flat folder (or that makes one), a
 * folder, main route or entry point without role in the architecture map, a link of the map the change breaks. What
 * existed at the base is signalled without blocking; moves that empty a flat folder into its subfolders are accepted.
 */
export declare function checkStructure(repo: string, config: StructureConfig, options?: CheckOptions): Promise<StructureCheckReport>;
