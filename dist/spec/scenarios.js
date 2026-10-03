import { matches } from '../policy/policy.js';
/** Id of a user scenario criterion: `AC-USER-<n>`. */
export const USER_SCENARIO_ID = /^AC-USER-\d+$/;
const word = (alternatives) => `(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`;
/** « Étant donné … Quand … Alors … » or « Given … When … Then … », in this order. */
const GIVEN_WHEN_THEN = new RegExp(`${word('étant données?|étant donnés?|etant donnee?s?|given')}[\\s\\S]+?${word('quand|lorsque|when')}[\\s\\S]+?${word('alors|then')}[\\s\\S]*\\S`, 'iu');
/** A verification that names a browser test replaying the journey. */
const BROWSER_TEST = /navigateur|browser|playwright|cypress|webdriver|puppeteer|e2e|end-to-end|bout en bout/i;
/**
 * Why a spec touches an interface, or null: a declared UI impact, a task path in the `ui` class of the reviews (the
 * paths that keep the fidelity review), or a validated mockup cited by the spec. A task glob is matched as a path: a
 * components folder matches the default `ui` patterns, a bare routes folder does not (declare `experience.uiImpact` then).
 */
export function interfaceReason(spec, signals) {
    if (spec.experience.uiImpact !== 'none')
        return `experience.uiImpact vaut ${spec.experience.uiImpact}`;
    for (const task of spec.tasks)
        for (const path of task.allowedPaths) {
            const pattern = signals.uiPaths.find(p => { try {
                return matches(path, p);
            }
            catch {
                return false;
            } });
            if (pattern)
                return `la tâche ${task.id} touche ${path} (chemin d'interface ${pattern})`;
        }
    const dir = `${signals.designDir.replace(/\/+$/, '')}/`;
    const texts = [spec.problem, ...spec.scope, ...spec.acceptance.flatMap(a => [a.description, a.verification]),
        ...spec.tasks.flatMap(t => [t.description, ...t.allowedPaths]), spec.experience.rationale, ...spec.experience.surfaces];
    if (texts.some(t => t.includes(dir)))
        return `la spec cite une maquette validée (${dir})`;
    return null;
}
/**
 * User scenario findings of a launch-ready spec that touches an interface (code SPEC_USER_SCENARIOS): fewer than
 * `minUserScenarios` criteria `AC-USER-<n>`, or a scenario not written « Étant donné … Quand … Alors … » (Given/When/Then),
 * or whose verification names no browser test. A spec with no interface gets none.
 */
export function userScenarioIssues(spec, settings, signals) {
    const reason = interfaceReason(spec, signals);
    if (!reason)
        return [];
    const issues = [];
    const scenarios = spec.acceptance.filter(a => USER_SCENARIO_ID.test(a.id));
    if (scenarios.length < settings.minUserScenarios) {
        issues.push({ code: 'SPEC_USER_SCENARIOS', message: `La spec touche une interface (${reason}) et compte ${scenarios.length} scénario(s) utilisateur ` +
                `AC-USER-<n> (seuil spec.minUserScenarios : ${settings.minUserScenarios}) : écris en tête des critères 3 à 5 scénarios du point de vue ` +
                'de la personne cible (« Étant donné … Quand … Alors … », un comportement chacun), vérifiés par un test navigateur qui rejoue le parcours ; ' +
                'fusionne des critères techniques plutôt que d\'en ajouter.' });
    }
    for (const scenario of scenarios) {
        if (!GIVEN_WHEN_THEN.test(scenario.description)) {
            issues.push({ code: 'SPEC_USER_SCENARIOS', message: `${scenario.id} n'est pas écrit « Étant donné … Quand … Alors … » (ou Given … When … Then …) : ` +
                    'la situation de la personne, ce qu\'elle fait, ce qu\'elle voit.' });
        }
        if (!BROWSER_TEST.test(scenario.verification)) {
            issues.push({ code: 'SPEC_USER_SCENARIOS', message: `${scenario.id} : la vérification ne nomme aucun test navigateur qui rejoue le parcours ` +
                    '(un test prévu ou existant, par exemple « test navigateur e2e/<fichier> à 390 px »).' });
        }
    }
    return issues;
}
//# sourceMappingURL=scenarios.js.map