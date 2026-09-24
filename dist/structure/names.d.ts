/** Extensions of source code files; everything else (docs, data, assets, SQL) is left out of the analysis. */
export declare const CODE_EXTENSIONS: Set<string>;
export interface FileName {
    /** Repository-relative path, `/` separated. */
    path: string;
    dir: string;
    name: string;
    /** Name before its first dot (`cookie-notice` for `cookie-notice.svelte.ts`). */
    stem: string;
    /** Name parts between the stem and the extension (`['svelte']`, `['test']`). */
    infixes: string[];
    ext: string;
    test: boolean;
    /** Capitalized UI component (`QuickAddDialog.svelte`). */
    component: boolean;
    /** Framework or entry file (`+page.svelte`, `[id].ts`, `_app.tsx`, `index.ts`): counted, never grouped. */
    reserved: boolean;
    /** Lower-case words of the stem (`QuickAddDialog`: quick, add, dialog; `sign-in-origin`: sign, in, origin). */
    tokens: string[];
}
/** Lower-case words of a name: split on separators and on camelCase or PascalCase boundaries. */
export declare function tokenize(stem: string): string[];
/** A code file's name, parsed; null for anything that is not source code. */
export declare function parseName(path: string): FileName | null;
/** Singular of an English word by its regular endings (`applications`, `addresses`, `categories`). */
export declare function singular(word: string): string;
/**
 * Two words name the same thing: equal, singular and plural (`application`, `applications`), or a regular
 * participle (`schedule`, `scheduled`).
 */
export declare function related(a: string, b: string): boolean;
/** True when `prefix` words start `tokens`, the words compared with `related`. */
export declare function startsWith(tokens: readonly string[], prefix: readonly string[]): boolean;
/** Joins words in the style of `stem` (`events-repository`, `events_repository`, `eventsRepository`). */
export declare function joinLike(stem: string, words: readonly string[]): string;
/** A folder name for words: kebab-case, or snake_case when the files use it. */
export declare function folderName(words: readonly string[], sample: string): string;
