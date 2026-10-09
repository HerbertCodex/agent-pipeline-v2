import { PipelineError, errorMessage } from '../domain/errors.js';
import { loadConfigAtCommit } from '../config/load.js';
import { loadDbConfigAtCommit } from '../db/config.js';
import { designDir } from '../design/config.js';
import { applyBaseGates } from '../gates/base-gates.js';
import { verifyGates } from '../gates/verify.js';
import { planScope } from '../gates/proof-scope.js';
import { stageGates } from '../gates/run.js';
import { Git } from '../execution/git.js';
import { loadDecisionLedger } from '../lifecycle/decisions.js';
import { sensitivePaths } from '../policy/policy.js';
import { ALWAYS_REVIEWED, reviewPlanSettings } from '../review/config.js';
import { planReviews } from '../review/plan.js';
import { DEFAULT_REUSE_IGNORE, UI_EXTENSIONS, extensionOf, globMatcher } from '../reuse/config.js';
import { WEB_DEPENDENCIES } from '../reuse/detect.js';
import { gitRead, gitRoot, resolveCommit } from '../run/git-probe.js';
import { commonDir } from '../stacks/idle.js';
import { MERGE_RULES, RULE_TITLES, rulesSettings } from './config.js';
import { anchorKey, readOperatorMessages, waiverFor, waiverSentence } from './operator.js';
import { REQUIRED_WEB_GATES, missingRequiredGates } from './required.js';
import { DOMAIN_REVIEWERS, latestReviews } from './reviews.js';
import { LANE_NAME, docsOnlyLane, laneLines } from './docs-only.js';
import { isScreen, screenCoverage, screenMatchers } from './screens.js';
/** Whether the commit is a web interface: web dependencies in its package.json, or tracked interface files. */
export function isWebAt(repo, sha) {
    const pkg = gitRead(repo, ['show', `${sha}:package.json`]);
    if (pkg) {
        try {
            const value = JSON.parse(pkg);
            const deps = Object.keys({ ...(value['dependencies'] ?? {}), ...(value['devDependencies'] ?? {}) });
            if (deps.some(d => WEB_DEPENDENCIES.test(d)))
                return true;
        }
        catch { /* not JSON: the files decide */ }
    }
    const ignored = globMatcher([...DEFAULT_REUSE_IGNORE]);
    const files = gitRead(repo, ['ls-tree', '-r', '-z', '--name-only', sha])?.split('\0').filter(Boolean) ?? [];
    return files.some(f => !ignored(f) && UI_EXTENSIONS.has(extensionOf(f)));
}
/** Pages written in Markdown (mdsvex, MDX) under the routes or the pages of a project: screens the tool reads as files. */
const ROUTE_CONTENT = /(^|\/)(routes|pages)\/.*\.(md|svx|mdx)$/;
/**
 * Whether a file is, or brings, a screen: a screen of the routes or of rules.screens, a page in Markdown under the
 * routes, or an interface file of the web detection (UI_EXTENSIONS: an HTML page, a component, a server template).
 */
function screenLike(path, screens) {
    return isScreen(path, screens) || ROUTE_CONTENT.test(path) || UI_EXTENSIONS.has(extensionOf(path));
}
/** Whether the project has screens at `sha`: a web project (isWebAt), or a file the tool reads as a screen. */
function hasScreensAt(repo, sha, screens) {
    if (isWebAt(repo, sha))
        return true;
    const ignored = globMatcher([...DEFAULT_REUSE_IGNORE]);
    const files = gitRead(repo, ['ls-tree', '-r', '-z', '--name-only', sha])?.split('\0').filter(Boolean) ?? [];
    return files.some(f => !ignored(f) && screenLike(f, screens));
}
/** Files the change adds or modifies since the base (renames counted as an addition: a moved screen is a new address). */
function changedFiles(repo, base, head) {
    const raw = gitRead(repo, ['diff', '--name-status', '-z', '--no-renames', base, head]);
    if (raw === null)
        throw new PipelineError('RULES', `diff illisible entre ${base.slice(0, 12)} et ${head.slice(0, 12)}`);
    const parts = raw.split('\0').filter(Boolean);
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2)
        if (/^[AMT]/.test(parts[i]))
            out.push(parts[i + 1]);
    return out;
}
const short = (sha) => sha.slice(0, 12);
function outcome(rule, status, detail, problems = [], todo = []) {
    return { rule, title: RULE_TITLES[rule], status, detail, problems, todo, waiver: null };
}
/**
 * The rules checked before any merge (docs/REGLES.md). Each one says what it checked, why it refuses and what to do. A
 * refusal is lifted by the correction it asks for, or by the operator himself: « dérogation <règle> <commit> : <raison> »
 * typed in the session (operator journal); no option of the tool lifts it.
 */
export async function checkMergeRules(input) {
    const repo = gitRoot(input.repo);
    const common = commonDir(repo);
    const sha = resolveCommit(repo, input.commit);
    if (!sha)
        throw new PipelineError('RULES', `Commit ${input.commit} absent de ce dépôt : récupérez la branche (git fetch origin <branche>) puis relancez.`);
    const skip = new Set(input.skip ?? []);
    const candidate = loadConfigAtCommit(repo, sha).config;
    const applied = applyBaseGates(repo, candidate, sha, input.target, input.remote ?? { strict: true });
    const base = applied.base;
    const effective = applied.config;
    const mergeBase = base.mergeBase;
    if (!mergeBase)
        throw new PipelineError('RULES', `Aucune base commune entre ${input.target} et ${short(sha)}.`);
    // What the rules read comes from the base: a change never sets its own rules.
    const atBase = loadConfigAtCommit(repo, mergeBase).config;
    const settings = rulesSettings(atBase.rules, REQUIRED_WEB_GATES);
    const anchor = anchorKey(common);
    const messages = readOperatorMessages(common, anchor.key);
    const rules = [];
    // The plan of the reviews, and the lane without code (docs/REGLES.md): both read at the base, from the diff since it.
    // The migrations as the base declares them, and as the change declares them: a change that moves db.migrations
    // never takes its migrations out of the data review (both sets of paths count, never the working tree).
    const migrations = [...new Set([...loadDbConfigAtCommit(repo, mergeBase).config.migrations, ...loadDbConfigAtCommit(repo, sha).config.migrations])];
    const reviewSettings = reviewPlanSettings(atBase.review);
    const sensitive = [...sensitivePaths, ...atBase.risk.highPaths];
    const baseDesign = designDir(atBase.design);
    const plan = planReviews({ repo, base: mergeBase, head: sha, settings: reviewSettings, migrations, designDir: baseDesign, sensitive, force: [] });
    const lane = await docsOnlyLane({ repo, mergeBase, head: sha, plan, settings: settings.docsOnly, designDir: baseDesign, sensitive, messages, key: anchor.key });
    // In the lane, only the domains the configuration forces (review.always) are required.
    const retained = lane.eligible ? plan.retained.filter(d => reviewSettings.always.includes(d)) : plan.retained;
    // preuve, instable: the full suite at this exact commit, with the checks of the base kept. In the lane without code,
    // when every check of the full suite declares skipWhenOnly and none is required by its scope (recomputed here from the
    // commit, the base and the reference, as apv gates verify does), there is nothing to prove: no receipt is asked for.
    let unscoped = null;
    if (lane.eligible && (!skip.has('preuve') || !skip.has('instable'))) {
        try {
            const full = stageGates(effective.gates, 'full').run;
            if (full.length && full.every(g => g.skipWhenOnly)) {
                const decisions = await planScope(new Git(), repo, effective, { base: mergeBase, head: sha });
                if (full.every(g => decisions.get(g.id)?.required === false))
                    unscoped = full.map(g => g.id).join(', ');
            }
        }
        catch {
            unscoped = null;
        }
    }
    let proof = null;
    let proofError = null;
    if (!unscoped && (!skip.has('preuve') || !skip.has('instable'))) {
        try {
            proof = await verifyGates({ repo, config: effective, commit: sha, stage: 'full', configFile: null });
        }
        catch (error) {
            proofError = errorMessage(error);
        }
    }
    const proveTodo = [
        `Dans une copie à ${short(sha)} : apv gates run --stage full --base ${input.target}`,
        `puis apv gates verify --commit ${short(sha)} --against ${input.target} doit sortir en 0.`,
    ];
    if (skip.has('preuve'))
        rules.push(outcome('preuve', 'not_applicable', 'prouvée par le lot (une suite complète sur la tête du lot)'));
    else if (unscoped)
        rules.push(outcome('preuve', 'not_applicable', `${LANE_NAME} : aucun contrôle ne s'applique, chacun non requis par sa portée (skipWhenOnly, recalculée depuis le commit) : ${unscoped}`));
    else if (proofError)
        rules.push(outcome('preuve', 'refused', 'suite complète au commit exact', [proofError], proveTodo));
    else if (proof.ok)
        rules.push(outcome('preuve', 'ok', `${proof.required.length} contrôle(s) prouvé(s) à ${short(sha)}, contrôles de la base compris`));
    else {
        const missing = proof.gates.filter(g => g.state !== 'passed').map(g => `${g.gateId} (${g.state})`);
        rules.push(outcome('preuve', 'refused', 'suite complète au commit exact', [`contrôle(s) non prouvé(s) à ${short(sha)} : ${missing.join(', ')}`], proveTodo));
    }
    if (skip.has('instable'))
        rules.push(outcome('instable', 'not_applicable', 'jugée sur la suite du lot'));
    else if (unscoped)
        rules.push(outcome('instable', 'not_applicable', `${LANE_NAME} : aucun contrôle à lancer`));
    else if (!proof)
        rules.push(outcome('instable', 'refused', 'contrôles réussis au premier passage', ['preuve illisible : rien ne montre que les contrôles ont réussi sans relance'], proveTodo));
    else if (proof.flaky.length) {
        rules.push(outcome('instable', 'refused', 'contrôles réussis au premier passage', [`réussi(s) seulement après relance : ${proof.flaky.join(', ')}`], [
            'Examine chaque test instable comme un bug possible du produit (course, attente d\'un fait non observé, données partagées entre tests), pas seulement du test.',
            'Corrige la cause, pousse, puis relance la suite complète sur le nouveau commit : aucune fusion sur un vert obtenu par relance.',
        ]));
    }
    else
        rules.push(outcome('instable', 'ok', 'aucun contrôle réussi seulement après relance'));
    // relecture, captures: the domains `apv review plan` retains for the change, each recorded at this commit, or waived
    // for that domain alone by the operator (« dérogation relecture:<domaine> <commit> : <raison> », issue #126).
    const reviews = latestReviews(common, sha);
    const reviewProblems = [];
    const reviewTodo = [];
    const domainStates = [];
    for (const domain of retained) {
        const agent = `apv:${DOMAIN_REVIEWERS[domain]}`;
        const found = reviews.get(domain);
        const ask = `Relecture ${domain} par ${agent} sur une copie détachée à ${short(sha)} ; l'agent l'enregistre lui-même (apv review record --commit ${short(sha)} --domain ${domain} ...).`;
        const f = found?.record?.findings;
        const problem = !found ? `aucune relecture enregistrée à ${short(sha)}`
            : found.problem || !found.record ? `relecture inutilisable (${found.problem ?? 'illisible'})`
                : f.critical > 0 || f.high > 0 ? `${f.critical} constat(s) critique(s) et ${f.high} haut(s) à ${short(sha)}` : null;
        if (!problem) {
            domainStates.push({ domain, status: 'recorded', detail: `${found.record.reviewer}, critique 0, haut 0, moyen ${f.medium}, bas ${f.low}`, waiver: null });
            continue;
        }
        const waiver = waiverFor(messages, `relecture:${domain}`, sha);
        if (waiver) {
            domainStates.push({ domain, status: 'waived', detail: problem, waiver: { at: waiver.message.at, reason: waiver.reason } });
            continue;
        }
        domainStates.push({ domain, status: 'missing', detail: problem, waiver: null });
        reviewProblems.push(`${domain} : ${problem}`);
        reviewTodo.push(found && !found.problem && found.record ? `Corrige chaque constat critique ou haut de la relecture ${domain}, avec le test qui le prouve, puis fais relire le nouveau commit (${agent}).` : ask);
        reviewTodo.push(`Ou, pour ce domaine seul, l'opérateur tape lui-même : « ${waiverSentence(`relecture:${domain}`, sha)} »${domain === ALWAYS_REVIEWED ? ' (dérogation sur la sécurité)' : ''}.`);
    }
    const forcedNote = lane.eligible ? ` (${LANE_NAME}, domaines forcés par review.always)` : '';
    const waivedDomains = domainStates.filter(d => d.status === 'waived');
    if (lane.eligible && !retained.length)
        rules.push(outcome('relecture', 'not_applicable', `${LANE_NAME} : ${lane.reason} ; aucune relecture d'agent exigée`));
    else if (reviewProblems.length)
        rules.push(outcome('relecture', 'refused', `relectures demandées par le diff${forcedNote} : ${retained.join(', ')}`, reviewProblems, reviewTodo));
    else if (waivedDomains.length) {
        const r = outcome('relecture', 'waived', `relectures enregistrées ou levées domaine par domaine par l'opérateur à ${short(sha)}${forcedNote} : ${retained.join(', ')}`
            + `${waivedDomains.some(d => d.domain === ALWAYS_REVIEWED) ? ' ; dérogation sur la sécurité' : ''}`);
        const latest = waivedDomains.map(d => d.waiver.at).sort().at(-1);
        r.waiver = { at: latest, reason: waivedDomains.map(d => `${d.domain} : ${d.waiver.reason}`).join(' ; ') };
        rules.push(r);
    }
    else
        rules.push(outcome('relecture', 'ok', `relectures enregistrées à ${short(sha)} sans constat critique ni haut${forcedNote} : ${retained.join(', ')} (risque ${plan.risk.level === 'faible' ? 'faible' : 'élevé'} : ${plan.risk.reason.slice(0, 200)})`));
    rules.at(-1).domains = domainStates;
    // captures: in a project with screens at the base, required as soon as the plan retains fidelite (a component, a
    // style, a message shown, a configuration of the styles change what a screen shows). Not applicable only to a project
    // without screens at the base (not a web project, no route the tool knows, nothing in rules.screens, no interface
    // file) that adds none: a command-line tool has nothing to capture, a first page or template added asks for them.
    const screenMatch = screenMatchers(settings.screens);
    const changed = changedFiles(repo, mergeBase, sha);
    const screens = changed.filter(f => isScreen(f, screenMatch));
    const addedScreens = changed.filter(f => screenLike(f, screenMatch));
    if (!addedScreens.length && !hasScreensAt(repo, mergeBase, screenMatch))
        rules.push(outcome('captures', 'not_applicable', 'projet sans écran à la base (pas un projet web, aucune route reconnue ni rules.screens, aucun fichier d\'interface) et aucun écran ajouté : rien à capturer'));
    else if (lane.eligible && !retained.includes('fidelite'))
        rules.push(outcome('captures', 'not_applicable', `${LANE_NAME} : aucun écran ni fichier d'interface, relecture de fidélité non exigée`));
    else if (!retained.includes('fidelite'))
        rules.push(outcome('captures', 'not_applicable', 'relecture de fidélité non retenue par le plan des revues'));
    else {
        const record = reviews.get('fidelite')?.record ?? null;
        const needed = settings.captures.viewports.flatMap(v => settings.captures.themes.map(t => `${v}:${t}`));
        const have = new Set((reviews.get('fidelite')?.problem ? [] : record?.captures ?? []).map(c => `${c.viewport}:${c.theme}`));
        const missing = needed.filter(n => !have.has(n));
        rules.push(missing.length
            ? outcome('captures', 'refused', `relecture de fidélité retenue${addedScreens.length ? ` (écran(s) ou fichier(s) d'interface : ${addedScreens.slice(0, 5).join(', ')}${addedScreens.length > 5 ? ', ...' : ''})` : ''}, captures attendues : ${needed.join(', ')}`, [`capture(s) absente(s) de la relecture fidelite à ${short(sha)} : ${missing.join(', ')}`], [
                `apv:qa-fidelite capture chaque écran changé ou qui utilise un fichier changé (${missing.join(', ')}), les regarde à côté de la maquette validée et les joint à sa relecture : apv review record --commit ${short(sha)} --domain fidelite --capture <largeur>:<thème>:<fichier> ...`,
            ])
            : outcome('captures', 'ok', `captures jointes à ${short(sha)} : ${needed.join(', ')}`));
    }
    // controles: the base checks of a web project, in the configuration the proof uses (the base's, kept, and the change's).
    const required = isWebAt(repo, sha) ? settings.requiredGates : settings.requiredGates.filter(g => g.source === 'config');
    const missingGates = missingRequiredGates(effective, required);
    if (!required.length)
        rules.push(outcome('controles', 'not_applicable', 'projet sans interface web et sans contrôle requis par rules.requiredGates'));
    else if (missingGates.length) {
        rules.push(outcome('controles', 'refused', `contrôles requis : ${required.map(g => g.id).join(', ')}`, missingGates.map(m => `${m.id} (${m.command.join(' ')}) ${m.problem === 'absent' ? 'absent de .apv/config.json' : 'déclaré sans "mandatory": true'}`), [
            'Ajoute ces contrôles à .apv/config.json, obligatoires ("mandatory": true) : apv onboard --dry-run les propose ; exemple : {"id": "structure", "command": ["apv", "structure", "check"], "stage": "task", "mandatory": true}.',
            'Commite, relance la suite complète : la PR qui les ajoute se prouve avec eux.',
        ]));
    }
    else
        rules.push(outcome('controles', 'ok', `contrôles requis présents et obligatoires : ${required.map(g => g.id).join(', ')}`));
    // maquette: every screen added or changed is covered by a mockup the operator validated.
    if (!screens.length)
        rules.push(outcome('maquette', 'not_applicable', 'aucun écran ajouté ni modifié'));
    else {
        const coverage = screenCoverage(screens, (await loadDecisionLedger(repo, mergeBase)).decisions, (await loadDecisionLedger(repo, sha)).decisions, messages);
        const uncovered = coverage.filter(c => !c.mockup);
        rules.push(uncovered.length
            ? outcome('maquette', 'refused', `${screens.length} écran(s) ajouté(s) ou modifié(s)`, uncovered.map(c => c.unanchored.length
                ? `${c.file} : maquette(s) ${c.unanchored.join(', ')} de la PR, dont la validation n'est pas dans les messages de l'opérateur`
                : `${c.file} : aucune maquette validée ne le couvre (portée ou écrans de la décision)`), [
                'Fais valider la maquette de cet écran par l\'opérateur (/apv:design), puis verse-la : apv design register <fichier.html> --name <nom> --quote "<ses mots exacts>" --scope <chemin de l\'écran>.',
                'Elle compte quand ses mots exacts sont dans ses messages de la session (tapés par lui), ou quand elle est déjà sur la branche cible.',
            ])
            : outcome('maquette', 'ok', `écrans couverts : ${coverage.map(c => `${c.file} (${c.mockup.id}${c.mockup.anchor === 'operator' ? ', validée dans la session' : ''})`).join(', ')}`));
    }
    // The only way past a refusal without its correction: the operator's own words.
    for (const r of rules) {
        if (r.status !== 'refused')
            continue;
        const waiver = waiverFor(messages, r.rule, sha);
        if (waiver) {
            r.status = 'waived';
            r.waiver = { at: waiver.message.at, reason: waiver.reason };
        }
        else
            r.todo.push(`Sans correction, seul l'opérateur peut lever ce refus, en tapant lui-même dans la session : « ${waiverSentence(r.rule, sha)} ».`);
    }
    const order = new Map(MERGE_RULES.map((r, i) => [r, i]));
    rules.sort((a, b) => order.get(a.rule) - order.get(b.rule));
    return { commit: sha, target: input.target, mergeBase, ok: rules.every(r => r.status !== 'refused'), rules, lane, warnings: [...base.warnings, ...(anchor.problem ? [anchor.problem] : [])] };
}
/** Lines of a report, for the text output of `apv rules check` and of the stack commands. */
export function rulesLines(report, indent = '') {
    const label = { ok: 'ok', refused: 'REFUSÉ', waived: 'DÉROGATION', not_applicable: 'sans objet' };
    const lines = [`${indent}Règles avant fusion à ${short(report.commit)} (cible ${report.target}, base commune ${report.mergeBase ? short(report.mergeBase) : '?'}) :`,
        ...laneLines(report.lane, indent)];
    for (const r of report.rules) {
        lines.push(`${indent}- ${r.rule} (${r.title}) : ${label[r.status]} : ${r.detail}`);
        for (const d of r.domains ?? []) {
            const said = d.status === 'recorded' ? `relecture enregistrée (${d.detail})`
                : d.status === 'waived' ? `${d.domain === ALWAYS_REVIEWED ? 'dérogation sur la sécurité' : 'dérogation'} (${d.waiver.reason}) ; ${d.detail}`
                    : `manquante : ${d.detail}`;
            lines.push(`${indent}    ${d.domain} : ${said}`);
        }
        // The domains already say the problems of the rule relecture.
        if (!r.domains?.length)
            for (const p of r.problems)
                lines.push(`${indent}    ${p}`);
        if (r.waiver)
            lines.push(`${indent}    dérogation de l'opérateur (${r.waiver.at}) : ${r.waiver.reason}`);
        if (r.status === 'refused')
            for (const t of r.todo)
                lines.push(`${indent}    à faire : ${t}`);
    }
    for (const w of report.warnings)
        lines.push(`${indent}Attention : ${w}`);
    lines.push(`${indent}${report.ok ? 'Règles respectées.' : 'Fusion refusée : corriger ce qui est REFUSÉ, puis relancer.'}`);
    return lines;
}
//# sourceMappingURL=check.js.map