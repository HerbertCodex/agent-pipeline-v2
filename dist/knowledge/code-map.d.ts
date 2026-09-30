import { type Inventory } from './inventory.js';
import { type MapSettings, type ReuseSettings } from '../reuse/config.js';
import { type Clash } from '../reuse/names.js';
/**
 * The code map (`.apv/code-map.md`): what exists in the project, short enough for an agent to read before it creates a
 * component, a module or a route. Built from the working tree inventory (src/knowledge/inventory.ts), without a model,
 * deterministic (sorted by bytes, no commit id, no date) so that a stale map is a plain difference of text.
 */
export interface MapComponent {
    path: string;
    shared: boolean;
    summary: string | null;
    props: string[];
    variants: Record<string, string[]>;
    usedBy: string[];
    /** Shared components this one may double (name rule of `apv reuse check`), composition excepted. */
    clashes: Clash[];
}
export interface MapModule {
    path: string;
    feature: boolean;
    summary: string | null;
    exports: {
        name: string;
        kind: string;
    }[];
    usedBy: string[];
}
export interface MapRoute {
    route: string;
    files: string[];
}
export interface CodeMap {
    components: MapComponent[];
    modules: MapModule[];
    routes: MapRoute[];
    /** Files left out: tests, ignored paths, modules that export nothing and nobody imports. */
    skipped: {
        tests: number;
        ignored: number;
        silentModules: number;
    };
    /** Files of the repository beyond the inventory limit: the map describes the first ones only (null when complete). */
    partial: {
        described: number;
        total: number;
    } | null;
}
export interface RouteOf {
    route: string;
    root: string;
}
/**
 * The route a file serves, for the file-based routers: SvelteKit (`routes/**\/+page.svelte`), Remix (`app/routes/`),
 * Next.js app router (`app/**\/page.tsx`), and the `pages/` folders (Next.js, Nuxt, Astro). Groups `(name)` and
 * parallel slots `@name` are left out of the route. Null for any other file.
 */
export declare function routeOf(path: string): RouteOf | null;
/** Routes declared in code (Express, Fastify, Hono, Flask, FastAPI, Gin...): `GET /path` with the file and line. */
export declare function declaredRoutes(text: string): {
    route: string;
    line: number;
}[];
interface ImportRef {
    spec: string;
    names: string[];
}
/** Imports of a source file: ECMAScript (static, dynamic, `require`) and Python (`import`, `from ... import`). */
export declare function importsOf(text: string, ext: string): ImportRef[];
export declare const maskSecrets: (text: string) => string;
/** Role of a file in one line: its `@component` comment, else the first comment of its first 40 lines (tool directives left out). */
export declare function summaryOf(text: string, ext: string): string | null;
/** Props of a component: Svelte (`$props()`, `export let`), Vue (`defineProps`), Astro (`Astro.props`), React (parameters or `XxxProps`). */
export declare function propsOf(text: string, ext: string, stem: string): string[];
/** String literal unions of the props (`variant?: 'primary' | 'ghost'`), 8 values at most per prop. */
export declare function variantsOf(text: string, props: readonly string[]): Record<string, string[]>;
export interface BuildOptions {
    inventory?: Inventory;
    read?: (path: string) => string | null;
    /** Files tracked by Git: only they are summarised (an untracked file may hold what nobody decided to commit). */
    tracked?: Set<string>;
    maxFiles?: number;
}
/** Is this file a component (and not a route file)? Svelte, Vue and Astro files always; JSX files named in PascalCase. */
export declare function isComponentFile(path: string): boolean;
/**
 * Shared components `path` may double (rule in src/reuse/names.ts), composition excepted: a component that imports the
 * shared one, or is imported by it, builds on it. With `symmetric` false, two shared components are compared once
 * (the later path against the earlier), which is what the map prints.
 */
export declare function clashesFor(map: CodeMap, path: string, families: Readonly<Record<string, readonly string[]>>, symmetric?: boolean): Clash[];
export declare function buildCodeMap(repo: string, reuse: ReuseSettings, settings: MapSettings, options?: BuildOptions): Promise<CodeMap>;
/**
 * Entries each section may list, out of `total`: an equal share for every section, what a small section leaves going to
 * the larger ones, so that no section is starved by the ones printed before it.
 */
export declare function shares(sizes: readonly number[], total: number): number[];
/** The map as Markdown: sections by folder, bounded in entries (40 per folder, `maxEntries` shared between the sections) and in bytes (`maxBytes`), counts of what is left out. */
export declare function codeMapMarkdown(map: CodeMap, settings: Pick<MapSettings, 'maxEntries'> & {
    maxBytes?: number;
}): string;
export {};
