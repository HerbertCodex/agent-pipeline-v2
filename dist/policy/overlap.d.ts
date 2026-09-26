/**
 * Whether two portable globs (the syntax of `allowedPaths`: `*`, `**`, `?`, everything else literal) can match
 * a common path. Exact: each glob is turned into the automaton of the regular expression `matches` builds, and
 * the product of the two automata is searched for a common accepted path. Used to decide whether a decision
 * scoped to some paths concerns a spec whose tasks may change other paths.
 */
export declare function globsOverlap(a: string, b: string): boolean;
