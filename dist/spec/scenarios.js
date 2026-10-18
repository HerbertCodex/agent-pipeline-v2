import { matches } from '../policy/policy.js';
/** Id of a user scenario criterion: `AC-USER-<n>`. */
export const USER_SCENARIO_ID = /^AC-USER-\d+$/;
/** Upper bound of the rule validated by the operator (3 to 5 scenarios): beyond it, the main journeys are diluted. */
export const MAX_USER_SCENARIOS = 5;
const word = (alternatives) => `(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`;
/** « Étant donné … quand … alors … » or « Given … When … Then … », in this order, with an outcome after « alors ». */
const GIVEN_WHEN_THEN = new RegExp(`${word('étant données?|étant donnés?|etant donnee?s?|given')}[\\s\\S]+?${word('quand|lorsque|lorsqu|when')}[\\s\\S]+?${word('alors|then')}[\\s\\S]*[\\p{L}\\p{N}]`, 'iu');
/** A verification that replays the journey: a browser test, or the journey played by the target person before the merge. */
const REPLAYED_JOURNEY = /navigateur|browser|playwright|cypress|webdriver|puppeteer|e2e|end-to-end|bout en bout|parcours (?:re)?jou[ée]|jou[ée] par|played by/i;
/**
 * Why a spec touches an interface, or null: a declared UI impact; or, for a spec that declares no `experience` at
 * all, a task path in the `ui` class of the reviews (the paths that keep the fidelity review) or a validated mockup
 * cited by the spec. An explicit `uiImpact: "none"` is the author's word, with its rationale (pilot project: components
 * moved without a visible change, mockups named to be kept out of the diff); the fidelity review still follows the
 * paths. A task glob is matched as a path: a components folder matches the default `ui` patterns, a bare routes
 * folder does not.
 */
export function interfaceReason(spec, signals, experienceDeclared = true) {
    if (spec.experience.uiImpact !== 'none')
        return `experience.uiImpact vaut ${spec.experience.uiImpact}`;
    if (experienceDeclared)
        return null;
    for (const task of spec.tasks)
        for (const path of task.allowedPaths) {
            const pattern = signals.uiPaths.find(p => { try {
                return matches(path, p);
            }
            catch {
                return false;
            } });
            if (pattern)
                return `la tâche ${task.id} touche ${path}, chemin d'interface ${pattern}`;
        }
    const dir = `${signals.designDir.replace(/\/+$/, '')}/`;
    const texts = [spec.problem, ...spec.scope, ...spec.acceptance.flatMap(a => [a.description, a.verification]),
        ...spec.tasks.flatMap(t => [t.description, ...t.allowedPaths]), spec.experience.rationale, ...spec.experience.surfaces];
    if (texts.some(t => t.includes(dir)))
        return `la spec cite une maquette validée (${dir})`;
    return null;
}
const scenarioWord = (n) => `${n} scénario${n > 1 ? 's' : ''} utilisateur AC-USER-<n>`;
/**
 * User scenario findings of a launch-ready spec that touches an interface (code SPEC_USER_SCENARIOS): fewer than
 * `minUserScenarios` or more than five criteria `AC-USER-<n>`, a scenario not written « Étant donné … quand … alors … »
 * (Given/When/Then), or one whose verification names neither a browser test nor the journey played by the target
 * person. Each message says what to add. A spec with no interface gets none. `experienceDeclared`: whether the spec
 * document itself holds `experience` (otherwise the schema default « none » stands for it).
 */
export function userScenarioIssues(spec, settings, signals, experienceDeclared = true) {
    const reason = interfaceReason(spec, signals, experienceDeclared);
    if (!reason)
        return [];
    const issues = [];
    const scenarios = spec.acceptance.filter(a => USER_SCENARIO_ID.test(a.id));
    if (scenarios.length < settings.minUserScenarios) {
        issues.push({ code: 'SPEC_USER_SCENARIOS', message: `La spec touche une interface (${reason}) et compte ${scenarioWord(scenarios.length)} ` +
                `sur ${settings.minUserScenarios} attendus (spec.minUserScenarios) : ajoute en tête de acceptance de ${settings.minUserScenarios} à ${MAX_USER_SCENARIOS} ` +
                'critères AC-USER-1, AC-USER-2… écrits du point de vue de la personne cible, « Étant donné <sa situation>, quand <ce qu\'elle fait>, ' +
                'alors <ce qu\'elle voit> », un comportement chacun, sans nom de code ; rattache chacun à la tâche de l\'écran (acceptanceIds) et fais-le ' +
                'vérifier par un test navigateur prévu ou existant, ou par le parcours joué par la personne cible avant la fusion ; fusionne des critères ' +
                'techniques plutôt que d\'en ajouter.' });
    }
    if (scenarios.length > MAX_USER_SCENARIOS) {
        issues.push({ code: 'SPEC_USER_SCENARIOS', message: `La spec compte ${scenarioWord(scenarios.length)} : ${MAX_USER_SCENARIOS} au plus. ` +
                'Garde les parcours principaux de la personne cible et range les autres comportements dans des critères ordinaires.' });
    }
    for (const scenario of scenarios) {
        if (!GIVEN_WHEN_THEN.test(scenario.description)) {
            issues.push({ code: 'SPEC_USER_SCENARIOS', message: `${scenario.id} n'est pas écrit « Étant donné … quand … alors … » (ou Given … When … Then …) : ` +
                    'réécris-le avec la situation de la personne, ce qu\'elle fait, puis ce qu\'elle voit.' });
        }
        if (!REPLAYED_JOURNEY.test(scenario.verification)) {
            issues.push({ code: 'SPEC_USER_SCENARIOS', message: `${scenario.id} : la vérification ne nomme ni test navigateur ni parcours joué par la personne cible ` +
                    '(par exemple « test navigateur tests/e2e/<fichier> à 390 px », ou « parcours joué par l\'opérateur sur l\'aperçu avant la fusion »).' });
        }
    }
    return issues;
}
//# sourceMappingURL=scenarios.js.map