import { type currentMap } from '../commands/map.js';
import { type StructureConfig } from './check.js';
export interface ArchitectureMapResult {
    file: string;
    /** created: written for the first time; written: generated parts rewritten; absent: no map and none created. */
    status: 'created' | 'written' | 'unchanged' | 'up-to-date' | 'stale' | 'missing' | 'absent';
    /** Lines present on one side only (10 at most each), for a stale map. */
    difference: {
        onlyInFile: string[];
        onlyExpected: string[];
    } | null;
}
type Config = StructureConfig;
/**
 * Writes or checks the architecture map (docs/STRUCTURE.md, « Carte de l'architecture »): its generated parts are
 * rewritten, its written parts never. With `create`, a missing map is written with its generated parts filled and its
 * written parts as drafts. With `check`, nothing is written: a map whose generated parts no longer match is stale.
 */
export declare function architectureMap(repo: string, config: Config, options: {
    check: boolean;
    create: boolean;
    current?: Awaited<ReturnType<typeof currentMap>>;
}): Promise<ArchitectureMapResult>;
export {};
