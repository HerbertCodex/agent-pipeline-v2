import { gitRead } from '../run/git-probe.js';
import type { GhRunner } from '../stack/github.js';

/**
 * Whether GitHub protects the default branch: a PR required before merging, no force-push, administrators included. It
 * is the only barrier outside the machine (docs/REGLES.md, « Ce que l'outil garantit »). Never a refusal: `apv status`,
 * `apv rules check` and `apv stack merge` say it once. A private repository on the free plan has neither branch
 * protection nor rulesets: then the guards of the plugin and the merge audit (`apv audit merges`) stand in for it.
 */
export type ProtectionState = 'ok' | 'weak' | 'absent' | 'unavailable' | 'unknown';
export interface Protection { state: ProtectionState; repository: string | null; branch: string | null; missing: string[]; message: string }

const GITHUB = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;
const UPGRADE = /upgrade to github pro|make this repository public|not available for this repository|requires github (pro|team)/i;

/** The repository `owner/name` of the `origin` remote when it is on github.com, else null. */
export function githubRepository(repo: string): string | null {
  const url = gitRead(repo, ['remote', 'get-url', 'origin']);
  const m = url ? GITHUB.exec(url) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

function parse(text: string): unknown { try { return JSON.parse(text) as unknown; } catch { return null; } }

export async function branchProtection(repo: string, gh: GhRunner): Promise<Protection> {
  const repository = githubRepository(repo);
  const none = (state: ProtectionState, message: string, branch: string | null = null, missing: string[] = []): Protection => ({ state, repository, branch, missing, message });
  if (!repository) return none('unknown', 'dépôt distant origin hors de github.com : protection de branche non vérifiée');
  const info = await gh(['api', `repos/${repository}`]);
  const meta = info.status === 0 ? parse(info.stdout) as { default_branch?: string } | null : null;
  const branch = meta?.default_branch ?? null;
  if (!branch) return none('unknown', `gh api repos/${repository} illisible (${(info.error ?? info.stderr).trim().slice(0, 120) || `code ${info.status}`}) : protection non vérifiée`);
  const classic = await gh(['api', `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`]);
  const rules = await gh(['api', `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`]);
  const refused = (c: typeof classic): boolean => c.status !== 0 && UPGRADE.test(`${c.stdout}\n${c.stderr}`);
  const ruleTypes = rules.status === 0 ? ((parse(rules.stdout) as { type?: string }[] | null) ?? []).map(r => r.type) : [];
  const protection = classic.status === 0 ? parse(classic.stdout) as { required_pull_request_reviews?: unknown; allow_force_pushes?: { enabled?: boolean }; enforce_admins?: { enabled?: boolean } } | null : null;
  if (!protection && !ruleTypes.length && (refused(classic) || refused(rules))) {
    return none('unavailable', `protection de branche indisponible sur ${repository} (dépôt privé en plan gratuit) : les garde-fous du plugin et l'audit des fusions (apv audit merges) en tiennent lieu, avec leurs limites (docs/REGLES.md)`, branch);
  }
  if (!protection && !ruleTypes.length && classic.status !== 0 && !/not protected|not found|404/i.test(`${classic.stdout}\n${classic.stderr}`)) {
    return none('unknown', `protection de ${branch} illisible (${classic.stderr.trim().slice(0, 120) || `code ${classic.status}`}) : droits d'administration nécessaires pour la lire`, branch);
  }
  const missing: string[] = [];
  if (!ruleTypes.includes('pull_request') && !protection?.required_pull_request_reviews) missing.push('PR obligatoire avant fusion');
  if (!ruleTypes.includes('non_fast_forward') && (!protection || protection.allow_force_pushes?.enabled !== false)) missing.push('force-push bloqué');
  if (protection && !ruleTypes.length && protection.enforce_admins?.enabled !== true) missing.push('règles appliquées aux administrateurs');
  if (!missing.length) return none('ok', `${branch} protégée sur GitHub (PR obligatoire, pas de force-push)`, branch);
  const how = `réglage de l'opérateur sur GitHub : Settings > Rules > Rulesets (ou Branches) pour ${branch} : ${missing.join(', ')}`;
  return none(protection || ruleTypes.length ? 'weak' : 'absent', `${branch} ${protection || ruleTypes.length ? 'mal protégée' : 'non protégée'} sur GitHub : ${how}`, branch, missing);
}
