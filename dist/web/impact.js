import { DEFAULT_GENERATED_PATHS } from '../domain/contracts.js';
import { matches } from '../policy/policy.js';
import { gitRead, resolveCommit } from '../run/git-probe.js';
import { DEFAULT_NEUTRAL_PATHS } from './config.js';
/**
 * Whether a change calls for a web audit (`apv web audit --preview --base <ref>`, and its recomputation by
 * `apv gates verify`). Prudence first: the audit is required as soon as one changed file may affect the served site,
 * that is any file outside the explicit list of files without web effect (`web.neutralPaths`). The configuration,
 * the manifests and the lock files always count, and so do the files of `web.paths`, even inside that list: a
 * narrow list of « interface » globs would have left out server hooks, load functions, libraries and build settings.
 */
/** Variable naming the file where `apv web audit` writes its record for the receipt of the check that runs it (`apv gates run`). */
export const WEB_RECORD = 'APV_WEB_RECORD';
/** Always with a web effect: the audit configuration itself, the dependencies and their resolution. */
export const ALWAYS_WEB_PATHS = ['.apv/config.json', '**/package.json', ...DEFAULT_GENERATED_PATHS];
export function webImpact(changed, settings) {
    const neutral = settings?.neutralPaths ?? DEFAULT_NEUTRAL_PATHS;
    const always = [...ALWAYS_WEB_PATHS, ...(settings?.paths ?? [])];
    const files = changed.filter(f => always.some(g => matches(f, g)) || !neutral.some(g => matches(f, g)));
    return { required: files.length > 0, files };
}
/** Files changed between two commits, renames counted at both paths. */
export function changedBetween(repo, from, to) {
    const out = gitRead(repo, ['diff', '--name-only', '--no-renames', '-z', from, to]);
    return out === null ? null : out.split('\0').filter(Boolean);
}
/**
 * The merge base of `ref` and `head`, refused when `ref` does not resolve, when there is none, or when it is `head`
 * itself (`head` equal to or upstream of `ref`: nothing to compare, every change would be missed).
 */
export function auditBase(repo, ref, head) {
    const reference = resolveCommit(repo, ref);
    if (!reference)
        return { ok: false, reason: 'missing', message: `référence introuvable : ${ref}` };
    const base = gitRead(repo, ['merge-base', reference, head]);
    if (!base)
        return { ok: false, reason: 'no-merge-base', message: `aucune base commune entre ${ref} et ${head.slice(0, 12)}` };
    if (base === head)
        return { ok: false, reason: 'not-behind', message: `la base commune de ${ref} et de ${head.slice(0, 12)} est ${head.slice(0, 12)} lui-même (commit égal à ${ref} ou en amont) : aucun changement à comparer, la base ne prouverait rien` };
    return { ok: true, base, reference };
}
/** `--base <ref>` of an `apv web audit --preview` command (argv of a check), or undefined when the command is not one. */
export function webAuditGate(argv) {
    const at = argv.findIndex((a, i) => a === 'web' && argv[i + 1] === 'audit');
    if (at < 0)
        return undefined;
    const rest = argv.slice(at + 2);
    if (!rest.includes('--preview'))
        return undefined;
    const i = rest.indexOf('--base');
    const inline = rest.find(a => a.startsWith('--base='));
    return { base: i >= 0 ? rest[i + 1] ?? null : inline ? inline.slice('--base='.length) : null };
}
//# sourceMappingURL=impact.js.map