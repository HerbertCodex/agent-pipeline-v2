import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';
import { parseJson } from '../domain/schema.js';
import { LEDGER_FILE, LEGACY_LEDGER_FILE, decisionLedgerMarkdown, decisionLedgerSchema, validateDecisionLedger } from '../lifecycle/decisions.js';
import { mapSettings } from '../reuse/config.js';
import { writeMap } from '../commands/map.js';
/**
 * The files APV itself generates and that two pull requests of a batch may both have changed (decision D1 of the pilot
 * project, 3 October 2026: each implementer regenerates and commits the code map in his commit): the code map (`map.file`),
 * the decision ledger (`.apv/DECISIONS.json`, or its V2 place) and its readable version (`.apv/DECISIONS.md`). A merge
 * of the batch that stops on them is not a conflict of the code: the files are regenerated from the merged tree (the
 * ledger by the union of its decisions, the map by `apv map`), never resolved by hand (docs/REUSE.md). Anything else in
 * conflict keeps the pull request out of the batch.
 */
/** The generated files of a copy at `dir`, from its configuration (unreadable: the default map file). */
export function generatedFiles(dir) {
    let map;
    try {
        map = mapSettings(loadConfig(dir).config.map).file;
    }
    catch {
        map = mapSettings(undefined).file;
    }
    const ledger = existsSync(join(dir, LEGACY_LEDGER_FILE)) && !existsSync(join(dir, LEDGER_FILE)) ? LEGACY_LEDGER_FILE : LEDGER_FILE;
    return { map, ledger, ledgerMarkdown: ledger.replace(/\.json$/, '.md') };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
/**
 * The union of two ledgers that diverged from `base` (null when the file is new on both sides), symmetric (the result is
 * the same whichever side is « ours »): a decision kept by both is kept in the order of the base, a decision changed on
 * one side only takes that change, a decision deleted on one side and untouched on the other goes, a decision added on
 * one side (or identically on both) is appended, added decisions sorted by id. A decision changed, or added differently,
 * on both sides is a real conflict: nothing is merged.
 */
export function mergeLedgers(base, ours, theirs) {
    if (ours.schemaVersion !== theirs.schemaVersion)
        return { conflict: 'versions de schéma différentes' };
    const index = (l) => new Map((l?.decisions ?? []).map(d => [d.id, d]));
    const [b, o, t] = [index(base), index(ours), index(theirs)];
    const decisions = [];
    for (const [id, atBase] of b) {
        const [mine, yours] = [o.get(id), t.get(id)];
        if (mine && yours) {
            if (same(mine, yours))
                decisions.push(mine);
            else if (same(mine, atBase))
                decisions.push(yours);
            else if (same(yours, atBase))
                decisions.push(mine);
            else
                return { conflict: `décision ${id} modifiée des deux côtés` };
        }
        else if (mine || yours) {
            const kept = (mine ?? yours);
            if (!same(kept, atBase))
                return { conflict: `décision ${id} modifiée d'un côté et retirée de l'autre` };
        }
    }
    const added = new Map();
    for (const [id, d] of [...o, ...t]) {
        if (b.has(id))
            continue;
        const seen = added.get(id);
        if (seen && !same(seen, d))
            return { conflict: `décision ${id} ajoutée différemment des deux côtés` };
        added.set(id, d);
    }
    decisions.push(...[...added.values()].sort((x, y) => byBytes(x.id, y.id)));
    // The union must be a valid ledger (each rule is checked here, not left to the Markdown), and its replacements must
    // hold together: two decisions added on each side that replace the same one, or a replacement of a decision absent
    // from the union (retired on the other side), are conflicts of meaning that a textual merge would never see.
    const ids = new Set(decisions.map(d => d.id));
    const replaced = new Map();
    for (const d of decisions) {
        const atBase = b.get(d.id);
        if (atBase && same(d, atBase))
            continue;
        for (const target of d.supersedes) {
            if (!ids.has(target))
                return { conflict: `décision ${d.id} remplace ${target}, absente du registre fusionné` };
            const other = replaced.get(target);
            if (other !== undefined && !b.has(d.id) && !b.has(other))
                return { conflict: `décisions ${other} et ${d.id}, ajoutées de part et d'autre, remplacent toutes deux ${target}` };
            replaced.set(target, d.id);
        }
    }
    try {
        return { ledger: validateDecisionLedger({ schemaVersion: ours.schemaVersion, decisions }) };
    }
    catch (error) {
        return { conflict: `registre fusionné invalide : ${errorMessage(error)}` };
    }
}
/** A ledger read from a stage of the index of a stopped merge; null when that stage has no file (added or deleted on a side). */
async function stagedLedger(git, dir, stage, path) {
    const r = await git.run(dir, ['show', `:${stage}:${path}`]);
    if (!r.ok)
        return { ledger: null, error: null };
    try {
        return { ledger: validateDecisionLedger(decisionLedgerSchema.parse(parseJson(r.stdout))), error: null };
    }
    catch (error) {
        return { ledger: null, error: `registre illisible (${stage === 1 ? 'base' : stage === 2 ? 'lot' : 'PR'}) : ${errorMessage(error)}` };
    }
}
const write = (dir, path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
/**
 * Resolves a merge of `dir` stopped on `conflicted` paths when every one of them is a generated file: the ledger by the
 * union of its decisions (stages 1, 2 and 3 of the index), its Markdown from the merged ledger, the code map (and the
 * generated parts of the architecture map) by `apv map` on the merged tree. The files written are returned, to be added
 * and committed by the caller; a conflict on any other file, or a real conflict of the ledger, resolves nothing.
 */
export async function resolveGeneratedConflicts(git, dir, conflicted) {
    const generated = generatedFiles(dir);
    const known = new Set([generated.map, generated.ledger, generated.ledgerMarkdown]);
    const other = conflicted.filter(p => !known.has(p));
    if (other.length)
        return { ok: false, reason: `fichier(s) en conflit hors des fichiers générés : ${other.slice(0, 5).join(', ')}${other.length > 5 ? ', ...' : ''}` };
    const files = [];
    let ledger = null;
    if (conflicted.includes(generated.ledger)) {
        const base = await stagedLedger(git, dir, 1, generated.ledger);
        const ours = await stagedLedger(git, dir, 2, generated.ledger);
        const theirs = await stagedLedger(git, dir, 3, generated.ledger);
        const failed = [base, ours, theirs].find(x => x.error);
        if (failed)
            return { ok: false, reason: `${generated.ledger} : ${failed.error}` };
        if (!ours.ledger || !theirs.ledger)
            return { ok: false, reason: `${generated.ledger} : retiré d'un côté et modifié de l'autre` };
        const merged = mergeLedgers(base.ledger, ours.ledger, theirs.ledger);
        if ('conflict' in merged)
            return { ok: false, reason: `${generated.ledger} : ${merged.conflict}` };
        ledger = merged.ledger;
        write(dir, generated.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
        files.push(generated.ledger);
    }
    if (conflicted.includes(generated.ledgerMarkdown) || ledger) {
        if (!ledger) {
            // The Markdown alone in conflict: rendered from the ledger the merge left (merged without conflict, or unchanged).
            const r = await git.run(dir, ['show', `:0:${generated.ledger}`]);
            if (!r.ok)
                return { ok: false, reason: `${generated.ledgerMarkdown} en conflit sans registre ${generated.ledger} lisible dans l'index` };
            try {
                ledger = validateDecisionLedger(decisionLedgerSchema.parse(parseJson(r.stdout)));
            }
            catch (error) {
                return { ok: false, reason: `${generated.ledger} illisible : ${errorMessage(error)}` };
            }
        }
        write(dir, generated.ledgerMarkdown, decisionLedgerMarkdown(ledger));
        files.push(generated.ledgerMarkdown);
    }
    if (conflicted.includes(generated.map)) {
        const written = await regenerateMap(dir);
        if (!written.ok)
            return written;
        // The map is regenerated whatever its text in the index said; the architecture map follows when its parts changed.
        files.push(...new Set([generated.map, ...written.files]));
    }
    return { ok: true, files };
}
/** `apv map` in `dir` with the configuration of `dir`: the files it wrote (the map, the architecture map), or why not. */
async function regenerateMap(dir) {
    try {
        const { config } = loadConfig(dir);
        const result = await writeMap(dir, config, false);
        const files = [...(result.status === 'written' ? [result.file] : []), ...(result.architecture.status === 'written' ? [result.architecture.file] : [])];
        return { ok: true, files };
    }
    catch (error) {
        return { ok: false, reason: `carte du code non régénérée : ${errorMessage(error)}` };
    }
}
/**
 * After a merge without conflict: the code map (and the generated parts of the architecture map) of `dir`, regenerated
 * when stale (two pull requests whose maps merged textually but no longer describe the merged code). The files written;
 * empty when up to date, or when the project has no map (nothing is created here).
 */
export async function regenerateStaleMap(dir) {
    let stale;
    try {
        const { config } = loadConfig(dir);
        const check = await writeMap(dir, config, true);
        stale = check.status === 'stale' || check.architecture.status === 'stale';
    }
    catch (error) {
        return { ok: false, reason: `carte du code non vérifiée : ${errorMessage(error)}` };
    }
    if (!stale)
        return { ok: true, files: [] };
    return regenerateMap(dir);
}
//# sourceMappingURL=regenerate.js.map