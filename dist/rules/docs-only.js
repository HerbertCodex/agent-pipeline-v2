import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { RESERVED_GROUP } from '../design/config.js';
import { mockupDecision } from '../design/registry.js';
import { modeChange, parseRawDiff } from '../gates/proof-scope.js';
import { decisionLedgerMarkdown, LEDGER_FILE, loadDecisionLedger } from '../lifecycle/decisions.js';
import { matches } from '../policy/policy.js';
import { AGENT_INSTRUCTIONS, CONFIG_FILES } from '../review/risk.js';
import { anchoredQuote } from './operator.js';
/** Name of the lane in the reports. */
export const LANE_NAME = 'voie sans code';
export const KIND_LABEL = {
    decisions: 'registre des décisions', mockups: 'maquette validée', drafts: 'brouillon de maquette', specs: 'spec',
    journal: 'journal du pipeline', docs: 'documentation',
};
const JOURNAL = '.apv/journal-pipeline.md';
const LEDGER_TEXT = '.apv/DECISIONS.md';
/** Extensions a file of each kind may have (the ledger and the journal are fixed paths). */
const MOCKUP_EXTENSIONS = ['.html', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.css'];
const EXTENSIONS = {
    specs: ['.json'], mockups: MOCKUP_EXTENSIONS, drafts: MOCKUP_EXTENSIONS, docs: ['.md'],
};
/** Files at the root whose `@path` imports are instructions too (Claude Code reads them at the start of every session). */
const IMPORTERS = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.claude/CLAUDE.md'];
const IMPORT = /(?:^|[\s([])@((?:\.{1,2}\/)?[^\s`'"()<>[\]]+)/g;
const SHOWN = 50;
const safe = (path, glob) => { try {
    return matches(path, glob);
}
catch {
    return false;
} };
/** Whether a glob matches the path, case ignored: `Docs/Claude.md` is `docs/CLAUDE.md` on a file system without case. */
const anyCase = (path, globs) => globs.some(g => safe(path.toLowerCase(), g.toLowerCase()));
const under = (path, dir) => path.startsWith(`${dir}/`);
/** `.json` of `a/b.json`; null for a dotfile (`.gitattributes`) or a name without extension. */
function extensionOf(path) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return name.startsWith('.') || dot <= 0 ? null : name.slice(dot).toLowerCase();
}
function gitShow(repo, sha, path) {
    try {
        return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'cat-file', 'blob', `${sha}:${path}`], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
    }
    catch {
        return null;
    }
}
function blobHash(repo, sha, path) {
    const data = gitShow(repo, sha, path);
    return data ? createHash('sha256').update(data).digest('hex') : null;
}
function rawFiles(repo, base, head) {
    try {
        return parseRawDiff(execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-abbrev', '--ignore-submodules=none', base, head, '--'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }));
    }
    catch {
        return null;
    }
}
/** The files the root instructions import by `@path` (at the base and at the head), lower case, with the importer. */
function importedInstructions(repo, shas) {
    const out = new Map();
    for (const sha of shas)
        for (const file of IMPORTERS) {
            const text = gitShow(repo, sha, file)?.toString('utf8');
            if (!text)
                continue;
            for (const m of text.matchAll(IMPORT)) {
                const target = m[1].replace(/[.,;:!?]+$/, '');
                if (!target || target.startsWith('~') || target.startsWith('/'))
                    continue;
                const path = posix.normalize(posix.join(posix.dirname(file), target));
                if (!path.startsWith('..'))
                    out.set(path.toLowerCase(), file);
            }
        }
    return out;
}
/** The kind of one side of a changed file, or why it keeps the normal rules. */
function kindOf(path, deleted, documentation, input, imports) {
    const { settings } = input;
    if (anyCase(path, settings.exclude))
        return { why: 'exclu par rules.docsOnly.exclude' };
    if (anyCase(path, CONFIG_FILES))
        return { why: 'configuration (outil, tests, dépendances, CI)' };
    if (anyCase(path, input.sensitive) || anyCase(path, AGENT_INSTRUCTIONS))
        return { why: 'chemin sensible ou instructions des agents' };
    const importer = imports.get(path.toLowerCase());
    if (importer)
        return { why: `importé par ${importer} (instructions des agents)` };
    const drafts = `${input.designDir}/${RESERVED_GROUP}`;
    let kind = null;
    if (path === LEDGER_FILE || path === LEDGER_TEXT)
        kind = 'decisions';
    else if (path === JOURNAL)
        kind = 'journal';
    else if (under(path, '.apv/specs'))
        kind = 'specs';
    else if (under(path, drafts))
        kind = 'drafts';
    else if (under(path, input.designDir))
        kind = 'mockups';
    else if (documentation && path.endsWith('.md') && !under(path, '.apv'))
        kind = 'docs';
    if (!kind)
        return { why: 'hors de la liste de la voie sans code (code, interface, configuration, état ou fichier non classé)' };
    const allowed = EXTENSIONS[kind];
    if (allowed && !allowed.includes(extensionOf(path) ?? ''))
        return { why: `${KIND_LABEL[kind]} : extension hors de la liste (${allowed.join(', ')}), jamais un script ni un fichier sans extension` };
    if (!settings.kinds.includes(kind))
        return { why: `${KIND_LABEL[kind]} : type retiré de la voie par rules.docsOnly.kinds` };
    if (deleted && (kind === 'decisions' || kind === 'mockups'))
        return { why: `${KIND_LABEL[kind]} supprimé(e)` };
    return { kind };
}
const sameDecision = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quoteKey = (quote) => quote.normalize('NFC').toLowerCase().replace(/[\s.,;:!?«»"']+/g, ' ').trim();
/** Why the ledger at the head is more than an anchored growth of the ledger at the base (see above); empty when it is. */
function ledgerBlocking(atBase, atHead, input) {
    const out = [];
    const at = (why, path = LEDGER_FILE) => { out.push({ path, why }); };
    const headIds = new Set(atHead.map(d => d.id));
    const baseById = new Map(atBase.map(d => [d.id, d]));
    const baseQuotes = new Map(atBase.filter(d => quoteKey(d.sourceQuote)).map(d => [quoteKey(d.sourceQuote), d.id]));
    for (const d of atBase)
        if (!headIds.has(d.id))
            at(`décision ${d.id} supprimée : une décision fusionnée ne se retire que relue`);
    for (const d of atHead) {
        const before = baseById.get(d.id);
        if (before) {
            if (!sameDecision(before, d)) {
                const fields = Object.keys({ ...before, ...d }).filter(k => JSON.stringify(before[k]) !== JSON.stringify(d[k]));
                at(`décision ${d.id} modifiée (${fields.join(', ')}) : une décision fusionnée ne change que relue`);
            }
            continue;
        }
        if (d.supersedes.length)
            at(`décision ${d.id} ajoutée : elle en remplace d'autres (${d.supersedes.join(', ')}) : relue`);
        if (d.status === 'confirmed' && d.source !== 'operator')
            at(`décision ${d.id} ajoutée confirmée sans source opérateur`);
        if (d.source === 'operator') {
            if (!anchoredQuote(input.messages, d.sourceQuote, input.key))
                at(`décision ${d.id} ajoutée : sa citation n'est pas dans les messages de l'opérateur`);
            else {
                const spent = baseQuotes.get(quoteKey(d.sourceQuote));
                if (spent)
                    at(`décision ${d.id} ajoutée : sa citation est déjà celle de ${spent} (registre de la base)`);
            }
        }
        const mockup = mockupDecision(d);
        if (mockup) {
            const actual = mockup.file && mockup.sha256 ? blobHash(input.repo, input.head, mockup.file) : null;
            if (!mockup.file || !mockup.sha256 || actual !== mockup.sha256) {
                at(`décision ${d.id} : la maquette ${mockup.file ?? '(sans fichier)'} n'est pas à la tête avec l'empreinte enregistrée`, mockup.file ?? LEDGER_FILE);
            }
        }
    }
    return out;
}
/** The lane of a change (see above). Pure reading of the commits, the plan and the operator's journal. */
export async function docsOnlyLane(input) {
    const no = (reason, blocking = []) => ({ eligible: false, reason, files: [], blocking: blocking.slice(0, SHOWN) });
    if (!input.settings.enabled)
        return no('voie sans code désactivée par rules.docsOnly.enabled');
    if (!input.plan.files.length)
        return no('diff vide');
    const raw = rawFiles(input.repo, input.mergeBase, input.head);
    if (!raw)
        return no('diff illisible : règles normales');
    const blocking = [];
    const files = new Map();
    for (const f of raw) {
        const mode = modeChange(f);
        if (mode)
            blocking.push({ path: f.path, why: `${mode} (lien symbolique, sous-module ou exécutable)` });
    }
    const imports = importedInstructions(input.repo, [input.mergeBase, input.head]);
    for (const file of input.plan.files) {
        // Documentation as the plan reads it: neutral Markdown outside the served folders, without a word of data or GDPR.
        const documentation = file.risk === 'faible' && file.riskWhy === 'documentation';
        const sides = [{ path: file.path, deleted: file.status.startsWith('D') }, ...(file.from !== undefined ? [{ path: file.from, deleted: true }] : [])];
        for (const side of sides) {
            const k = kindOf(side.path, side.deleted, documentation, input, imports);
            if ('why' in k)
                blocking.push({ path: side.path, why: k.why });
            else if (!side.deleted || !files.has(side.path))
                files.set(side.path, k.kind);
        }
    }
    const touched = [...files].filter(([, k]) => k === 'mockups' || k === 'decisions');
    if (!blocking.length && touched.length) {
        let atHead;
        let atBase;
        try {
            atHead = await loadDecisionLedger(input.repo, input.head, LEDGER_FILE);
            atBase = await loadDecisionLedger(input.repo, input.mergeBase, LEDGER_FILE);
        }
        catch (error) {
            return no(`registre des décisions illisible ou invalide : ${errorMessage(error).slice(0, 200)}`, [{ path: LEDGER_FILE, why: 'registre illisible ou invalide' }]);
        }
        blocking.push(...ledgerBlocking(atBase.decisions, atHead.decisions, input));
        // The readable version is what the agents read: the exact rendering of the ledger at the head, or nothing.
        const text = gitShow(input.repo, input.head, LEDGER_TEXT);
        if (text && text.toString('utf8') !== decisionLedgerMarkdown(atHead)) {
            blocking.push({ path: LEDGER_TEXT, why: `différent du rendu de ${LEDGER_FILE} à la tête (apv ledger apply l'écrit) : le texte que lisent les agents contredirait le registre` });
        }
        for (const [path, kind] of touched) {
            if (kind !== 'mockups')
                continue;
            const decision = atHead.decisions.find(d => d.source === 'operator' && mockupDecision(d)?.file === path);
            const recorded = decision ? mockupDecision(decision).sha256 : null;
            if (!recorded) {
                blocking.push({ path, why: 'aucune décision de maquette validée (source opérateur) ne porte ce fichier et son empreinte' });
                continue;
            }
            const actual = blobHash(input.repo, input.head, path);
            if (actual !== recorded)
                blocking.push({ path, why: `empreinte ${actual ? actual.slice(0, 12) : 'illisible'} différente de celle de ${decision.id} (${recorded.slice(0, 12)}) : maquette modifiée sans nouvelle décision` });
        }
    }
    if (blocking.length) {
        const first = blocking[0];
        return no(`${blocking.length} fichier(s) hors de la voie, dont ${first.path} : ${first.why}`, blocking);
    }
    const list = [...files].map(([path, kind]) => ({ path, kind })).sort((a, b) => a.path.localeCompare(b.path));
    const tally = new Map();
    for (const f of list)
        tally.set(f.kind, (tally.get(f.kind) ?? 0) + 1);
    return { eligible: true, files: list, blocking: [],
        reason: `${list.length} fichier(s), aucun de code : ${[...tally].map(([k, n]) => `${KIND_LABEL[k]} (${n})`).join(', ')}` };
}
/**
 * The review plan in the lane without code: no domain is required by the diff, the security review included; only the
 * domains forced by the configuration (`review.always`) or by the operator (`--force`) stay. Outside the lane, the plan
 * is returned unchanged.
 */
export function planInLane(plan, lane, forced) {
    if (!lane.eligible)
        return { ...plan, lane };
    const domains = plan.domains.map(d => {
        const by = forced.operator.includes(d.domain) ? 'operator' : forced.always.includes(d.domain) ? 'config' : null;
        if (by)
            return { ...d, decision: 'retained', forced: by, reason: `${LANE_NAME}, mais forcée par ${by === 'operator' ? 'l\'opérateur (--force)' : 'la configuration (review.always)'}` };
        return { ...d, decision: 'skipped', forced: null, files: [], fileCount: 0, reason: `${LANE_NAME} : ${lane.reason} ; aucune relecture d'agent exigée (docs/REGLES.md)` };
    });
    return { ...plan, domains, lane,
        retained: domains.filter(d => d.decision === 'retained').map(d => d.domain),
        skipped: domains.filter(d => d.decision === 'skipped').map(d => ({ domain: d.domain, reason: d.reason })) };
}
/** Lines of a lane for the text reports (`apv rules check`, `apv stack plan`, `apv review plan`). */
export function laneLines(lane, indent = '') {
    if (!lane.eligible)
        return [`${indent}Voie sans code : non retenue (${lane.reason}) : règles normales.`];
    return [`${indent}Voie sans code : RETENUE : ${lane.reason}. Fichiers qui l'ont permise :`,
        ...lane.files.slice(0, 30).map(f => `${indent}    ${f.path} (${KIND_LABEL[f.kind]})`),
        ...(lane.files.length > 30 ? [`${indent}    (et ${lane.files.length - 30} autres)`] : [])];
}
//# sourceMappingURL=docs-only.js.map