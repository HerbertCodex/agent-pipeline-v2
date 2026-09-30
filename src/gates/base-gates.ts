import { loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { validateDag } from '../policy/policy.js';
import { gitRead, resolveCommit } from '../run/git-probe.js';
import { detectReference } from '../reuse/detect.js';

/**
 * The mandatory checks of the base (docs/CLI.md, « Contrôles obligatoires de la base »). A candidate commit carries its
 * own `.apv/config.json`: read alone, it could drop or loosen the checks that prove it. `apv gates run` and
 * `apv gates verify` therefore read the checks of the base (the merge base of the reference and the commit) and keep
 * every mandatory one with its base definition: removed, made optional or changed by the candidate, it is still required
 * as the base defined it, and the difference is said. The candidate can only add checks or harden them (a new check, a
 * check made mandatory). A change of these checks goes through a pull request of configuration alone, proven by the
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
  for (const gate of base.gates.filter(g => g.mandatory)) {
    const now = gates.find(g => g.id === gate.id);
    if (!now) keep(gate, 'removed');
    else if (!now.mandatory) keep(gate, 'optional');
    else if (stable(now) !== stable(gate)) keep(gate, 'changed');
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
export function applyBaseGates(repo: string, candidate: ApvConfig, head: string, reference: string | null): { config: ApvConfig; base: BaseGates } {
  const name = reference ?? detectReference(repo);
  const none = { config: candidate, base: { reference: name, mergeBase: null, file: null, differences: [] } };
  if (!name) return none;
  const sha = resolveCommit(repo, name);
  if (!sha) throw new PipelineError('GATE_BASE', `Référence des contrôles introuvable : ${name}. Récupérez-la (git fetch) ou passez --against <branche de base>.`);
  const mergeBase = gitRead(repo, ['merge-base', sha, head]);
  if (!mergeBase || !/^[0-9a-f]{40,64}$/.test(mergeBase)) return none;
  const atBase = loadConfigAtCommit(repo, mergeBase);
  if (!atBase.file) return { config: candidate, base: { reference: name, mergeBase, file: null, differences: [] } };
  const { config, differences } = enforceBaseGates(candidate, atBase.config);
  return { config, base: { reference: name, mergeBase, file: atBase.file, differences } };
}

const KIND: Readonly<Record<GateDifferenceKind, string>> = {
  removed: 'retiré par le candidat',
  optional: 'rendu facultatif par le candidat',
  changed: 'modifié par le candidat',
  dependency: 'dépendance d\'un contrôle maintenu',
};

/** One line for the text output, or none when the candidate keeps every mandatory check of its base. */
export function baseGatesLine(base: BaseGates): string | null {
  if (!base.differences.length) return null;
  return `Contrôles obligatoires de la base maintenus avec leur définition de base (base ${base.mergeBase?.slice(0, 12)}, ${base.reference}) : ${base.differences.map(d => `${d.id} (${KIND[d.kind]})`).join(', ')}. Le candidat peut seulement ajouter ou durcir des contrôles ; pour les changer, une PR de configuration seule, prouvée par les contrôles de sa base, puis fusionnée par l'opérateur.`;
}
