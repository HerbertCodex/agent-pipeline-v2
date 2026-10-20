/**
 * Detection of copied blocks: a token-based clone detector (exact copies, whitespace and comments ignored), the
 * method of jscpd (Rabin-Karp windows of `minTokens` tokens, extended to the longest common run), written in the tool
 * so that it runs without a dependency, without network, the same way on every stack, and on the files of any commit.
 */
export interface Token {
    id: number;
    line: number;
}
/**
 * Import and re-export statements blanked (lines kept): two pages that import the same components are not a copy.
 * ECMAScript (`import ... from '...'`, `import '...'`, `export ... from '...'`, multi-line included) and Python.
 */
export declare function blankImports(text: string, ext: string): string;
/** Interns token texts as integers shared by every file of one analysis (a copy has the same ids everywhere). */
export declare class TokenTable {
    private readonly ids;
    id(text: string): number;
}
/**
 * Tokens of a source file, language-agnostic: identifiers and numbers, strings (quoted strings end at the end of their
 * line, template strings may span lines), operators (`=>`, `===`), and every other character alone. Whitespace and comments are dropped:
 * `//` and `/* *\/` (except in CSS and HTML for `//`), `<!-- -->`, `#` for the languages that use it.
 */
export declare function tokenize(text: string, ext: string, table: TokenTable): Token[];
export interface Fragment {
    path: string;
    startLine: number;
    endLine: number;
    start: number;
    end: number;
}
/** Two copies of one block: `a` is the later file (or later place), `b` the earlier one it copies. */
export interface Clone {
    a: Fragment;
    b: Fragment;
    tokens: number;
    lines: number;
}
export interface DuplicateOptions {
    minTokens: number;
    minLines: number;
}
/**
 * Clones between files (and inside one file, never overlapping): for each place of each file, in path order, the
 * earliest identical window of `minTokens` tokens is extended as far as both copies stay equal; a clone is kept when
 * both copies span at least `minLines` lines. Each place belongs to one clone at most (a block copied three times
 * gives two clones, each with the first copy).
 */
export declare function findClones(files: ReadonlyMap<string, Token[]>, options: DuplicateOptions): Clone[];
/** True when `needle` occurs in `haystack` (twice, without overlap, when `twice`). */
export declare function occurs(haystack: Int32Array, needle: Int32Array, twice?: boolean): boolean;
