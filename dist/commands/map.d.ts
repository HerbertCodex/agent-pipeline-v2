import { type CodeMap } from '../knowledge/code-map.js';
import { type MapSection, type ReuseSection } from '../reuse/config.js';
import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv map [--check] [--repo <chemin>] [--json]\n\n\u00C9crit la carte du code (.apv/code-map.md, ou map.file) : composants partag\u00E9s (r\u00F4le, props, variantes, o\u00F9 ils\nsont utilis\u00E9s), modules partag\u00E9s (exports, utilisateurs), routes, et ce qui est propre \u00E0 une fonctionnalit\u00E9,\navec les doublons possibles. Construite depuis les fichiers du d\u00E9p\u00F4t (suivis et non suivis, jamais les\nignor\u00E9s), sans mod\u00E8le, born\u00E9e pour rester lisible par un agent. \u00C0 commiter avec le code qu'elle d\u00E9crit.\n--check ne l'\u00E9crit pas : il la compare \u00E0 celle qui serait \u00E9crite (contr\u00F4le de t\u00E2che \u00AB code-map \u00BB).\nConfiguration facultative : section \u00AB map \u00BB (file, ignore, maxEntries) ; dossiers partag\u00E9s : reuse.shared.\nSortie : 0 \u00E9crite ou \u00E0 jour, 1 p\u00E9rim\u00E9e ou absente (--check) ou configuration invalide, 2 appel incorrect.";
export interface MapResult {
    file: string;
    status: 'written' | 'unchanged' | 'up-to-date' | 'stale' | 'missing';
    difference: {
        onlyInFile: string[];
        onlyExpected: string[];
    } | null;
}
/** The map of the repository as its configuration describes it, and its Markdown. */
export declare function currentMap(repo: string, config: {
    reuse?: ReuseSection | undefined;
    map?: MapSection | undefined;
}): Promise<{
    file: string;
    map: CodeMap;
    text: string;
}>;
/** Writes the map when it changed; with `check`, compares only. */
export declare function writeMap(repo: string, config: {
    reuse?: ReuseSection | undefined;
    map?: MapSection | undefined;
}, check: boolean): Promise<MapResult & {
    map: CodeMap;
}>;
export declare function run(args: string[], io: CommandIO): Promise<number>;
