import type { Issue } from '../domain/issues.js';
import type { Spec } from '../lifecycle/contracts.js';
import type { UserScenarioSettings } from '../config/load.js';
/** Id of a user scenario criterion: `AC-USER-<n>`. */
export declare const USER_SCENARIO_ID: RegExp;
/** Upper bound of the rule validated by the operator (3 to 5 scenarios): beyond it, the main journeys are diluted. */
export declare const MAX_USER_SCENARIOS = 5;
/** What the project already knows of its interface: the `ui` paths of the reviews and the validated mockup folder. */
export interface InterfaceSignals {
    uiPaths: readonly string[];
    designDir: string;
}
/**
 * Why a spec touches an interface, or null: a declared UI impact; or, for a spec that declares no `experience` at
 * all, a task path in the `ui` class of the reviews (the paths that keep the fidelity review) or a validated mockup
 * cited by the spec. An explicit `uiImpact: "none"` is the author's word, with its rationale (pilot project: components
 * moved without a visible change, mockups named to be kept out of the diff); the fidelity review still follows the
 * paths. A task glob is matched as a path: a components folder matches the default `ui` patterns, a bare routes
 * folder does not.
 */
export declare function interfaceReason(spec: Spec, signals: InterfaceSignals, experienceDeclared?: boolean): string | null;
/**
 * User scenario findings of a launch-ready spec that touches an interface (code SPEC_USER_SCENARIOS): fewer than
 * `minUserScenarios` or more than five criteria `AC-USER-<n>`, a scenario not written « Étant donné … quand … alors … »
 * (Given/When/Then), or one whose verification names neither a browser test nor the journey played by the target
 * person. Each message says what to add. A spec with no interface gets none. `experienceDeclared`: whether the spec
 * document itself holds `experience` (otherwise the schema default « none » stands for it).
 */
export declare function userScenarioIssues(spec: Spec, settings: UserScenarioSettings, signals: InterfaceSignals, experienceDeclared?: boolean): Issue[];
