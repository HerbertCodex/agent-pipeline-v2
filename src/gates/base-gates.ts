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
  if (!name) return none;
  // Full refs only: a local branch or a tag named like the remote-tracking one is ambiguous, refused.
  const { sha, reason } = /^[0-9a-f]{7,39}$/.test(name) ? { sha: resolveCommit(repo, name), reason: 'introuvable' } : resolveFullRef(repo, name);
  if (!sha) throw new PipelineError('GATE_BASE', `Référence des contrôles ${name} ${reason}. Récupérez-la (git fetch) ou passez --against <branche de base>.`);
  warnings.push(...checkRemote(repo, name, sha, options));
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
}

function lsRemote(repo: string, remote: string, branch: string): string | null {
  try {
    const out = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'ls-remote', '--end-of-options', remote, `refs/heads/${branch}`], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
      env: { ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'HOME', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND']), GIT_TERMINAL_PROMPT: '0' },
    });
    return /^([0-9a-f]{40,64})\s/.exec(out)?.[1] ?? null;
  } catch { return null; }
}

/**
 * A remote-tracking reference (`origin/main`) is a local file anyone can move (`git update-ref`): when the network
 * allows, it is compared with the remote. Moved onto a commit the remote does not have: refused. Behind the remote (not
 * fetched): a warning. Remote unreadable: a warning that says the base was not verified.
 */
function checkRemote(repo: string, name: string, sha: string, options: RemoteCheck): string[] {
  const tracking = gitRead(repo, ['for-each-ref', '--format=%(refname)', `refs/remotes/${name}`]);
  if (tracking !== `refs/remotes/${name}`) return [];
  const slash = name.indexOf('/');
  const remote = name.slice(0, slash); const branch = name.slice(slash + 1);
  if (!remote || !branch || branch === 'HEAD') return [];
  const remoteSha = (options.lsRemote ?? lsRemote)(repo, remote, branch);
  if (remoteSha === null) return [`base non vérifiée auprès du dépôt distant (${remote} illisible, réseau absent ?) : ${name} est lue telle que le dépôt local la connaît (${sha.slice(0, 12)}).`];
  if (remoteSha === sha) return [];
  const behind = gitRead(repo, ['merge-base', '--is-ancestor', sha, remoteSha]) !== null;
  if (behind) return [`${name} (${sha.slice(0, 12)}) est en retard sur le dépôt distant (${remoteSha.slice(0, 12)}) : git fetch ${remote}, puis relancer.`];
  throw new PipelineError('GATE_BASE', `${name} pointe localement sur ${sha.slice(0, 12)}, que le dépôt distant ne contient pas (${remote}/${branch} : ${remoteSha.slice(0, 12)}) : référence déplacée ou divergente. git fetch ${remote} pour la remettre à jour ; la base des contrôles ne se lit jamais sur une référence que le dépôt distant contredit.`);
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
