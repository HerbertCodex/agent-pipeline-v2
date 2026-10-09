/**
 * Class and id names hidden by the ad blockers (issue #124). Pilot project, 8 October 2026: an admin page whose classes
 * were `ad-page`, `ad-head`, `ad-bar`, `ad-grid` showed blank in production on the operator's computer, in two browsers:
 * an extension applied the generic hiding filters of EasyList to these names (`position: absolute` injected). Invisible
 * in the tests and in the captures of fidelity, which run without an extension; two hours of diagnosis.
 *
 * Refused names: those starting with `ad-`, `ads-`, `adv-`, `banner-ad` (then `-`, `s` or the end), `advert` or
 * `sponsor` (the prefixes of the generic filters). `add-on`, `advanced`, `adresse`, `badge` stay accepted. Read in the
 * `class`, `className` and `id` attributes (outside `{...}` expressions), the Svelte `class:` directives and the
 * selectors of the style sheets and of the `<style>` blocks; never in the text of a page, a script or a `data-*`.
 */
/** Files of interface where the names are read. */
export declare const ADBLOCK_FILES: RegExp;
/** A name the generic filters hide. */
export declare const ADBLOCK_NAME: RegExp;
export declare const ADBLOCK_MESSAGE = "masqu\u00E9 par les filtres anti-pub du poste de l'op\u00E9rateur (pr\u00E9fixes des filtres g\u00E9n\u00E9riques EasyList : ad-, ads-, adv-, advert, banner-ad, sponsor) ; le renommer (par exemple art-, item-)";
export interface AdBlockedName {
    line: number;
    kind: 'classe' | 'identifiant';
    name: string;
}
/** Every class and id name of a file of interface hidden by the generic ad filters, with its line, in order. */
export declare function adBlockedNames(text: string, path: string): AdBlockedName[];
