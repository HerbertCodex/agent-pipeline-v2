import { type Infer } from '../domain/schema.js';
/**
 * A command of the preview: a string runs through `sh -c` (pipes, `&&`, variables of the env file),
 * an array is an argv run without any shell, where `${NAME}` is replaced from the environment.
 */
export declare const previewCommandSchema: import("../domain/schema.js").Schema<string | string[]>;
export type PreviewCommand = Infer<typeof previewCommandSchema>;
/** The build steps, run in this order in the fresh copy of the branch. */
export declare const STEP_NAMES: readonly ["install", "migrate", "build", "seed"];
export type StepName = typeof STEP_NAMES[number];
export declare const previewSchema: import("../domain/schema.js").Schema<{
    readonly branch: string | undefined;
    readonly dir: string | undefined;
    readonly envFile: string | undefined;
    readonly steps: {
        install: PreviewCommand | undefined;
        migrate: PreviewCommand | undefined;
        build: PreviewCommand | undefined;
        seed: PreviewCommand | undefined;
    };
    readonly serve: {
        readonly command: string | string[];
        readonly port: number;
        readonly host: string | undefined;
        readonly env: Record<string, string>;
    };
    readonly health: {
        path: string;
        timeoutSec: number;
    };
    readonly announce: {
        readonly url: string | undefined;
    } | undefined;
}>;
export type PreviewConfig = Infer<typeof previewSchema>;
export declare const DEFAULT_BRANCH = "main";
/** Project name used in the default directory: the repository folder name, made file-safe. */
export declare function projectName(repo: string): string;
export declare function defaultPreviewDir(repo: string, env: NodeJS.ProcessEnv): string;
/**
 * Directory of the copy. `~/` is the home directory, a relative path is relative to the repository.
 * The directory is emptied at every update, so it must not be the repository, inside it (never the
 * working tree), or contain it, the home directory or the root.
 */
export declare function resolvePreviewDir(repo: string, config: PreviewConfig, env: NodeJS.ProcessEnv): string;
/** The env file path, relative to the repository unless absolute or under `~/`. */
export declare function resolveEnvFile(repo: string, config: PreviewConfig, env: NodeJS.ProcessEnv): string | null;
/** Host the health check and the port check talk to: the served host, or the loopback when it listens everywhere. */
export declare function probeHost(host: string | undefined): string;
/** Address announced to the operator: `announce.url`, else `http://localhost:<port>`. */
export declare function previewUrl(config: PreviewConfig): string;
