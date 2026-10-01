import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, posix, resolve } from 'node:path';
import { PipelineError, invariant } from '../domain/errors.js';
import { loadConfig } from '../config/load.js';
import { declaredGroups, designSettings, groupDir, groupFolder, groupForName } from './config.js';
import { Git } from '../execution/git.js';
import { ambiguousApprovalFragments, loadDecisionLedger, readWorkingDecisionLedger } from '../lifecycle/decisions.js';
import { applyLedgerUpdate, planLedgerUpdate } from '../lifecycle/ledger-update.js';
import { ensureDesignAttribute } from './attributes.js';
import { assertNoLink, assertRealFolder, realInside } from './links.js';
export { DEFAULT_DESIGN_DIR } from './config.js';
/** Lowercase words joined by single dashes; short enough for the decision id (80 characters at most). */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 50;
/** Decision ids of a registration: `maquette-<slug>-validee`, then `-v2`, `-v3`... for each re-registration. */
const DECISION_ID = /^maquette-([a-z0-9]+(?:-[a-z0-9]+)*?)-validee(?:-v([0-9]+))?$/;
/** Machine-readable part of the decision value written by `register`: the file and its fingerprint. */
const VALUE_FILE = /fichier (\S+?),? sha256 ([0-9a-f]{64})/;
const FILE_PREFIX = 'fichier ';
/**
 * Structured mentions, read only right after the file and fingerprint, in the order `register` writes them (a title
 * or a screen never makes one, and `register` refuses those words in them). Screens and artifact of a decision
 * written before the tool (no fingerprint) are read anywhere, as before.
 */
const TAIL_SCREENS = /^ Écrans : ([^.]+)\./;
/** Group chosen with `register --group`, kept by the next registrations and followed by `organize`. */
const TAIL_GROUP = /^ Groupe : ([A-Za-z0-9._/-]+?)\.(?=\s|$)/;
const TAIL_ARTIFACT = /^ Artefact : (\S+?)\.?(?:\s|$)/;
const LEGACY_SCREENS = /Écrans : ([^.]+)\./;
const LEGACY_ARTIFACT = /Artefact : (\S+?)\.?(?:\s|$)/;
/** Words of the structured mentions, refused in a title or a screen name. */
const RESERVED_WORDS = /(?:Groupe|Écrans|Ecrans|Artefact)\s*:|fichier\s+\S+?,?\s+sha256/i;
function valueParts(value) {
    const split = (list) => list?.split(',').map(x => x.trim()).filter(Boolean) ?? [];
    const found = VALUE_FILE.exec(value);
    if (!found)
        return { file: null, sha256: null, screens: split(LEGACY_SCREENS.exec(value)?.[1]), artifact: LEGACY_ARTIFACT.exec(value)?.[1] ?? null, group: null };
    let tail = value.slice(found.index + found[0].length).replace(/^\./, '');
    const take = (pattern) => {
        const m = pattern.exec(tail);
        if (m)
            tail = tail.slice(m[0].length);
        return m?.[1];
    };
    const screens = split(take(TAIL_SCREENS));
    const group = take(TAIL_GROUP) ?? null;
    const artifact = take(TAIL_ARTIFACT) ?? null;
    return { file: found[1], sha256: found[2], screens, artifact, group };
}
/**
 * `design` section of the project configuration, read by the main loader (`.apv/config.json`, else
 * `pipeline.v2.json`): the folder must stay inside the repository, the groups inside the folder.
 */
export function loadDesignConfig(repo) {
    const { file, config } = loadConfig(repo);
    return { ...designSettings(config.design), configFile: file };
}
export function sha256File(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function parseMockup(repo, decision) {
    const id = DECISION_ID.exec(decision.id);
    if (!id || decision.status !== 'confirmed')
        return null;
    const parts = valueParts(decision.value);
    const base = { slug: id[1], decisionId: decision.id, version: id[2] ? Number(id[2]) : 1, subject: decision.subject, screens: parts.screens, artifact: parts.artifact,
        recordedGroup: parts.group, sourceQuote: decision.sourceQuote };
    if (!parts.file || !parts.sha256)
        return { ...base, file: null, sha256: null, actualSha256: null, state: 'legacy' };
    const file = parts.file;
    const expected = parts.sha256;
    // By real path: a file reached through a link that leaves the repository is not read (absent).
    const real = realInside(repo, file);
    const actual = real && statSync(real).isFile() ? sha256File(real) : null;
    return { ...base, file, sha256: expected, actualSha256: actual, state: actual === null ? 'missing' : actual === expected ? 'ok' : 'drift' };
}
/**
 * The value of a mockup decision with its file path `from` replaced by `to` (the sha256 and every other word kept):
 * the decision of a mockup moved by `apv design organize`. Throws when the value does not carry `from`.
 */
export function relocatedValue(value, from, to) {
    const found = VALUE_FILE.exec(value);
    invariant(found && found[1] === from, 'DESIGN_ORGANIZE', `La décision ne porte pas le fichier ${from}`);
    const start = found.index + FILE_PREFIX.length;
    return `${value.slice(0, start)}${to}${value.slice(start + from.length)}`;
}
/** Validated mockups of the ledger as a commit has it (the base of a change), checked against the files on disk. */
export async function listMockupsAt(repo, sha) {
    const ledger = await loadDecisionLedger(repo, sha);
    return ledger.decisions.map(d => parseMockup(repo, d)).filter((m) => m !== null);
}
/** Validated mockups of the working-tree ledger, in ledger order. */
export function listMockups(repo) {
    const ledger = readWorkingDecisionLedger(repo);
    return ledger.decisions.map(d => parseMockup(repo, d)).filter((m) => m !== null);
}
/**
 * Group of a validated mockup: the group recorded by `register --group` while it is still declared, otherwise the
 * first group whose patterns match its name, otherwise `design.defaultGroup`, otherwise the root of `design.dir`.
 */
export function mockupPlacement(settings, mockup) {
    const group = mockup.recordedGroup && declaredGroups(settings).includes(mockup.recordedGroup) ? mockup.recordedGroup : groupForName(settings, mockup.slug);
    const folder = groupFolder(settings, group);
    return { group, folder, placed: mockup.file ? posix.dirname(mockup.file) === folder : null };
}
export function validateSlug(slug) {
    invariant(SLUG_PATTERN.test(slug), 'DESIGN_SLUG', `Nom invalide « ${slug} » : minuscules, chiffres et tirets simples (ex. tableau-de-bord)`);
    invariant(slug.length <= SLUG_MAX, 'DESIGN_SLUG', `Nom trop long (${slug.length} caractères, ${SLUG_MAX} au plus)`);
    invariant(!slug.split('-').includes('validee'), 'DESIGN_SLUG', `Nom invalide « ${slug} » : « validee » est ajouté par l'outil`);
}
/**
 * Registers an operator-validated mockup: copies it to `<design.dir>/<group>/<slug>-validee.html` (group: see
 * `chooseGroup`; none without `design.groups`), and records a
 * confirmed operator decision carrying the file path, its sha256 and the operator's exact words. The
 * ledger is changed through the reviewed ledger-update API (never in place): a re-registration adds
 * `maquette-<slug>-validee-v<n>` that supersedes the active one. Nothing is committed.
 */
export async function registerMockup(repoPath, input) {
    const quote = input.quote.trim();
    invariant(quote.length > 0, 'DESIGN_QUOTE', 'Citation de l\'opérateur manquante (--quote) : seule sa validation explicite, citée mot pour mot, verse une maquette. Le pipeline n\'invente jamais une approbation.');
    const partial = ambiguousApprovalFragments(quote);
    invariant(partial.length === 0, 'DESIGN_QUOTE', `La citation est une validation avec réserve (« ${partial[0]} ») : ce n'est pas une validation. Traitez les réserves, puis enregistrez la validation sans réserve.`);
    validateSlug(input.slug);
    const git = new Git();
    const repo = await git.root(repoPath);
    const source = resolve(repoPath, input.file);
    invariant(existsSync(source) && statSync(source).isFile(), 'DESIGN_FILE', `Fichier introuvable : ${input.file}`);
    invariant(!lstatSync(source).isSymbolicLink(), 'DESIGN_LINK', `La maquette ${input.file} est un lien symbolique : versez le fichier lui-même`);
    invariant(['.html', '.htm'].includes(extname(source).toLowerCase()), 'DESIGN_FILE', `La maquette doit être un fichier HTML : ${input.file}`);
    invariant(statSync(source).size > 0, 'DESIGN_FILE', `Fichier vide : ${input.file}`);
    const settings = loadDesignConfig(repo);
    const { dir } = settings;
    const groups = declaredGroups(settings);
    const sha = sha256File(source);
    const current = listMockups(repo).filter(m => m.slug === input.slug);
    const active = current.sort((a, b) => b.version - a.version)[0];
    const { group, recordedGroup } = chooseGroup(settings, input.slug, input.group, active);
    const target = `${groupFolder(settings, group)}/${input.slug}-validee.html`;
    const targetPath = join(repo, target);
    const previousFile = active?.file && active.file !== target ? active.file : null;
    const activeDecision = active ? readWorkingDecisionLedger(repo).decisions.find(d => d.id === active.decisionId) : undefined;
    // Absent: the scope of the active registration is kept; given (even empty): it replaces it.
    const scopePaths = input.scopePaths === undefined ? [...(activeDecision?.scope?.paths ?? [])] : [...new Set(input.scopePaths.map(x => x.trim()).filter(Boolean))];
    const sameScope = JSON.stringify(activeDecision?.scope?.paths ?? []) === JSON.stringify(scopePaths);
    if (active && active.sha256 === sha && active.file === target && active.actualSha256 === sha && sameScope && active.recordedGroup === recordedGroup) {
        return { repo, slug: input.slug, decisionId: active.decisionId, supersedes: [], target, group, previousFile: null, sha256: sha, ledgerFile: '', ledgerMarkdown: '', unchanged: true,
            attributes: ensureDesignAttribute(repo, dir, false, groups) };
    }
    const version = active ? Math.max(...current.map(m => m.version)) + 1 : 1;
    const decisionId = version === 1 ? `maquette-${input.slug}-validee` : `maquette-${input.slug}-validee-v${version}`;
    const title = input.title?.trim() || input.slug;
    invariant(!RESERVED_WORDS.test(title), 'DESIGN_TITLE', `Titre invalide « ${title} » : « Groupe : », « Écrans : », « Artefact : » et « fichier … sha256 » sont réservés à la valeur de la décision`);
    const screens = (input.screens ?? []).map(x => x.trim()).filter(Boolean);
    invariant(screens.every(x => !/[,.]/.test(x)), 'DESIGN_SCREENS', 'Un nom d\'écran ne contient ni virgule ni point');
    invariant(screens.every(x => !RESERVED_WORDS.test(x)), 'DESIGN_SCREENS', 'Un nom d\'écran ne contient pas « Groupe : », « Écrans : », « Artefact : » ni « fichier … sha256 »');
    const artifact = input.artifact?.trim();
    invariant(!artifact || /^https:\/\/\S+$/.test(artifact), 'DESIGN_ARTIFACT', `Adresse d'artefact invalide : ${artifact}`);
    const day = (input.now ?? new Date()).toISOString().slice(0, 10);
    const value = [
        `La maquette « ${title} », validée par l'opérateur le ${day}, est la référence absolue (structure, textes mot pour mot, couleurs, états, thèmes, largeurs) : fichier ${target}, sha256 ${sha}.`,
        screens.length ? `Écrans : ${screens.join(', ')}.` : '',
        recordedGroup ? `Groupe : ${recordedGroup}.` : '',
        artifact ? `Artefact : ${artifact}` : '',
    ].filter(Boolean).join(' ');
    const decision = {
        id: decisionId, subject: `Maquette validée : ${title}`, value, enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: quote,
        rationale: 'Validation explicite de l\'opérateur après itérations sur l\'artefact ; les implementers la reproduisent et la revue de fidélité compare à ce fichier. Enregistrée par apv design register.',
        supersedes: active ? [active.decisionId] : [], clarificationQuestion: '', interpretations: [],
        ...(scopePaths.length || activeDecision?.scope?.specs ? { scope: { ...(scopePaths.length ? { paths: scopePaths } : {}), ...(activeDecision?.scope?.specs ? { specs: activeDecision.scope.specs } : {}) } } : {}),
    };
    const update = { decisions: [decision] };
    const plan = await planLedgerUpdate(repo, update);
    assertNoLink(repo, target, 'La cible');
    const previous = existsSync(targetPath) ? readFileSync(targetPath) : null;
    if (resolve(source) !== resolve(targetPath)) {
        mkdirSync(dirname(targetPath), { recursive: true });
        assertRealFolder(repo, dirname(target));
        copyFileSync(source, targetPath);
    }
    invariant(sha256File(targetPath) === sha, 'DESIGN_FILE', `Copie altérée : ${target}`);
    try {
        await applyLedgerUpdate(repo, update, plan.hash, input.reviewer ?? 'apv design register', `Maquette validée ${input.slug} (${sha.slice(0, 12)})`, false);
    }
    catch (error) {
        if (resolve(source) !== resolve(targetPath)) {
            if (previous)
                writeFileSync(targetPath, previous);
            else
                rmSync(targetPath, { force: true });
        }
        throw error;
    }
    return { repo, slug: input.slug, decisionId, supersedes: decision.supersedes, target, group, previousFile, sha256: sha, ledgerFile: plan.file, ledgerMarkdown: plan.file.replace(/\.json$/, '.md'), unchanged: false,
        attributes: ensureDesignAttribute(repo, dir, false, groups) };
}
/**
 * Group of a registration and the group to record in its decision: `--group` (a declared group, recorded); else the
 * group of the active registration (its recorded group while declared, recorded again; or the folder its file is
 * in, root or declared group: a re-registration never moves a mockup, `apv design organize` does); else the patterns.
 */
function chooseGroup(settings, slug, explicit, active) {
    const groups = declaredGroups(settings);
    if (explicit !== undefined) {
        invariant(groups.length > 0, 'DESIGN_GROUP', '--group : aucun groupe déclaré (design.groups ou design.defaultGroup de .apv/config.json)');
        let group;
        try {
            group = groupDir(explicit, '--group');
        }
        catch (error) {
            throw new PipelineError('DESIGN_GROUP', error.message);
        }
        invariant(groups.includes(group), 'DESIGN_GROUP', `--group : groupe non déclaré « ${group} » (groupes déclarés : ${groups.join(', ')})`);
        return { group, recordedGroup: group };
    }
    if (active?.recordedGroup && groups.includes(active.recordedGroup))
        return { group: active.recordedGroup, recordedGroup: active.recordedGroup };
    if (active?.file) {
        const folder = posix.dirname(active.file);
        if (folder === settings.dir)
            return { group: null, recordedGroup: null };
        const inGroup = groups.find(g => folder === groupFolder(settings, g));
        if (inGroup)
            return { group: inGroup, recordedGroup: null };
    }
    return { group: groupForName(settings, slug), recordedGroup: null };
}
/** Normalized screen name, for `list --screen`: case, accents and separators ignored. */
export function screenKey(name) {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
export function matchesScreen(mockup, screen) {
    const key = screenKey(screen);
    return screenKey(mockup.slug) === key || mockup.screens.some(s => screenKey(s) === key);
}
//# sourceMappingURL=registry.js.map