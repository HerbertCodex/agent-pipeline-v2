import { loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { validateDag } from '../policy/policy.js';
import { execFileSync } from 'node:child_process';
import { environment } from '../execution/process.js';
import { gitRead, resolveCommit, resolveFullRef } from '../run/git-probe.js';
import { detectReference } from '../reuse/detect.js';

/**
 * The checks of the base (docs/CLI.md, « Contrôles de la base »). A candidate commit carries its
 * own `.apv/config.json`: read alone, it could drop or loosen the checks that prove it. `apv gates run` and
 * `apv gates verify` therefore read the checks of the base (the merge base of the reference and the commit) and keep
 * EVERY one of them, mandatory or not, with its base definition: removed, made optional or changed by the candidate, it
 * is still run as the base defined it, and the difference is said. The candidate can only add checks or harden them (a
 * new check, a check made mandatory, nothing else changed). A change of these checks goes through a pull request of configuration alone, proven by the
 * checks of its base, then merged by the operator.
 */
export type GateDifferenceKind = 'removed' | 'optional' | 'changed' | 'dependency';
export interface GateDifference { id: string; kind: GateDifferenceKind }

export interface BaseGates {
  /** The reference read (`--against`, `--base`, else the default branch of the remote), or null when none resolves. */
  reference: string | null;
  /** The merge base of the reference and the commit, whose configuration was read; null without reference. */
  mergeBase: string | null;
  /** `<sha>:.apv/config.json` read at the merge base, or null when the base has none (nothing to keep). */
  file: string | null;
  differences: GateDifference[];
  /** What could not be verified about the reference (the remote could not be read, a local ref behind it). */
  warnings: string[];
}

type Gate = ApvConfig['gates'][number];

/** JSON with sorted keys: two definitions compare by content, whatever the order of their fields. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** The checks of `candidate` with every mandatory check of `base` kept in its base definition (and what it depends on). */
export function enforceBaseGates(candidate: ApvConfig, base: ApvConfig): { config: ApvConfig; differences: GateDifference[] } {
  const gates: Gate[] = candidate.gates.map(g => structuredClone(g));
  const differences: GateDifference[] = [];
  const keep = (gate: Gate, kind: GateDifferenceKind): void => {
    const index = gates.findIndex(g => g.id === gate.id);
    if (index < 0) gates.push(structuredClone(gate)); else gates[index] = structuredClone(gate);
    differences.push({ id: gate.id, kind });
  };
  for (const gate of base.gates) {
    const now = gates.find(g => g.id === gate.id);
    if (!now) keep(gate, 'removed');
    else if (gate.mandatory && !now.mandatory) keep(gate, 'optional');
    // Hardening only: the same definition, made mandatory. Any other difference runs the base definition.
    else if (stable({ ...now, mandatory: gate.mandatory }) !== stable(gate)) keep(gate, 'changed');
  }
  // A kept check runs with what it depends on at the base.
  for (let added = true; added;) {
    added = false;
    for (const gate of [...gates]) {
      for (const dep of gate.dependsOn) {
        if (gates.some(g => g.id === dep)) continue;
        const atBase = base.gates.find(g => g.id === dep);
        if (atBase) { keep(atBase, 'dependency'); added = true; }
      }
    }
  }
  const config = { ...candidate, gates };
  try { validateDag(config.gates); }
  catch (error) { throw new PipelineError('CONFIG', `Contrôles de la base et du candidat incompatibles : ${errorMessage(error)}`); }
  return { config, differences };
}

/**
 * Reads the checks of the base of `head` and keeps its mandatory ones. The reference is `reference` when given, else
 * the default branch of the remote (`origin/HEAD`, `origin/main`, `origin/master`); without one, or when the base has no
 * configuration of its own, the candidate's checks are used as they are (`file` null).
 */
export function applyBaseGates(repo: string, candidate: ApvConfig, head: string, reference: string | null, options: RemoteCheck = {}): { config: ApvConfig; base: BaseGates } {
  const name = reference ?? detectReference(repo);
  const warnings: string[] = [];
  const none = { config: candidate, base: { reference: name, mergeBase: null, file: null, differences: [], warnings } };
  if (!name) {
    const remotes = gitRead(repo, ['remote']);
    if (remotes) warnings.push(`le dépôt a un dépôt distant (${remotes.split('\n').join(', ')}) mais aucune base n'est appliquée aux contrôles (ni --against, ni --base, ni branche distante par défaut) : passer --against <branche distante>, par exemple origin/main.`);
    return none;
  }
  // Full refs only: a local branch or a tag named like the remote-tracking one is ambiguous, refused.
  let { sha, reason } = /^[0-9a-f]{7,39}$/.test(name) ? { sha: resolveCommit(repo, name), reason: 'introuvable' } : resolveFullRef(repo, name);
  if (!sha) throw new PipelineError('GATE_BASE', `Référence des contrôles ${name} ${reason}. Récupérez-la (git fetch) ou passez --against <branche de base>.`);
  // A local branch that has a remote-tracking twin: the remote one is what the change goes to.
  const twins = gitRead(repo, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/*/${name}`]);
  if (gitRead(repo, ['for-each-ref', '--format=%(refname)', `refs/heads/${name}`]) === `refs/heads/${name}` && twins) {
    warnings.push(`${name} est une branche locale, qui peut différer de ${twins.split('\n')[0]} : pour la base des contrôles, passer la branche distante (--against ${twins.split('\n')[0]}).`);
  }
  const remote = checkRemote(repo, name, sha, options);
  sha = remote.sha;
  warnings.push(...remote.warnings);
  const mergeBase = gitRead(repo, ['merge-base', sha, head]);
  // No common history: the base cannot be read, refused (never a silent fall back on the candidate's checks).
  if (!mergeBase || !/^[0-9a-f]{40,64}$/.test(mergeBase)) throw new PipelineError('GATE_BASE', `Aucune base commune entre ${name} et ${head.slice(0, 12)} : clone superficiel (git fetch --unshallow) ou référence sans lien ; les contrôles de la base ne peuvent pas être lus.`);
  const atBase = loadConfigAtCommit(repo, mergeBase);
  if (!atBase.file) return { config: candidate, base: { reference: name, mergeBase, file: null, differences: [], warnings } };
  const { config, differences } = enforceBaseGates(candidate, atBase.config);
  return { config, base: { reference: name, mergeBase, file: atBase.file, differences, warnings } };
}

export interface RemoteCheck {
  /** Reads the commit a remote branch points to (`git ls-remote`), null when the remote cannot be read. Tests inject it. */
  lsRemote?: (repo: string, remote: string, branch: string) => string | null;
  /**
   * `gates verify`: a reference behind the remote is refused (a base moved back on purpose would otherwise be accepted);
   * `gates run` only warns.
   */
  strict?: boolean;
}

const GIT_ENV = (): NodeJS.ProcessEnv => ({ ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'HOME', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND']), GIT_TERMINAL_PROMPT: '0' });

function lsRemote(repo: string, remote: string, branch: string): string | null {
  try {
    const out = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'ls-remote', '--end-of-options', remote, `refs/heads/${branch}`], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, env: GIT_ENV(),
    });
    return /^([0-9a-f]{40,64})\s/.exec(out)?.[1] ?? null;
  } catch { return null; }
}

/** Fetches this one branch into its remote-tracking ref (no tags, no submodules, no hooks, bounded); true when done. */
function fetchBranch(repo: string, remote: string, branch: string): boolean {
  try {
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--end-of-options', remote,
      `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'], timeout: 60_000, env: GIT_ENV() });
    return true;
  } catch { return false; }
}

const hasCommit = (repo: string, sha: string): boolean => gitRead(repo, ['cat-file', '-e', `${sha}^{commit}`]) !== null;

/**
 * A remote-tracking reference (`origin/main`) is a local file anyone can move (`git update-ref`): when the network
 * allows, it is compared with the remote. The remote commit missing locally (another PR merged since the last fetch):
 * this one branch is fetched, then compared again; if it cannot be fetched, a warning (not verified). Refused only when it
 * is proven that the local reference is not in the remote history. Behind the remote: a warning for `run`, a refusal for
 * `verify` (strict). The remote unreadable: a warning.
 */
function checkRemote(repo: string, name: string, sha: string, options: RemoteCheck): { sha: string; warnings: string[] } {
  const tracking = gitRead(repo, ['for-each-ref', '--format=%(refname)', `refs/remotes/${name}`]);
  if (tracking !== `refs/remotes/${name}`) return { sha, warnings: [] };
  const slash = name.indexOf('/');
  const remote = name.slice(0, slash); const branch = name.slice(slash + 1);
  if (!remote || !branch || branch === 'HEAD') return { sha, warnings: [] };
  const remoteSha = (options.lsRemote ?? lsRemote)(repo, remote, branch);
  if (remoteSha === null) return { sha, warnings: [`base non vérifiée auprès du dépôt distant (${remote} illisible, réseau absent ?) : ${name} est lue telle que le dépôt local la connaît (${sha.slice(0, 12)}) ; faire git fetch ${remote} dès que possible.`] };
  if (remoteSha === sha) return { sha, warnings: [] };
  if (!hasCommit(repo, remoteSha)) {
    if (!fetchBranch(repo, remote, branch) || !hasCommit(repo, remoteSha)) {
      return { sha, warnings: [`base non vérifiée : ${remote}/${branch} est à ${remoteSha.slice(0, 12)}, commit que le dépôt local n'a pas et n'a pas pu récupérer ; faire git fetch ${remote}, puis relancer.`] };
    }
    const fetched = resolveCommit(repo, `refs/remotes/${name}`);
    if (fetched === remoteSha) return { sha: remoteSha, warnings: [`${name} récupérée auprès du dépôt distant (${sha.slice(0, 12)} -> ${remoteSha.slice(0, 12)}) : la base des contrôles est celle du dépôt distant.`] };
  }
  const behind = gitRead(repo, ['merge-base', '--is-ancestor', sha, remoteSha]) !== null;
  if (!behind) {
    throw new PipelineError('GATE_BASE', `${name} pointe localement sur ${sha.slice(0, 12)}, que le dépôt distant ne contient pas (${remote}/${branch} : ${remoteSha.slice(0, 12)}) : référence déplacée ou divergente. git fetch ${remote} pour la remettre à jour ; la base des contrôles ne se lit jamais sur une référence que le dépôt distant contredit.`);
  }
  const message = `${name} (${sha.slice(0, 12)}) est en retard sur le dépôt distant (${remoteSha.slice(0, 12)}) : git fetch ${remote}, puis relancer.`;
  if (options.strict) throw new PipelineError('GATE_BASE', `${message} La vérification d'une preuve ne se fait jamais sur une base en retard (une base reculée ferait accepter des contrôles relâchés depuis).`);
  return { sha, warnings: [message] };
}

const KIND: Readonly<Record<GateDifferenceKind, string>> = {
  removed: 'retiré par le candidat',
  optional: 'rendu facultatif par le candidat',
  changed: 'modifié par le candidat',
  dependency: 'dépendance d\'un contrôle maintenu',
};

/** Lines for the text output: the warnings on the reference, and the checks kept, if any. */
export function baseGatesLines(base: BaseGates): string[] {
  const lines = base.warnings.map(w => `Attention : ${w}`);
  const kept = baseGatesLine(base);
  return kept ? [...lines, kept] : lines;
}

/** One line for the text output, or none when the candidate keeps every check of its base. */
export function baseGatesLine(base: BaseGates): string | null {
  if (!base.differences.length) return null;
  return `Contrôles de la base maintenus avec leur définition de base (base ${base.mergeBase?.slice(0, 12)}, ${base.reference}) : ${base.differences.map(d => `${d.id} (${KIND[d.kind]})`).join(', ')}. Le candidat peut seulement ajouter ou durcir des contrôles ; pour les changer, une PR de configuration seule, prouvée par les contrôles de sa base, puis fusionnée par l'opérateur.`;
}
