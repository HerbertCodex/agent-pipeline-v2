import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv init [--name <nom>] [--repo <chemin>] [--json]\n\nCr\u00E9e ce qui manque dans .apv/ sans jamais \u00E9craser un fichier existant (la commande peut \u00EAtre relanc\u00E9e) :\nconfig.json (nom du projet, contr\u00F4les vides), DECISIONS.json (registre vide), brief.md (consigne commune\ndes implementers, depuis le mod\u00E8le de la comp\u00E9tence chef-de-projet), specs/, state/ et .gitignore\n(fichiers machine). Liste ce qui est cr\u00E9\u00E9 et ce qui existait d\u00E9j\u00E0. Refuse hors d'un d\u00E9p\u00F4t Git.\nLe nom du projet est --name, sinon le nom du dossier du d\u00E9p\u00F4t.\nSortie : 0 succ\u00E8s, 1 hors d'un d\u00E9p\u00F4t Git ou mod\u00E8le de consigne introuvable, 2 appel incorrect.";
/** Root of the plugin, resolved from the compiled tool (`dist/commands/init.js`). */
export declare const PLUGIN_ROOT: string;
export declare const BRIEF_TEMPLATE = "skills/chef-de-projet/references/brief-type.md";
/** The brief model is the fenced `markdown` block of the reference; the whole file when it has none. */
export declare function briefFromTemplate(template: string, name: string): string;
export interface InitResult {
    repo: string;
    name: string;
    created: string[];
    existing: string[];
    completed: string[];
}
export declare function initProject(repo: string, name: string, pluginRoot?: string): InitResult;
export declare function run(args: string[], io: CommandIO): Promise<number>;
