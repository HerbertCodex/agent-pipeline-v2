import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv spec validate <fichier> [--repo <chemin>] [--request <texte> | --request-file <fichier>]\n                    [--config <fichier>] [--draft] [--json]\n  apv spec new <id> [--title <texte>] [--repo <chemin>] [--json]\n\nvalidate : valide une spec (sch\u00E9ma, d\u00E9pendances, chemins autoris\u00E9s, registre des d\u00E9cisions) contre le\nminimum de s\u00E9curit\u00E9 recalcul\u00E9 depuis le d\u00E9p\u00F4t, comme au lancement. Toutes les erreurs sont list\u00E9es.\nSortie : 0 si la spec est valide, 1 sinon, 2 si l'appel est incorrect.\nnew : \u00E9crit le gabarit .apv/specs/<id>.json (une t\u00E2che exemple, passages \u00AB \u00C0 compl\u00E9ter \u00BB), au format\naccept\u00E9 par apv spec validate --draft ; <id> en kebab-case ; refuse d'\u00E9craser (sortie 1).";
/** Kebab-case spec id: lower-case letters and digits separated by single hyphens. */
export declare const SPEC_ID: RegExp;
/**
 * Skeleton of a new spec. Every text to write says « À compléter » and names nothing security-sensitive, so
 * that the recalculated security minimum stays neutral until the author describes the real change.
 */
export declare function specTemplate(title: string): Record<string, unknown>;
export declare function run(args: string[], io: CommandIO): Promise<number>;
