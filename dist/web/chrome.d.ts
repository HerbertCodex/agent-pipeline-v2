/**
 * The browser and the Lighthouse command of `apv web audit`. Chrome: `web.chrome`, then `CHROME_PATH`, then the newest
 * Chromium downloaded by Playwright, then a system Chrome or Chromium. Lighthouse: the project's own dependency when
 * its version is the pinned one (offline, reproducible), else `npx -y lighthouse@<pinned version>`, never a shell.
 */
export interface Browser {
    path: string;
    source: 'config' | 'CHROME_PATH' | 'playwright' | 'system';
}
/** Chromium binaries of the Playwright cache, newest revision first. */
export declare function playwrightChromium(env: NodeJS.ProcessEnv): string[];
export declare function findBrowser(configured: string | undefined, repo: string, env: NodeJS.ProcessEnv): Browser;
export interface LighthouseCommand {
    argv: string[];
    source: 'project' | 'npx';
}
/**
 * The project's own Lighthouse when Node resolves `lighthouse` from the repository to the real package (named
 * `lighthouse`, never an alias `npm:other`) at exactly the pinned version, its command inside that package; else
 * `npx -y lighthouse@<version>`.
 */
export declare function lighthouseCommand(repo: string, version: string): LighthouseCommand;
