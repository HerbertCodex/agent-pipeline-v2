import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { PipelineError } from '../domain/errors.js';
const executable = (path) => {
    try {
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
};
/** Chromium binaries of the Playwright cache, newest revision first. */
export function playwrightChromium(env) {
    const home = env['HOME'] || homedir();
    const roots = [env['PLAYWRIGHT_BROWSERS_PATH'], join(home, '.cache', 'ms-playwright'), join(home, 'Library', 'Caches', 'ms-playwright')]
        .filter((r) => !!r && r !== '0' && isAbsolute(r) && existsSync(r));
    const found = [];
    for (const root of roots) {
        let entries = [];
        try {
            entries = readdirSync(root);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const m = /^chromium-(\d+)$/.exec(entry);
            if (!m)
                continue;
            for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
                'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-x64/Chromium.app/Contents/MacOS/Chromium']) {
                const path = join(root, entry, sub);
                if (existsSync(path) && executable(path))
                    found.push({ revision: Number(m[1]), path });
            }
        }
    }
    return found.sort((a, b) => b.revision - a.revision).map(f => f.path);
}
const SYSTEM = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
const MAC = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
export function findBrowser(configured, repo, env) {
    if (configured) {
        const path = resolve(repo, configured.startsWith('~/') ? join(env['HOME'] || homedir(), configured.slice(2)) : configured);
        if (!executable(path))
            throw new PipelineError('WEB_CHROME', `Navigateur de web.chrome introuvable ou non exécutable : ${path}`);
        return { path, source: 'config' };
    }
    const fromEnv = env['CHROME_PATH'];
    if (fromEnv) {
        if (!executable(fromEnv))
            throw new PipelineError('WEB_CHROME', `CHROME_PATH désigne un fichier introuvable ou non exécutable : ${fromEnv}`);
        return { path: fromEnv, source: 'CHROME_PATH' };
    }
    const playwright = playwrightChromium(env)[0];
    if (playwright)
        return { path: playwright, source: 'playwright' };
    for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
        for (const name of SYSTEM) {
            const path = join(dir, name);
            if (existsSync(path) && executable(path))
                return { path, source: 'system' };
        }
    }
    for (const path of MAC)
        if (existsSync(path) && executable(path))
            return { path, source: 'system' };
    throw new PipelineError('WEB_CHROME', 'Aucun Chrome ni Chromium trouvé : déclarer web.chrome, ou CHROME_PATH, ou installer le Chromium de Playwright (npx playwright install chromium).');
}
/**
 * The project's own Lighthouse when Node resolves `lighthouse` from the repository to the real package (named
 * `lighthouse`, never an alias `npm:other`) at exactly the pinned version, its command inside that package; else
 * `npx -y lighthouse@<version>`.
 */
export function lighthouseCommand(repo, version) {
    try {
        const manifest = realpathSync(createRequire(join(repo, 'package.json')).resolve('lighthouse/package.json'));
        const dir = dirname(manifest);
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['lighthouse'];
        if (pkg.name === 'lighthouse' && pkg.version === version && typeof bin === 'string') {
            const cli = realpathSync(resolve(dir, bin));
            if (cli.startsWith(`${dir}/`))
                return { argv: [process.execPath, cli], source: 'project' };
        }
    }
    catch { /* no project dependency resolved: npx */ }
    return { argv: ['npx', '-y', `lighthouse@${version}`], source: 'npx' };
}
//# sourceMappingURL=chrome.js.map