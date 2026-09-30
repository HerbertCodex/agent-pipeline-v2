import { type DetectedGate } from '../onboard/detect.js';
import { type ReuseSetup } from './init.js';
import { type ReuseRule } from '../reuse/config.js';
import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv onboard [--repo <chemin>] [--specs <dossier>] [--dry-run] [--json]\n\nCr\u00E9e .apv/ pour un projet existant, sans jamais \u00E9craser un fichier existant (la commande peut \u00EAtre relanc\u00E9e).\nProjet V2 : .apv/config.json reprend de pipeline.v2.json les contr\u00F4les (gates), risk, validationRules, skills et\nenvironment.passEnv, et ignore le reste (agents, budgets, d\u00E9lais, mod\u00E8les, r\u00E9glages), list\u00E9 ; le registre\n.agent-pipeline/DECISIONS.json est repris tel quel s'il passe apv ledger validate (sinon refus, rien d'\u00E9crit) ;\nles specs V2 de .agent-pipeline/specs, specs, docs/specs (et --specs) sont copi\u00E9es dans .apv/specs/ si\napv spec validate --draft les accepte, sinon list\u00E9es avec la raison.\nProjet sans V2 : contr\u00F4les d\u00E9tect\u00E9s (package.json, Makefile, pyproject.toml) propos\u00E9s avec mandatory: false.\nDans les deux cas, les contr\u00F4les code-map (apv map --check) et, pour un projet web, reuse (apv reuse check)\nsont ajout\u00E9s avec la section reuse d\u00E9tect\u00E9e (dossiers de composants partag\u00E9s, composant qui remplace chaque\n\u00E9l\u00E9ment natif r\u00E9serv\u00E9, langue, branche de r\u00E9f\u00E9rence) ; la carte du code est \u00E9crite, et le rapport liste ce qui\nest d\u00E9j\u00E0 dupliqu\u00E9 ou refait (blocs copi\u00E9s, \u00E9l\u00E9ments natifs, primitives red\u00E9finies, composants homonymes).\nLe reste comme apv init : brief.md, specs/, state/, .gitignore, et la ligne des maquettes valid\u00E9es dans\n.gitattributes (dossier design.dir d\u00E9clar\u00E9 ou pr\u00E9sent). --dry-run montre le plan sans rien \u00E9crire.\nSortie : 0 succ\u00E8s, 1 hors d'un d\u00E9p\u00F4t Git ou fichier V2 illisible ou invalide (rien n'est \u00E9crit), 2 appel incorrect.";
interface SpecReport {
    imported: {
        from: string;
        to: string;
        request: string | null;
    }[];
    existing: {
        from: string;
        to: string;
    }[];
    rejected: {
        file: string;
        reasons: string[];
    }[];
}
export interface OnboardResult {
    repo: string;
    name: string;
    dryRun: boolean;
    v2: {
        config: string | null;
        ledger: string | null;
        notImported: string[];
    };
    config: {
        file: string;
        status: 'created' | 'existing';
        source: 'v2' | 'detected' | null;
        kept: string[];
        ignored: string[];
        gates: string[];
        detected: DetectedGate[];
    };
    /** Reuse of the existing components: what was set up, and what is already duplicated or redone (docs/REUSE.md). */
    reuse: ReuseSetup & {
        existing: ExistingReuse | null;
    };
    ledger: {
        file: string;
        status: 'imported' | 'created' | 'existing';
        source: string | null;
        decisions: number | null;
        hash: string | null;
    };
    specs: SpecReport & {
        searched: string[];
    };
    previewHints: string[];
    created: string[];
    completed: string[];
    existing: string[];
    next: string[];
}
export declare function onboardProject(repo: string, options: {
    dryRun: boolean;
    specsDir?: string;
    pluginRoot?: string;
}): Promise<OnboardResult>;
/** What is already duplicated or redone in the project, found by the rules of `apv reuse check` over all the code. */
export interface ExistingReuse {
    counts: Record<ReuseRule, number>;
    /** The first findings (duplicated blocks first), 20 at most: `path:lines` and the message. */
    examples: {
        rule: ReuseRule;
        place: string;
        message: string;
    }[];
}
export declare function run(args: string[], io: CommandIO): Promise<number>;
export {};
