import { type VerifyResult } from '../gates/verify.js';
import { type InfrastructureCause } from '../gates/infrastructure.js';
import type { CommandIO } from './io.js';
export declare const usage = "Utilisation :\n  apv release [<sha>] [--dry-run] [--json] [--repo <chemin>]\n  apv release auto [--stacks <pile>[,<pile>]] [--force-retry] [--dry-run] [--json] [--repo <chemin>]\n\nMise en ligne d\u00E9coupl\u00E9e de la fusion (section release de .apv/config.json, lue sur la branche from distante) :\nla branche de production (release.branch) n'avance qu'en avance rapide vers un commit de release.from dont la\nsuite compl\u00E8te est prouv\u00E9e au commit exact (apv gates verify --commit <sha>, instable refus\u00E9).\n<sha> (d\u00E9faut : t\u00EAte distante de from) doit \u00EAtre un anc\u00EAtre de cette t\u00EAte, et la production distante un anc\u00EAtre\nde <sha> (jamais de retour en arri\u00E8re, jamais de force). Puis git push origin <sha>:refs/heads/<branch>, sortie\naffich\u00E9e, branche distante relue. --dry-run v\u00E9rifie tout et ne pousse rien.\nrelease.migrations (motifs) : chaque migration ajout\u00E9e depuis la production attend \u00AB migration <version> appliqu\u00E9e \u00BB tap\u00E9\npar l'op\u00E9rateur dans une session Claude Code (journal de l'op\u00E9rateur) ; une migration publi\u00E9e modifi\u00E9e est refus\u00E9e.\nMotifs : ceux de la production, de <sha> et de from r\u00E9unis (un commit qui les vide ou les change n'en retire aucun).\nauto : pour un lancement p\u00E9riodique (cron) ; rien \u00E0 publier : 0 ; re\u00E7us rouges ou instables \u00E0 ce commit : 1 sans\nrelancer ; migration en attente : 0, rien lanc\u00E9 ; sinon suite compl\u00E8te relanc\u00E9e en entier (aucun re\u00E7u repris) dans une copie d\u00E9tach\u00E9e (batch.setup), sans\nattendre la file des suites (occup\u00E9e : 0, plus tard), puis publie si elle est verte au premier passage.\nSection stacks d\u00E9clar\u00E9e : la suite re\u00E7oit une pile comme apv gates run --stacks (la premi\u00E8re dont le verrou est libre, ou --stacks pour\nforcer) ; aucune libre : 0, piles occup\u00E9es, plus tard. Panne d'infrastructure (variable absente, pile injoignable) : dite comme telle, 1.\nM\u00EAme commit d\u00E9j\u00E0 tent\u00E9, lu dans ses re\u00E7us seuls (magasin v\u00E9rifi\u00E9 comme apv gates verify) : contr\u00F4le instable ou \u00E9chec de code : 1,\njamais relanc\u00E9, --force-retry compris (seul un nouveau commit d\u00E9bloque) ; \u00E9checs tous en panne d'infrastructure : nouvel essai\n30 min apr\u00E8s leurs re\u00E7us au plus t\u00F4t, --force-retry relance tout de suite.\nHors --dry-run : APV_ALLOW_MERGE=1 devant la commande (ordre de l'op\u00E9rateur, ou son cron).\nLes contr\u00F4les de la branche de production sont toujours gard\u00E9s (comme les contr\u00F4les de la base \u00E0 la fusion).\nHistorique : .apv/state/stack.log (event release). Sortie : 0 publi\u00E9 ou rien \u00E0 faire, 1 refus, 2 appel incorrect.";
export declare const RELEASE_REFUSED: string;
/**
 * Whether `release auto` may run the full suite again at a commit, from its receipts alone (review of 1786b40, M1 and M3):
 * no failed check (`run`); a failure of the code (`code`: never again at this commit, --force-retry included), which is any
 * failure without an infrastructure finding the tool recorded itself (the output of a test never counts); every failure such
 * a finding, its receipts younger than 30 minutes (`wait`, unless --force-retry), else `run`.
 */
export declare function retryDecision(proof: Pick<VerifyResult, 'gates'>, now: number, forceRetry: boolean): {
    kind: 'run';
} | {
    kind: 'code';
    endedAt: number;
    runs: string;
    probable: InfrastructureCause[];
} | {
    kind: 'wait';
    endedAt: number;
    runs: string;
    ageMs: number;
    causes: InfrastructureCause[];
};
export declare function run(args: string[], io: CommandIO): Promise<number>;
