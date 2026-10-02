import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { PipelineError, errorMessage, invariant } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { gitRead } from '../run/git-probe.js';
import { LEDGER_FILE, LEGACY_LEDGER_FILE, decisionLedgerMarkdown, readWorkingDecisionLedger, validateDecisionLedger } from '../lifecycle/decisions.js';
import { designAttributeState } from './attributes.js';
import { declaredGroups } from './config.js';
import { listMockups, loadDesignConfig, mockupPlacement, relocatedValue, sha256File } from './registry.js';
import { assertNoLink, assertRealFolder, linkedComponent } from './links.js';
const workingLedgerFile = (repo) => [LEDGER_FILE, LEGACY_LEDGER_FILE].find(f => existsSync(join(repo, f))) ?? LEDGER_FILE;
function tracked(repo, path) {
    return gitRead(repo, ['ls-files', '--error-unmatch', '--', path]) !== null;
}
/** Tracked files that contain `text` (fixed string), the `excluded` ones aside. */
function citing(repo, text, excluded) {
    const out = gitRead(repo, ['grep', '-l', '-I', '-F', '-e', text, '--', '.', ...excluded.map(f => `:(exclude,literal)${f}`)]);
    return out ? out.split('\n').filter(Boolean) : [];
}
/**
 * Moves every validated mockup (confirmed decision with file and hash) that is not in the folder of its group
 * (`mockupPlacement`) into it, by `git mv` when Git follows the file, and rewrites the file path in the value of
 * its decision, in place: the validated content does not change, so no new version of the decision is added. The
 * ledger (JSON and its Markdown view) is the only other file written. Only regular HTML files under `design.dir`
 * move, never through a symbolic link (source or target). All or nothing: a mockup out of `design.dir`, linked,
 * changed or missing since its validation, or a target that already exists, blocks every move; the ledger must be
 * committed; a failure on the way puts the files and the ledger back. Lists the
 * tracked files that still name an old path, without changing them. `dryRun` computes the plan and writes nothing.
 */
export async function organizeMockups(repoPath, options = {}) {
    const dryRun = options.dryRun === true;
    const git = new Git();
    const repo = await git.root(repoPath);
    const settings = loadDesignConfig(repo);
    const mockups = listMockups(repo);
    const moves = [];
    const blocked = [];
    for (const m of mockups) {
        if (!m.file || !m.sha256)
            continue;
        const place = mockupPlacement(settings, m);
        if (place.placed)
            continue;
        const to = `${place.folder}/${posix.basename(m.file)}`;
        const base = { slug: m.slug, decisionId: m.decisionId, file: m.file, to };
        const sourceLink = linkedComponent(repo, m.file);
        const targetLink = linkedComponent(repo, to);
        let regular = false;
        try {
            regular = lstatSync(join(repo, m.file)).isFile();
        }
        catch { /* absent */ }
        if (!m.file.startsWith(`${settings.dir}/`))
            blocked.push({ ...base, reason: `fichier hors de ${settings.dir}/ : organize ne range que le dossier des maquettes (apv design register la verse dans son groupe)` });
        else if (!/\.html?$/i.test(m.file))
            blocked.push({ ...base, reason: 'pas un fichier HTML (.html ou .htm) : organize ne le déplace pas' });
        else if (sourceLink)
            blocked.push({ ...base, reason: `le fichier passe par un lien symbolique (${sourceLink}) : refusé` });
        else if (m.state === 'missing')
            blocked.push({ ...base, reason: 'fichier absent' });
        else if (!regular)
            blocked.push({ ...base, reason: 'pas un fichier régulier : refusé' });
        else if (targetLink)
            blocked.push({ ...base, reason: `la cible passe par un lien symbolique (${targetLink}) : refusé, elle pourrait sortir du dépôt` });
        else if (m.state !== 'ok')
            blocked.push({ ...base, reason: `fichier modifié depuis la validation (sha256 ${m.actualSha256} au lieu de ${m.sha256})` });
        else if (existsSync(join(repo, to)) || tracked(repo, to))
            blocked.push({ ...base, reason: `la cible ${to} existe déjà` });
        else if (moves.some(x => x.to === to))
            blocked.push({ ...base, reason: `une autre maquette va déjà vers ${to}` });
        else
            moves.push({ slug: m.slug, decisionId: m.decisionId, from: m.file, to, group: place.group, sha256: m.sha256, tracked: tracked(repo, m.file) });
    }
    const legacy = mockups.filter(m => !m.file).map(m => m.decisionId);
    const attributes = designAttributeState(repo, settings.dir, declaredGroups(settings));
    const ledgerFile = moves.length ? workingLedgerFile(repo) : null;
    const ledgerMarkdown = ledgerFile ? ledgerFile.replace(/\.json$/, '.md') : null;
    const empty = { repo, dryRun, applied: false, moves, blocked, legacy, ledgerFile, ledgerMarkdown, references: [], toAdd: [], toCommit: [], attributes };
    if (!moves.length)
        return empty;
    // The ledger with the new paths, validated before anything moves.
    const ledger = readWorkingDecisionLedger(repo);
    const byId = new Map(moves.map(m => [m.decisionId, m]));
    const next = validateDecisionLedger({ schemaVersion: 1, decisions: ledger.decisions.map(d => {
            const move = byId.get(d.id);
            return move ? { ...d, value: relocatedValue(d.value, move.from, move.to) } : d;
        }) });
    const nextJson = `${JSON.stringify(next, null, 2)}\n`;
    const nextMarkdown = decisionLedgerMarkdown(next);
    const references = moves.map(m => ({
        path: m.from,
        files: [...citing(repo, m.from, [ledgerFile, ledgerMarkdown]),
            ...(nextJson.includes(m.from) ? [ledgerFile] : []), ...(nextMarkdown.includes(m.from) ? [ledgerMarkdown] : [])],
    })).filter(r => r.files.length);
    const toAdd = [...moves.map(m => m.to), ledgerFile, ledgerMarkdown];
    const toCommit = [...moves.filter(m => m.tracked).map(m => m.from), ...toAdd];
    const plan = { ...empty, references, toAdd, toCommit };
    if (dryRun || blocked.length)
        return plan;
    const dirty = await git.exec(repo, ['status', '--porcelain=v1', '--', ledgerFile, ledgerMarkdown]);
    invariant(dirty.trim() === '', 'LEDGER_DIRTY', `${ledgerFile} ou ${ledgerMarkdown} a des changements non commités : commitez-les ou annulez-les d'abord`);
    for (const file of [ledgerFile, ledgerMarkdown])
        assertNoLink(repo, file, 'Le registre');
    const saved = [ledgerFile, ledgerMarkdown].map(f => ({ path: join(repo, f), text: existsSync(join(repo, f)) ? readFileSync(join(repo, f)) : null }));
    const done = [];
    /** Folders created by the moves (deepest first when walked back): removed on the way back while empty. */
    const created = [];
    let applied = false;
    try {
        for (const m of moves) {
            const folder = dirname(m.to);
            const top = mkdirSync(join(repo, folder), { recursive: true });
            if (top)
                created.push({ deepest: join(repo, folder), top });
            assertRealFolder(repo, folder);
            assertNoLink(repo, m.to, 'La cible');
            if (m.tracked)
                await git.exec(repo, ['mv', '--', m.from, m.to]);
            else
                renameSync(join(repo, m.from), join(repo, m.to));
            done.push(m);
            invariant(sha256File(join(repo, m.to)) === m.sha256, 'DESIGN_ORGANIZE', `Empreinte changée après le déplacement : ${m.to}`);
        }
        writeFileSync(join(repo, ledgerFile), nextJson);
        writeFileSync(join(repo, ledgerMarkdown), nextMarkdown);
        applied = true;
    }
    catch (error) {
        // Back as it was, as far as possible: every move undone in reverse order, each failure kept and reported.
        const problems = [];
        for (const m of done.reverse()) {
            try {
                if (m.tracked)
                    await git.exec(repo, ['mv', '--', m.to, m.from]);
                else
                    renameSync(join(repo, m.to), join(repo, m.from));
            }
            catch (undoError) {
                problems.push(`${m.to} -> ${m.from} : ${errorMessage(undoError)}`);
            }
        }
        for (const { deepest, top } of created.reverse()) {
            for (let dir = deepest; dir.startsWith(top); dir = dirname(dir)) {
                try {
                    rmdirSync(dir);
                }
                catch {
                    break;
                }
                if (dir === top)
                    break;
            }
        }
        throw new PipelineError('DESIGN_ORGANIZE', `Rangement interrompu (${errorMessage(error)}) : ${problems.length
            ? `déplacements annulés sauf ${problems.join(' ; ')}, à remettre à la main`
            : 'tous les déplacements ont été annulés'} ; registre remis comme avant.`, { cause: error });
    }
    finally {
        if (!applied)
            for (const { path, text } of saved) {
                if (text)
                    writeFileSync(path, text);
                else
                    rmSync(path, { force: true });
            }
    }
    return { ...plan, applied: true };
}
//# sourceMappingURL=organize.js.map