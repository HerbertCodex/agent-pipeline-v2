import { gitRead } from '../run/git-probe.js';
const GITHUB = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;
const UPGRADE = /upgrade to github pro|make this repository public|not available for this repository|requires github (pro|team)/i;
/** The repository `owner/name` of the `origin` remote when it is on github.com, else null. */
export function githubRepository(repo) {
    const url = gitRead(repo, ['remote', 'get-url', 'origin']);
    const m = url ? GITHUB.exec(url) : null;
    return m ? `${m[1]}/${m[2]}` : null;
}
function parse(text) { try {
    return JSON.parse(text);
}
catch {
    return null;
} }
export async function branchProtection(repo, gh) {
    const repository = githubRepository(repo);
    const none = (state, message, branch = null, missing = []) => ({ state, repository, branch, missing, message });
    if (!repository)
        return none('unknown', 'dépôt distant origin hors de github.com : protection de branche non vérifiée');
    const info = await gh(['api', `repos/${repository}`]);
    const meta = info.status === 0 ? parse(info.stdout) : null;
    const branch = meta?.default_branch ?? null;
    if (!branch)
        return none('unknown', `gh api repos/${repository} illisible (${(info.error ?? info.stderr).trim().slice(0, 120) || `code ${info.status}`}) : protection non vérifiée`);
    const classic = await gh(['api', `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`]);
    const rules = await gh(['api', `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`]);
    const refused = (c) => c.status !== 0 && UPGRADE.test(`${c.stdout}\n${c.stderr}`);
    const ruleTypes = rules.status === 0 ? (parse(rules.stdout) ?? []).map(r => r.type) : [];
    const protection = classic.status === 0 ? parse(classic.stdout) : null;
    if (!protection && !ruleTypes.length && (refused(classic) || refused(rules))) {
        return none('unavailable', `protection de branche indisponible sur ${repository} (dépôt privé en plan gratuit) : les garde-fous du plugin et l'audit des fusions (apv audit merges) en tiennent lieu, avec leurs limites (docs/REGLES.md)`, branch);
    }
    if (!protection && !ruleTypes.length && classic.status !== 0 && !/not protected|not found|404/i.test(`${classic.stdout}\n${classic.stderr}`)) {
        return none('unknown', `protection de ${branch} illisible (${classic.stderr.trim().slice(0, 120) || `code ${classic.status}`}) : droits d'administration nécessaires pour la lire`, branch);
    }
    const missing = [];
    if (!ruleTypes.includes('pull_request') && !protection?.required_pull_request_reviews)
        missing.push('PR obligatoire avant fusion');
    if (!ruleTypes.includes('non_fast_forward') && (!protection || protection.allow_force_pushes?.enabled !== false))
        missing.push('force-push bloqué');
    if (protection && !ruleTypes.length && protection.enforce_admins?.enabled !== true)
        missing.push('règles appliquées aux administrateurs');
    if (!missing.length)
        return none('ok', `${branch} protégée sur GitHub (PR obligatoire, pas de force-push)`, branch);
    const how = `réglage de l'opérateur sur GitHub : Settings > Rules > Rulesets (ou Branches) pour ${branch} : ${missing.join(', ')}`;
    return none(protection || ruleTypes.length ? 'weak' : 'absent', `${branch} ${protection || ruleTypes.length ? 'mal protégée' : 'non protégée'} sur GitHub : ${how}`, branch, missing);
}
//# sourceMappingURL=protection.js.map