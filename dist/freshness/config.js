import { s } from '../domain/schema.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { matches, validRelativePath } from '../policy/policy.js';
/**
 * Freshness of the living state and resume files (`apv status`, SessionStart hook): a file not rewritten for more
 * than `maxAgeDays` days, or longer than `maxLines` lines, is reported, never moved nor deleted.
 */
export const DEFAULT_FRESHNESS = { maxAgeDays: 2, maxLines: 300, archive: '.apv/state/archive' };
/** Living files watched in every project, whatever the configuration declares. */
export const DEFAULT_FRESHNESS_PATHS = ['.apv/state/resume.md', '.apv/state/*.md'];
/**
 * Default files left out: the grouped follow-up of minor findings (`.apv/state/suivi-constats.md`, compétence review)
 * is processed by batch, its age says nothing about the freshness of the resume state.
 */
export const DEFAULT_FRESHNESS_IGNORE = ['.apv/state/suivi-constats.md'];
const patternSchema = s.string(1, 4096);
export const freshnessSchema = s.object({
    maxAgeDays: s.default(s.number(1, 365), DEFAULT_FRESHNESS.maxAgeDays),
    maxLines: s.default(s.number(10, 1_000_000), DEFAULT_FRESHNESS.maxLines),
    paths: s.default(s.array(patternSchema, 0, 100), []),
    ignore: s.default(s.array(patternSchema, 0, 100), []),
    archive: s.optional(s.string(1, 4096)),
});
/**
 * Splits a watched path or glob into its root and a portable relative glob (`*`, `**`, `?`; the syntax of
 * allowedPaths). Refused: `..`, `.` and empty segments, braces, a leading `!`, a backslash, a bare `~`.
 */
export function splitPattern(pattern, field) {
    // `~` alone or `~user/` is never the home folder here: refused rather than read as a folder named `~`.
    if (pattern.startsWith('~') && !pattern.startsWith('~/'))
        throw new PipelineError('CONFIG', `${field}: « ${pattern} » : write ~/ followed by a path for the home folder.`);
    const [root, rest] = pattern.startsWith('~/') ? ['home', pattern.slice(2)]
        : pattern.startsWith('/') ? ['root', pattern.slice(1)] : ['repo', pattern];
    try {
        matches('probe', rest);
    }
    catch (error) {
        throw new PipelineError('CONFIG', `${field}: « ${pattern} » : ${errorMessage(error)} Relative to the repository, ~/ for the home folder, or absolute.`);
    }
    return { root, rest };
}
/** The archive folder proposed in the messages: a plain path (no wildcard), relative, `~/` or absolute. */
export function splitArchive(archive) {
    const parts = splitPattern(archive, 'freshness.archive');
    if (/[*?]/.test(parts.rest) || !validRelativePath(parts.rest))
        throw new PipelineError('CONFIG', `freshness.archive: « ${archive} » must be a folder path, without wildcard`);
    return parts;
}
/** Every problem of a `freshness` section once its schema passed: the patterns and the archive folder. */
export function freshnessIssues(settings) {
    const out = [];
    for (const key of ['paths', 'ignore']) {
        for (const pattern of settings[key]) {
            try {
                splitPattern(pattern, `freshness.${key}`);
            }
            catch (error) {
                out.push(errorMessage(error));
            }
        }
    }
    if (settings.archive !== undefined) {
        try {
            splitArchive(settings.archive);
        }
        catch (error) {
            out.push(errorMessage(error));
        }
    }
    return out;
}
//# sourceMappingURL=config.js.map