import { type DetectedGate } from '../onboard/detect.js';
import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv onboard [--repo <chemin>] [--specs <dossier>] [--dry-run] [--json]\n\nCr\u00E9e .apv/ pour un projet existant, sans jamais \u00E9craser un fichier existant (la commande peut \u00EAtre relanc\u00E9e).\nProjet V2 : .apv/config.json reprend de pipeline.v2.json les contr\u00F4les (gates), risk, validationRules, skills et\nenvironment.passEnv, et ignore le reste (agents, budgets, d\u00E9lais, mod\u00E8les, r\u00E9glages), list\u00E9 ; le registre\n.agent-pipeline/DECISIONS.json est repris tel quel s'il passe apv ledger validate (sinon refus, rien d'\u00E9crit) ;\nles specs V2 de .agent-pipeline/specs, specs, docs/specs (et --specs) sont copi\u00E9es dans .apv/specs/ si\napv spec validate --draft les accepte, sinon list\u00E9es avec la raison.\nProjet sans V2 : contr\u00F4les d\u00E9tect\u00E9s (package.json, Makefile, pyproject.toml) propos\u00E9s avec mandatory: false.\nLe reste comme apv init : brief.md, specs/, state/, .gitignore. --dry-run montre le plan sans rien \u00E9crire.\nSortie : 0 succ\u00E8s, 1 hors d'un d\u00E9p\u00F4t Git ou fichier V2 illisible ou invalide (rien n'est \u00E9crit), 2 appel incorrect.";
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
export declare function run(args: string[], io: CommandIO): Promise<number>;
export {};
