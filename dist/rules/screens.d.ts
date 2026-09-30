import type { Decision } from '../lifecycle/decisions.js';
import { type OperatorMessage } from './operator.js';
/**
 * Whether a file is a screen: a page, a layout or an error page of the routes the tool knows (SvelteKit `+page.svelte`,
 * Next `app/**\/page.tsx`, Remix `app/routes/*.tsx`, Nuxt, Astro, Vue `pages/**`), or a file of `rules.screens`. Server
 * code of a route (`+page.server.ts`, `+server.ts`, `pages/api/**`) is not a screen.
 */
export declare function isScreen(path: string, extra?: readonly RegExp[]): boolean;
export interface Mockup {
    id: string;
    screens: string[];
    paths: string[];
    sourceQuote: string;
}
/** The confirmed operator mockups of a ledger. */
export declare function mockupsOf(decisions: readonly Decision[]): Mockup[];
/** Whether a mockup covers a screen file: a path of its scope matches the file, or one of its screens names its route. */
export declare function covers(mockup: Mockup, path: string): boolean;
export interface ScreenCoverage {
    file: string;
    /** The mockup that covers it and why it counts (merged at the base, or validated by words the operator typed), or null. */
    mockup: {
        id: string;
        anchor: 'base' | 'operator';
    } | null;
    /** Mockups of the change that would cover it, whose validation is not found among the operator's messages. */
    unanchored: string[];
}
/**
 * For each screen the change adds or modifies, the validated mockup that covers it. A mockup counts when it is in the
 * ledger of the base (merged, so reviewed), or when the change brings it and its quote is found word for word among the
 * messages the operator typed (src/rules/operator.ts): a validation an agent wrote in the ledger alone never counts.
 */
export declare function screenCoverage(files: readonly string[], atBase: readonly Decision[], atHead: readonly Decision[], messages: readonly OperatorMessage[]): ScreenCoverage[];
export declare function screenMatchers(globs: readonly string[]): RegExp[];
