/** Infrastructure mentions are not changes: retain affirmative clauses and direct paths separately. */
export declare function changeLanguage(text: string): string;
/** Only explicit task paths can assert infrastructure changes, never a repository search result. */
export declare function pathsMentioned(request: string, tracked: string[]): string[];
/** Exclude explicit non-change instructions, never negative security obligations
 * such as "do not bypass authentication" or "never leak passwords". Paths are
 * classified separately from prose so an auth directory is not a login request.
 */
export declare function securityScopeText(text: string): string;
