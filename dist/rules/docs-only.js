import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { errorMessage } from '../domain/errors.js';
import { RESERVED_GROUP } from '../design/config.js';
import { mockupDecision } from '../design/registry.js';
import { modeChange, parseRawDiff } from '../gates/proof-scope.js';
import { LEDGER_FILE, loadDecisionLedger } from '../lifecycle/decisions.js';
import { matches } from '../policy/policy.js';
import { AGENT_INSTRUCTIONS, CONFIG_FILES } from '../review/risk.js';
import { anchoredQuote } from './operator.js';
/** Name of the lane in the reports. */
export const LANE_NAME = 'voie sans code';
export const KIND_LABEL = {
    decisions: 'registre des décisions', mockups: 'maquette validée', drafts: 'brouillon de maquette', specs: 'spec',
    journal: 'journal du pipeline', state: 'fichier d\'état', docs: 'documentation',
};
const JOURNAL = '.apv/journal-pipeline.md';
const LEDGER_TEXT = '.apv/DECISIONS.md';
/** Files of `.apv/state/` that could be run: never state. */
const SCRIPT = /\.(?:sh|bash|zsh|fish|ps1|bat|cmd|js|mjs|cjs|ts|mts|cts|jsx|tsx|py|rb|pl|php|exe)$/i;
const SHOWN = 50;
const safe = (path, glob) => { try {
    return matches(path, glob);
}
catch {
    return false;
} };
const under = (path, dir) => path.startsWith(`${dir}/`);
function blobHash(repo, sha, path) {
    try {
        const data = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'cat-file', 'blob', `${sha}:${path}`], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
        return createHash('sha256').update(data).digest('hex');
    }
    catch {
        return null;
    }
}
function rawFiles(repo, base, head) {
    try {
        return parseRawDiff(execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-abbrev', '--ignore-submodules=none', base, head, '--'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }));
    }
    catch {
        return null;
    }
}
/** The kind of one side of a changed file, or why it keeps the normal rules. */
function kindOf(path, deleted, documentation, input) {
    const { settings } = input;
    if (settings.exclude.some(g => safe(path, g)))
        return { why: 'exclu par rules.docsOnly.exclude' };
    if (CONFIG_FILES.some(g => safe(path, g)))
        return { why: 'configuration (outil, tests, dépendances, CI)' };
    if (input.sensitive.some(g => safe(path, g)) || AGENT_INSTRUCTIONS.some(g => safe(path, g)))
        return { why: 'chemin sensible ou instructions des agents' };
    const drafts = `${input.designDir}/${RESERVED_GROUP}`;
    let kind = null;
    if (path === LEDGER_FILE || path === LEDGER_TEXT)
        kind = 'decisions';
    else if (path === JOURNAL)
        kind = 'journal';
    else if (under(path, '.apv/specs'))
        kind = 'specs';
    else if (under(path, '.apv/state')) {
        if (SCRIPT.test(path))
            return { why: 'script sous .apv/state (jamais un fichier d\'état)' };
        kind = 'state';
    }
    else if (under(path, drafts))
        kind = 'drafts';
    else if (under(path, input.designDir))
        kind = 'mockups';
    else if (documentation && path.endsWith('.md') && !under(path, '.apv'))
        kind = 'docs';
    if (!kind)
        return { why: 'hors de la liste de la voie sans code (code, interface, configuration ou fichier non classé)' };
    if (!settings.kinds.includes(kind))
        return { why: `${KIND_LABEL[kind]} : type retiré de la voie par rules.docsOnly.kinds` };
    if (deleted && (kind === 'decisions' || kind === 'mockups'))
        return { why: `${KIND_LABEL[kind]} supprimé(e)` };
    return { kind };
}
const sameDecision = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
    for (const file of input.plan.files) {
        // Documentation as the plan reads it: neutral Markdown outside the served folders, without a word of data or GDPR.
        const documentation = file.risk === 'faible' && file.riskWhy === 'documentation';
        const sides = [{ path: file.path, deleted: file.status.startsWith('D') }, ...(file.from !== undefined ? [{ path: file.from, deleted: true }] : [])];
        for (const side of sides) {
            const k = kindOf(side.path, side.deleted, documentation, input);
            if ('why' in k)
                blocking.push({ path: side.path, why: k.why });
            else if (!side.deleted || !files.has(side.path))
                files.set(side.path, k.kind);
        }
    }
    const touched = [...files].filter(([, k]) => k === 'mockups' || k === 'decisions');
    if (!blocking.length && touched.length) {
        // The ledger at the head and at the base: every mockup decision the change brings is anchored in the operator's words.
        let atHead;
        let atBase;
        try {
            atHead = (await loadDecisionLedger(input.repo, input.head, LEDGER_FILE)).decisions;
            atBase = (await loadDecisionLedger(input.repo, input.mergeBase, LEDGER_FILE)).decisions;
        }
        catch (error) {
            return no(`registre des décisions illisible ou invalide : ${errorMessage(error).slice(0, 200)}`, [{ path: LEDGER_FILE, why: 'registre illisible ou invalide' }]);
        }
        const baseById = new Map(atBase.map(d => [d.id, d]));
        for (const d of atHead) {
            if (!mockupDecision(d))
                continue;
            const before = baseById.get(d.id);
            if (before && sameDecision(before, d))
                continue;
            if (d.source !== 'operator') {
                blocking.push({ path: LEDGER_FILE, why: `décision de maquette ${d.id} ajoutée ou modifiée sans source opérateur` });
                continue;
            }
            if (!anchoredQuote(input.messages, d.sourceQuote, input.key)) {
                blocking.push({ path: LEDGER_FILE, why: `décision de maquette ${d.id} ajoutée ou modifiée : sa citation n'est pas dans les messages de l'opérateur` });
            }
        }
        for (const [path, kind] of touched) {
            if (kind !== 'mockups')
                continue;
            const decision = atHead.find(d => d.source === 'operator' && mockupDecision(d)?.file === path);
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