import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv scope check --spec <fichier> --task <id> [--base <ref>] [--repo <chemin>] [--json]\n\nCompare les fichiers modifi\u00E9s depuis la base (point de divergence entre <ref> et HEAD, main ou\nmaster par d\u00E9faut) aux chemins autoris\u00E9s de la t\u00E2che. Les modifications non commit\u00E9es ne sont\npas v\u00E9rifi\u00E9es : elles sont signal\u00E9es. Sortie : 0 dans le p\u00E9rim\u00E8tre, 1 hors p\u00E9rim\u00E8tre, 2 appel incorrect.";
/** Paths of `git status --porcelain=v1 -z`; a rename or copy entry is followed by its source path. */
export declare function porcelainPaths(output: string): string[];
export declare function run(args: string[], io: CommandIO): Promise<number>;
