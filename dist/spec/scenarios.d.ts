import type { Issue } from '../domain/issues.js';
import type { Spec } from '../lifecycle/contracts.js';
import type { UserScenarioSettings } from '../config/load.js';
/** Id of a user scenario criterion: `AC-USER-<n>`. */
export declare const USER_SCENARIO_ID: RegExp;
/** What the project already knows of its interface: the `ui` paths of the reviews and the validated mockup folder. */
export interface InterfaceSignals {
    uiPaths: readonly string[];
    designDir: string;
}
/**
 * Why a spec touches an interface, or null: a declared UI impact, a task path in the `ui` class of the reviews (the
 * paths that keep the fidelity review), or a validated mockup cited by the spec. A task glob is matched as a path: a
 * components folder matches the default `ui` patterns, a bare routes folder does not (declare `experience.uiImpact` then).
 */
export declare function interfaceReason(spec: Spec, signals: InterfaceSignals): string | null;
/**
 * User scenario findings of a launch-ready spec that touches an interface (code SPEC_USER_SCENARIOS): fewer than
 * `minUserScenarios` criteria `AC-USER-<n>`, or a scenario not written « Étant donné … Quand … Alors … » (Given/When/Then),
 * or whose verification names no browser test. A spec with no interface gets none.
 */
export declare function userScenarioIssues(spec: Spec, settings: UserScenarioSettings, signals: InterfaceSignals): Issue[];
