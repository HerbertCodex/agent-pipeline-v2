import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runProcess } from '../execution/process.js';
/**
 * Journal of readings, one JSON object per line, read back by `apv status` and the SessionStart hook.
 * It lives with the other machine journals in `.apv/state/`, ignored by Git (`.apv/.gitignore`).
 */
export const QUOTA_LOG = '.apv/state/quota.log';
/** `claude -p "/usage"` starts a whole session: it can take more than a minute on a busy machine. */
export const QUOTA_TIMEOUT_MS = 150000;
export const QUOTA_COMMAND = ['-p', '/usage', '--setting-sources', ''];
/** Spec section 9: 70 % slow down, 85 % finish running work only, 95 % save and warn the operator. */
export const QUOTA_THRESHOLDS = { slow_down: 70, finish_only: 85, save_now: 95 };
export const quotaLevels = ['ok', 'slow_down', 'finish_only', 'save_now', 'unknown'];
// ANSI colour and cursor sequences a terminal UI may leave in captured output.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const USED = /(\d+(?:[.,]\d+)?)\s*%\s*used(?:\s*[·•|,-]?\s*resets?\s+(.+?))?\s*$/i;
function window(text, label) {
    const lines = text.split(/\r?\n/);
    const index = lines.findIndex(l => label.test(l));
    if (index < 0)
        return null;
    const line = lines[index];
    // One line in the documented format; a wrapped layout puts the figures on the following lines.
    const match = USED.exec(line.slice(line.search(label))) ?? USED.exec(lines.slice(index + 1, index + 3).map(l => l.trim()).join(' '));
    if (!match)
        return null;
    return { percent: Number(match[1].replace(',', '.')), resets: match[2]?.trim() || null };
}
/** Reads the session and weekly lines of `/usage`; other lines (per-model weeks, headers) are ignored. */
export function parseUsage(output) {
    const text = output.replace(ANSI, '');
    return { session: window(text, /Current session\s*:/i), week: window(text, /Current week \(all models\)\s*:/i) };
}
export function classifyQuota(percent) {
    if (percent === null || !Number.isFinite(percent))
        return 'unknown';
    if (percent >= QUOTA_THRESHOLDS.save_now)
        return 'save_now';
    if (percent >= QUOTA_THRESHOLDS.finish_only)
        return 'finish_only';
    if (percent >= QUOTA_THRESHOLDS.slow_down)
        return 'slow_down';
    return 'ok';
}
export function reading(output, at = new Date()) {
    const { session, week } = parseUsage(output);
    const values = [session?.percent, week?.percent].filter((x) => x !== undefined);
    const percent = values.length ? Math.max(...values) : null;
    return { at: at.toISOString(), session, week, percent, level: classifyQuota(percent) };
}
/** Runs the real CLI with the caller's environment: `claude` needs HOME and its own credentials. */
export function processRunner(env, cwd) {
    return async (argv, timeoutMs) => {
        const result = await runProcess({ command: argv, cwd, env, timeoutMs, maxOutputBytes: 1024 * 1024 });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
}
export async function readQuota(runner, executable = 'claude', at) {
    const command = await runner([executable, ...QUOTA_COMMAND], QUOTA_TIMEOUT_MS);
    return { reading: reading(`${command.stdout}\n${command.stderr}`, at ? at() : new Date()), command };
}
export function appendQuotaLog(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(value)}\n`);
}
/** Last well-formed reading of the journal, or null. */
export function lastQuotaReading(file) {
    if (!existsSync(file))
        return null;
    const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const value = JSON.parse(lines[i]);
            if (typeof value.at === 'string' && quotaLevels.includes(value.level))
                return value;
        }
        catch { /* skip a torn line */ }
    }
    return null;
}
//# sourceMappingURL=usage.js.map