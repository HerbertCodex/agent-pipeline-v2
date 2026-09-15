import { inventoryForAgents, type Inventory } from './inventory.js';
import type { LanguageProfile } from './languages.js';
export interface RepositorySymbol {
    name: string;
    kind: string;
    path: string;
    line: number;
    excerpt: string;
    score: number;
}
export interface RepositoryIntelligence {
    sha: string;
    fileCount: number;
    manifests: string[];
    architectureFiles: string[];
    securityFiles: string[];
    relevantFiles: string[];
    reuseCandidates: RepositorySymbol[];
    inventory: ReturnType<typeof inventoryForAgents>;
    note: string;
}
export interface RepositoryOptions {
    languages?: readonly LanguageProfile[];
    signal?: AbortSignal;
    inventory?: Inventory;
}
/** Bounded, deterministic repository awareness keyed to an immutable Git SHA.
 * The inventory lists the whole public surface; reuse candidates are only a lexical ranking of it. */
export declare function inspectRepository(repo: string, sha: string, query: string, options?: RepositoryOptions): Promise<RepositoryIntelligence>;
