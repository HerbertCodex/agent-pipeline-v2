import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRead } from '../run/git-probe.js';
import { readAnchorKey, sign, signatureValid } from './operator.js';
/**
 * Merge traces: `apv stack merge` and `apv stack batch --merge` write one per merge, signed with the anchor key kept
 * outside the repository, in `<git common dir>/apv/merges/`. `apv audit merges` walks the default branch and names every
 * commit no trace accounts for: a merge or a push that did not go through the tool (and so skipped its rules). It is the
 * check after the fact that makes up for a branch protection GitHub does not offer (a private repository on the free plan).
 */
export const MERGES_DIR = ['apv', 'merges'];
export function writeMergeTrace(common, body, key) {
    const dir = join(common, ...MERGES_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const full = { v: 1, ...body };
    const file = join(dir, `${body.pr}-${body.head.slice(0, 12)}-${Date.parse(body.at)}.json`);
    writeFileSync(file, `${JSON.stringify({ ...full, sig: sign(key, 'merge', JSON.stringify(full)) }, null, 2)}\n`, { mode: 0o600 });
    return file;
}
/** The signed traces; unsigned, altered or unreadable files are ignored. */
export function readMergeTraces(common, key = readAnchorKey()) {
    if (!key)
        return [];
    let names;
    try {
        names = readdirSync(join(common, ...MERGES_DIR)).filter(n => n.endsWith('.json'));
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        try {
            const value = JSON.parse(readFileSync(join(common, ...MERGES_DIR, name), 'utf8'));
            const { sig, ...body } = value;
            if (value.v === 1 && typeof value.head === 'string' && signatureValid(key, 'merge', JSON.stringify(body), sig))
                out.push(value);
        }
        catch { /* ignored */ }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
}
/** Default window when no trace exists yet: 30 days. */
export const DEFAULT_AUDIT_DAYS = 30;
/**
 * Walks the first-parent history of `ref` since `since` (default: the first trace, else 30 days) and lists the commits
 * no signed trace accounts for: a merge commit is accounted for by the trace of its merge commit or of the head it
 * merged (second parent); a squash or a rebase by the trace of its merge commit.
 */
export function auditMerges(repo, common, ref, options = {}) {
    const traces = readMergeTraces(common);
    const now = options.now ?? new Date();
    const since = options.since ?? traces[0]?.at ?? new Date(now.getTime() - DEFAULT_AUDIT_DAYS * 86_400_000).toISOString();
    const sinceReason = options.since ? 'date demandée' : traces.length ? 'première fusion enregistrée par apv stack merge' : `aucune fusion enregistrée : ${DEFAULT_AUDIT_DAYS} derniers jours`;
    const head = gitRead(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const empty = { ref, head: head || null, since, sinceReason, commits: 0, traces: traces.length, unaccounted: [] };
    if (!head)
        return empty;
    const raw = gitRead(repo, ['log', '--first-parent', `--since=${since}`, '--format=%H%x1f%P%x1f%cI%x1f%s%x1e', head]);
    if (!raw)
        return empty;
    const merged = new Set(traces.map(t => t.mergeCommit).filter((x) => typeof x === 'string'));
    const heads = new Set(traces.map(t => t.head));
    const unaccounted = [];
    let commits = 0;
    for (const record of raw.split('\x1e').map(r => r.trim()).filter(Boolean)) {
        const [sha, parents, date, subject] = record.split('\x1f');
        if (!sha)
            continue;
        commits += 1;
        const list = (parents ?? '').split(' ').filter(Boolean);
        if (merged.has(sha) || (list.length > 1 && heads.has(list[1])))
            continue;
        unaccounted.push({ sha, date: date ?? '', subject: (subject ?? '').slice(0, 120), merge: list.length > 1 });
    }
    return { ...empty, commits, unaccounted };
}
/** Lines of an audit, for `apv status`, `apv audit merges` and the head of the report of `apv stack merge`. */
export function auditLines(audit) {
    if (!audit.head)
        return [`Audit des fusions : ${audit.ref} introuvable (git fetch), rien n'est vérifié.`];
    const head = `Audit des fusions sur ${audit.ref} depuis ${audit.since.slice(0, 10)} (${audit.sinceReason}) : ${audit.commits} commit(s), ${audit.traces} fusion(s) enregistrée(s) par apv`;
    if (!audit.unaccounted.length)
        return [`${head}, aucun commit hors de apv stack merge.`];
    return [`${head}. ATTENTION : ${audit.unaccounted.length} commit(s) arrivé(s) sans apv stack merge (fusion à la main ou poussée directe : les règles n'ont pas été vérifiées) :`,
        ...audit.unaccounted.slice(0, 20).map(c => `  ${c.sha.slice(0, 12)} ${c.date.slice(0, 10)} ${c.merge ? 'fusion' : 'commit'} : ${c.subject}`),
        ...(audit.unaccounted.length > 20 ? [`  et ${audit.unaccounted.length - 20} autre(s) (apv audit merges --json)`] : []),
        '  À examiner avec l\'opérateur ; si c\'est lui qui a fusionné sur GitHub, le noter au journal du pipeline.'];
}
//# sourceMappingURL=merges.js.map