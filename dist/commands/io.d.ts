export interface CommandIO {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    cwd: string;
    env: NodeJS.ProcessEnv;
}
