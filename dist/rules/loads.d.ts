/**
 * Loads by a computed path in a file of the application (second security review of #141, M2): what such a load reaches
 * cannot be read from the text. Counted:
 * - `import.meta.glob`;
 * - `import`, `require` followed (spaces, line breaks, comments allowed, `?.` too) by a parenthesis whose argument is
 *   not one closed string literal (a concatenation, a template with `${`, a variable, a literal left open);
 * - `readFile`, `readFileSync`, `createReadStream`, with the same reading of their first argument (`read`).
 * No bound before the name in a script (a wrapper `_import(`, `$import(`, `myrequire(` may load a module, review of #141,
 * A9); a word bound in a SQL file (`confirm_application_import(` of the pilot project, #262, is a SQL function), where a
 * JavaScript `import(` still counts. In a script (`.js`, `.ts` and their variants) the comments are removed first, by two
 * readings (regular expressions literals recognized, or not) whose findings add up; a reading that ends inside a comment,
 * a string or a template does not remove them. Every other file (components, pages, Markdown, SQL...) is read as it is,
 * its comments counted: in doubt, a load.
 */
export type LoadKind = 'load' | 'read';
/**
 * The text of a script without its comments (a block comment becomes a space, a line comment nothing, line breaks kept);
 * null when the reading ends inside a comment, a template or an expression of a template: the text is then not trusted.
 * A quoted string ends at its line break (JavaScript allows none): a quote misread spoils one line at most.
 */
export declare function withoutComments(text: string, regexAware: boolean): string | null;
/** The kinds of computed loads in the file `path` whose content is `text` (none: an empty set). */
export declare function computedLoads(path: string, text: string): Set<LoadKind>;
