import { type ResolvedStack } from '../stacks/idle.js';
import type { CommandIO } from './io.js';
export declare const suiteHelp = "apv suite : la file des suites compl\u00E8tes (suite.queue), vue des autres charges lourdes\n\napv suite share [--wait-ms <n>] -- <commande> [args...]\n    Prend une part PARTAG\u00C9E de la file : attend tant qu'une suite compl\u00E8te la tient ou l'attend (\u00AB suite\n    compl\u00E8te en cours (ex\u00E9cution X), attente... \u00BB), puis lance la commande et rend son code de sortie.\n    Plusieurs \u00AB share \u00BB tournent ensemble ; une suite compl\u00E8te (suite.queue.slots \u00E0 1) attend qu'ils aient\n    fini avant de d\u00E9marrer ses contr\u00F4les, les nouveaux attendent derri\u00E8re elle. Sans effet dans une suite\n    compl\u00E8te (APV_SUITE_RUN) ou dans un autre \u00AB share \u00BB. File d\u00E9sactiv\u00E9e ou hors d\u00E9p\u00F4t : commande lanc\u00E9e telle quelle.\n    --wait-ms : attente maximale (d\u00E9faut : suite.queue.waitMs) ; d\u00E9pass\u00E9e : code 75, rien n'est lanc\u00E9.\n    Dur\u00E9e maximale d'une part : suite.queue.shareMaxMs (d\u00E9faut 2 h) ; au-del\u00E0, son bail n'est plus renouvel\u00E9 et les\n    suites compl\u00E8tes ne l'attendent plus (la commande continue).\n    Usage dans un script e2e de projet : apv suite share -- npm run test:e2e ...\n";
/** The queue of the repository around `cwd`: its file, the wait, the declared stacks; null outside a repository or with the queue disabled. */
export declare function queueOf(cwd: string): Promise<{
    lockFile: string;
    waitMs: number;
    shareMaxMs: number | undefined;
    stacks: ResolvedStack[];
} | null>;
/** Runs the command with the terminal of apv, the signals of apv forwarded to it; its exit code (128 + signal when it was killed). */
export declare function runChild(command: string[], io: CommandIO, env: NodeJS.ProcessEnv): Promise<number>;
/** `command` under a shared part of the queue of the repository around `io.cwd` (as is when there is none). */
export declare function runShared(command: string[], io: CommandIO, label: string, waitMs?: number): Promise<number>;
export declare function run(args: string[], io: CommandIO): Promise<number>;
