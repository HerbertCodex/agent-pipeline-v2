import { type CodeMap } from '../knowledge/code-map.js';
import { type MapSection, type ReuseSection } from '../reuse/config.js';
import { type StructureSection } from '../structure/config.js';
import { type StructureReport } from '../structure/analyze.js';
import { type UsageGraph } from '../structure/split.js';
import { type ArchitectureMapResult } from '../structure/map-file.js';
import type { DesignSection } from '../design/config.js';
import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv map [--check] [--repo <chemin>] [--json]\n\n\u00C9crit la carte du code (.apv/code-map.md, ou map.file) : composants partag\u00E9s (r\u00F4le, props, variantes, o\u00F9 ils\nsont utilis\u00E9s), modules partag\u00E9s (exports, utilisateurs), routes, et ce qui est propre \u00E0 une fonctionnalit\u00E9,\navec les doublons possibles. Construite depuis les fichiers du d\u00E9p\u00F4t (suivis et non suivis, jamais les\nignor\u00E9s), sans mod\u00E8le, born\u00E9e pour rester lisible par un agent. \u00C0 commiter avec le code qu'elle d\u00E9crit.\n--check ne l'\u00E9crit pas : il la compare \u00E0 celle qui serait \u00E9crite (contr\u00F4le de t\u00E2che \u00AB code-map \u00BB).\nLa carte de l'architecture (structure.architectureMap, par d\u00E9faut docs/carte-architecture.md), quand elle\nexiste, suit : ses parties g\u00E9n\u00E9r\u00E9es sont r\u00E9\u00E9crites (ou compar\u00E9es avec --check), ses parties \u00E9crites jamais.\nLa carte du code nomme aussi les dossiers \u00E0 plat et les sous-dossiers propos\u00E9s pour chacun.\nConfiguration facultative : section \u00AB map \u00BB (file, ignore, maxEntries) ; dossiers partag\u00E9s : reuse.shared.\nSortie : 0 \u00E9crite ou \u00E0 jour, 1 p\u00E9rim\u00E9e ou absente (--check) ou configuration invalide, 2 appel incorrect.";
export interface MapResult {
    file: string;
    status: 'written' | 'unchanged' | 'up-to-date' | 'stale' | 'missing';
    difference: {
        onlyInFile: string[];
        onlyExpected: string[];
    } | null;
}
type MapConfig = {
    reuse?: ReuseSection | undefined;
    map?: MapSection | undefined;
    structure?: StructureSection | undefined;
    design?: DesignSection | undefined;
};
/**
 * The map of the repository as its configuration describes it, and its Markdown, with the analysis of the tree it
 * reflects (flat folders and their proposed subfolders, from the import graph of the map).
 */
export declare function currentMap(repo: string, config: MapConfig): Promise<{
    file: string;
    map: CodeMap;
    text: string;
    files: string[];
    tree: StructureReport;
    usage: UsageGraph;
}>;
/**
 * The map file, checked before any read or write: no component of its path (from the repository root) may be a symbolic
 * link, it must stay inside the repository once resolved, and an existing file must be a regular file. A map linked to a
 * file outside the repository is never read into the output or the receipts, nor overwritten.
 */
export declare function mapPath(repo: string, file: string): string;
/** Writes the map when it changed, atomically (temporary file created exclusively, then renamed); with `check`, compares only. */
export declare function writeMap(repo: string, config: MapConfig, check: boolean): Promise<MapResult & {
    map: CodeMap;
    architecture: ArchitectureMapResult;
}>;
/** Writes a file of the repository atomically (temporary file created exclusively, then renamed), never through a link. */
export declare function writeAtomically(repo: string, file: string, text: string): void;
export declare function run(args: string[], io: CommandIO): Promise<number>;
export {};
