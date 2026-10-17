import { ALWAYS_REVIEWED } from '../review/config.js';
import { carriedHeads, chainSpans, diffFiles, isAncestor, prChain } from './carry.js';
import { latestReviews } from './reviews.js';
/**
 * Reviews carried over a delta that leaves their perimeter, and reviews of the delta (docs/ACCELERATION-LOTS.md, part B).
 *
 * A review recorded at C, a commit of the pull request below the head C', counts at C' for a domain other than securite
 * when every step of the change from C to C' (each first-parent link, and each run of links as one change) is outside
 * the perimeter of the domain: the plan of the reviews (planReviews, settings read at the base of the pull request)
 * does not retain the domain for it, and, for fidelite, it touches no screen (touchesNoScreen). The chain is walked from
 * the head, nearest first, MAX_REPORT_WALK commits at most (carry.ts); a blocking review (a critical or high finding) of
 * the domain at any commit of the walk blocks, and the first step that touches the perimeter breaks the report: a new
 * review is asked for, of the whole change or of the delta.
 *
 * securite is never carried that way: a review of the delta (`apv review record --delta-from C`) is recorded at C' by
 * its reviewer, and counts when C is an ancestor of C' on the branch, the files it recorded are the diff C..C'
 * recomputed, and the review it starts from is usable at C (itself a review of a delta, MAX_DELTA_CHAIN in a row at
 * most). Every domain has the same review of the delta, for a delta that touches its perimeter.
 *
 * The review of the head always decides; this only applies when the head has none of the domain.
 *
 * A waiver the operator typed for C counts at C' the same way (6.4, decision of the operator of 17 October 2026), for the
 * closed list WAIVER_PERIMETERS only: maquette (no screen, no mockup, no decision ledger touched), captures and the review
 * fidelite (the conditions of fidelite), the reviews donnees and rgpd (the plan does not retain them), controles (the
 * configuration of the checks and package.json untouched). Never securite, the rule relecture whole, preuve nor instable.
 * The waiver is still read from the journal of the operator by waiverFor, for its own commit C: nothing else creates one.
 */
/** Reviews of the delta in a row, each starting from the one before, until a review of the whole change. */
export const MAX_DELTA_CHAIN = 5;
/**
 * The waivers carried over a delta outside their perimeter, and that perimeter: a closed list. Absent, never carried:
 * `relecture:securite`, `relecture` whole, `preuve`, `instable` (decision of the operator of 17 October 2026).
 */
export const WAIVER_PERIMETERS = {
    maquette: 'maquette',
    captures: 'fidelite',
    controles: 'controles',
    'relecture:fidelite': 'fidelite',
    'relecture:donnees': 'donnees',
    'relecture:rgpd': 'rgpd',
};
/** Perimeters judged by the paths alone: the whole diff C..C' is read too, a merge of the target included. */
const PATH_PERIMETERS = ['maquette', 'controles'];
/** Causes shown when a step of the chain touches the perimeter. */
const MAX_REASONS = 5;
const short = (sha) => sha.slice(0, 12);
export const usableReview = (r) => !!r && !r.problem && !!r.record && r.record.findings.critical === 0 && r.record.findings.high === 0;
export const blockingReview = (r) => !!r?.record && (r.record.findings.critical > 0 || r.record.findings.high > 0);
export function reviewChain(ctx, head) {
    const records = new Map();
    const at = (commit) => {
        let found = records.get(commit);
        if (!found) {
            found = ctx.key === undefined ? latestReviews(ctx.common, commit) : latestReviews(ctx.common, commit, ctx.key);
            records.set(commit, found);
        }
        return found;
    };
    let nodes = null;
    const chain = () => (nodes ??= prChain(ctx.repo, head, ctx.target));
    const touched = new Map();
    const resolve = (commit, domain, depth) => {
        const own = at(commit).get(domain);
        let picked = { found: own, from: null, how: own ? 'own' : null };
        if (!own) {
            // The review of the commit decides; over merges of the target, a blocking review anywhere blocks (carry.ts).
            const carried = carriedHeads(ctx.repo, commit, ctx.target).map(h => ({ head: h, r: at(h).get(domain) })).filter(x => x.r);
            const stop = carried.find(x => blockingReview(x.r)) ?? carried.find(x => usableReview(x.r));
            if (stop)
                picked = { found: stop.r, from: stop.head, how: 'carried' };
        }
        const delta = picked.found?.record?.delta;
        if (!delta || !usableReview(picked.found))
            return picked;
        const problem = verifyDelta(picked.found, domain, depth);
        if (problem)
            return { ...picked, found: { ...picked.found, problem: `relecture de delta non prouvante : ${problem}` } };
        return { ...picked, delta: { from: delta.from, files: delta.files.length } };
    };
    const verifyDelta = (read, domain, depth) => {
        const record = read.record;
        const delta = record.delta;
        if (depth + 1 > MAX_DELTA_CHAIN)
            return `plus de ${MAX_DELTA_CHAIN} relectures de delta à la suite : une relecture complète est demandée`;
        if (delta.from === record.commit || !isAncestor(ctx.repo, delta.from, record.commit))
            return `${short(delta.from)} n'est pas un ancêtre de ${short(record.commit)} (un rebase ne reporte rien)`;
        if (ctx.target && isAncestor(ctx.repo, delta.from, ctx.target))
            return `${short(delta.from)} est un commit de la cible, pas de la branche`;
        const files = diffFiles(ctx.repo, delta.from, record.commit);
        if (files === null)
            return `delta ${short(delta.from)}..${short(record.commit)} illisible`;
        const recomputed = [...files].sort();
        const recorded = [...delta.files].sort();
        if (recomputed.length !== recorded.length || recomputed.some((f, k) => f !== recorded[k])) {
            return `fichiers enregistrés (${recorded.length}) différents du delta recalculé ${short(delta.from)}..${short(record.commit)} (${recomputed.length})`;
        }
        const start = resolve(delta.from, domain, depth + 1);
        const where = short(start.from ?? delta.from);
        if (!start.found)
            return `aucune relecture ${domain} à ${short(delta.from)}, départ du delta`;
        if (blockingReview(start.found))
            return `relecture ${domain} de départ à ${where} : ${start.found.record.findings.critical} constat(s) critique(s) et ${start.found.record.findings.high} haut(s)`;
        if (!usableReview(start.found))
            return `relecture ${domain} de départ inutilisable à ${where} (${start.found.problem ?? 'illisible'})`;
        return null;
    };
    /**
     * Why the steps from the node to the head touch the perimeter: each run of links, then each link, and for a perimeter
     * of paths the whole diff from the node to the head; empty when none.
     */
    const reasonsFor = (perimeter, node) => {
        const whole = PATH_PERIMETERS.includes(perimeter) ? [{ from: node.commit, to: head }] : [];
        for (const span of [...chainSpans(node.links), ...node.links, ...whole]) {
            const key = `${perimeter}|${span.from}..${span.to}`;
            let why = touched.get(key);
            if (!why) {
                why = ctx.touches(perimeter, span);
                touched.set(key, why);
            }
            if (why.length)
                return why.slice(0, MAX_REASONS).map(w => `${short(span.from)}..${short(span.to)} : ${w}`);
        }
        return [];
    };
    const reported = (domain) => {
        if (domain === ALWAYS_REVIEWED)
            return null;
        for (const node of chain()) {
            const picked = resolve(node.commit, domain, 0);
            if (!picked.found)
                continue;
            const from = picked.from ?? node.commit;
            if (blockingReview(picked.found))
                return { found: picked.found, from, how: 'reported' };
            if (!usableReview(picked.found))
                continue;
            const reasons = reasonsFor(domain, node);
            if (reasons.length)
                return { found: undefined, from: null, how: null, broken: { from, reasons } };
            return { ...picked, from, how: 'reported', reported: { files: deltaFilesOf(node) } };
        }
        return null;
    };
    const deltaStart = (domain) => {
        for (const node of chain()) {
            const picked = resolve(node.commit, domain, 0);
            if (blockingReview(picked.found))
                return null;
            if (usableReview(picked.found))
                return node.commit;
        }
        return null;
    };
    const deltaFilesOf = (node) => [...new Set(chainSpans(node.links).flatMap(s => diffFiles(ctx.repo, s.from, s.to) ?? []))].sort();
    const carriedWaiver = (rule, find) => {
        const perimeter = WAIVER_PERIMETERS[rule];
        if (!perimeter)
            return null;
        for (const node of chain()) {
            const waiver = find(node.commit);
            if (!waiver)
                continue;
            const reasons = reasonsFor(perimeter, node);
            return reasons.length ? { waiver: null, from: node.commit, reasons } : { waiver, from: node.commit, files: deltaFilesOf(node) };
        }
        return null;
    };
    return { resolve: (commit, domain) => resolve(commit, domain, 0), reported, deltaStart, carriedWaiver, chain };
}
//# sourceMappingURL=delta.js.map