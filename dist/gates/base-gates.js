import { loadConfigAtCommit } from '../config/load.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { validateDag } from '../policy/policy.js';
import { gitRead, resolveCommit } from '../run/git-probe.js';
import { detectReference } from '../reuse/detect.js';
/** JSON with sorted keys: two definitions compare by content, whatever the order of their fields. */
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}
/** The checks of `candidate` with every mandatory check of `base` kept in its base definition (and what it depends on). */
export function enforceBaseGates(candidate, base) {
    const gates = candidate.gates.map(g => structuredClone(g));
    const differences = [];
    const keep = (gate, kind) => {
        const index = gates.findIndex(g => g.id === gate.id);
        if (index < 0)
            gates.push(structuredClone(gate));
        else
            gates[index] = structuredClone(gate);
        differences.push({ id: gate.id, kind });
    };
    for (const gate of base.gates.filter(g => g.mandatory)) {
        const now = gates.find(g => g.id === gate.id);
        if (!now)
            keep(gate, 'removed');
        else if (!now.mandatory)
            keep(gate, 'optional');
        else if (stable(now) !== stable(gate))
            keep(gate, 'changed');
    }
    // A kept check runs with what it depends on at the base.
    for (let added = true; added;) {
        added = false;
        for (const gate of [...gates]) {
            for (const dep of gate.dependsOn) {
                if (gates.some(g => g.id === dep))
                    continue;
                const atBase = base.gates.find(g => g.id === dep);
                if (atBase) {
                    keep(atBase, 'dependency');
                    added = true;
                }
            }
        }
    }
    const config = { ...candidate, gates };
    try {
        validateDag(config.gates);
    }
    catch (error) {
        throw new PipelineError('CONFIG', `Contrôles de la base et du candidat incompatibles : ${errorMessage(error)}`);
    }
    return { config, differences };
}
/**
 * Reads the checks of the base of `head` and keeps its mandatory ones. The reference is `reference` when given, else
 * the default branch of the remote (`origin/HEAD`, `origin/main`, `origin/master`); without one, or when the base has no
 * configuration of its own, the candidate's checks are used as they are (`file` null).
 */
export function applyBaseGates(repo, candidate, head, reference) {
    const name = reference ?? detectReference(repo);
    const none = { config: candidate, base: { reference: name, mergeBase: null, file: null, differences: [] } };
    if (!name)
        return none;
    const sha = resolveCommit(repo, name);
    if (!sha)
        throw new PipelineError('GATE_BASE', `Référence des contrôles introuvable : ${name}. Récupérez-la (git fetch) ou passez --against <branche de base>.`);
    const mergeBase = gitRead(repo, ['merge-base', sha, head]);
    if (!mergeBase || !/^[0-9a-f]{40,64}$/.test(mergeBase))
        return none;
    const atBase = loadConfigAtCommit(repo, mergeBase);
    if (!atBase.file)
        return { config: candidate, base: { reference: name, mergeBase, file: null, differences: [] } };
    const { config, differences } = enforceBaseGates(candidate, atBase.config);
    return { config, base: { reference: name, mergeBase, file: atBase.file, differences } };
}
const KIND = {
    removed: 'retiré par le candidat',
    optional: 'rendu facultatif par le candidat',
    changed: 'modifié par le candidat',
    dependency: 'dépendance d\'un contrôle maintenu',
};
/** One line for the text output, or none when the candidate keeps every mandatory check of its base. */
export function baseGatesLine(base) {
    if (!base.differences.length)
        return null;
    return `Contrôles obligatoires de la base maintenus avec leur définition de base (base ${base.mergeBase?.slice(0, 12)}, ${base.reference}) : ${base.differences.map(d => `${d.id} (${KIND[d.kind]})`).join(', ')}. Le candidat peut seulement ajouter ou durcir des contrôles ; pour les changer, une PR de configuration seule, prouvée par les contrôles de sa base, puis fusionnée par l'opérateur.`;
}
//# sourceMappingURL=base-gates.js.map